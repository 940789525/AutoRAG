import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it } from "vitest";
import { DocumentChannel } from "../../src/indexing/channel.ts";
import { chunkMarkdown } from "../../src/indexing/chunker.ts";
import { normalizeLocalIndex } from "../../src/indexing/config.ts";
import { IndexJournal } from "../../src/indexing/journal.ts";
import { extractKiwiModelFiles, KIWI_MODEL_FILES } from "../../src/indexing/kiwi-model.ts";
import { acquireIndexLease } from "../../src/indexing/lease.ts";
import { createLexicalAnalyzer } from "../../src/indexing/lexical.ts";
import { LocalDocumentIndex } from "../../src/indexing/pipeline.ts";
import type {
	IndexDocument,
	IndexEvent,
	IndexHit,
	IndexRow,
	IndexStore,
	LocalIndexOptions,
	TokenCounter,
} from "../../src/indexing/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tokens: TokenCounter = { fingerprint: "unicode-test-tokenizer", count: (text) => Array.from(text).length };
const analyzer = { fingerprint: "test-v1", analyze: async (text: string) => text.toLowerCase() };
function temporary(): string {
	const root = mkdtempSync(join(tmpdir(), "autorag-native-index-"));
	roots.push(root);
	return root;
}
async function* input(documents: readonly IndexDocument[]) {
	yield* documents;
}
function document(root: string, name: string, text: string, updatedAt = "1"): IndexDocument {
	const path = join(root, name);
	writeFileSync(path, text);
	return { virtualPath: `/docs/${name}`, sourcePath: path, outputPath: path, updatedAt };
}

class MemoryStore implements IndexStore {
	readonly rows = new Map<string, IndexRow>();
	maintained = 0;
	replacements = 0;
	failWrite = false;
	async countRows() {
		return this.rows.size;
	}
	async findVectors(keys: readonly string[]) {
		return new Map(
			[...this.rows.values()]
				.filter((row) => keys.includes(row.embedding_key))
				.map((row) => [row.embedding_key, row.vector]),
		);
	}
	async replace(ids: readonly string[], rows: readonly IndexRow[]) {
		if (this.failWrite) throw new Error("disk full: /test/index");
		for (const row of [...this.rows.values()]) if (ids.includes(row.source_id)) this.rows.delete(row.id);
		for (const row of rows) this.rows.set(row.id, structuredClone(row));
		this.replacements++;
	}
	async search(options: Parameters<IndexStore["search"]>[0]): Promise<IndexHit[]> {
		return [...this.rows.values()]
			.filter(
				(row) => !options.scope || row.source_id === options.scope || row.source_id.startsWith(`${options.scope}/`),
			)
			.slice(0, options.topK)
			.map((row) => ({ row, score: 1 }));
	}
	async maintain() {
		this.maintained++;
	}
}

function fixture(
	root = temporary(),
	store = new MemoryStore(),
	onEmbed?: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>,
	options: Partial<LocalIndexOptions> = {},
) {
	const calls: string[][] = [];
	const index = new LocalDocumentIndex({
		root,
		store,
		tokenizer: tokens,
		analyzer,
		targetTokens: 64,
		maxTokens: 96,
		embedder: {
			identity: async () => ({ provider: "test", model: "fixture", dimension: 2 }),
			embed: async (texts) => {
				calls.push([...texts]);
				return onEmbed ? onEmbed(texts) : texts.map(() => [1, 0]);
			},
		},
		...options,
	});
	return { root, store, index, calls };
}

describe("native structure-aware chunking", () => {
	it("preserves Unicode, source offsets, section boundaries and token budgets", () => {
		const text = "# 标题\n\n" + "审批需要经理同意。😀 ".repeat(70) + "\n\n## 次章\n\nNew policy.";
		const chunks = chunkMarkdown(text, tokens, { targetTokens: 64, maxTokens: 96 });
		assert(chunks.length > 3);
		for (const chunk of chunks) {
			assert(chunk.tokens <= 96);
			assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
			assert(!/^[\udc00-\udfff]|[\ud800-\udbff]$/u.test(chunk.text));
		}
		assert(chunks.some((chunk) => chunk.heading.includes("次章") && chunk.text.includes("New policy")));
	});
	it("repeats table headers in embedding context while keeping original body offsets", () => {
		const text =
			"# Costs\n\n| Name | Price |\n| --- | --- |\n" +
			Array.from({ length: 30 }, (_, i) => `| Item ${i} | ${i} dollars |\n`).join("");
		const chunks = chunkMarkdown(text, tokens, { targetTokens: 90, maxTokens: 150 });
		assert(chunks.filter((chunk) => chunk.kind === "table").length > 1);
		for (const chunk of chunks) {
			assert(chunk.tokens <= 150);
			assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
			if (chunk.kind === "table") assert(chunk.embeddingText.includes("| Name | Price |"));
		}
	});
	it("does not shift an untouched later section after an edit to an earlier section", () => {
		const later = "\n\n# Stable\n\n" + "Unchanged paragraph. ".repeat(15);
		const first = chunkMarkdown("# First\n\nOld." + later, tokens, { maxTokens: 96 });
		const second = chunkMarkdown("# First\n\nChanged much longer text." + later, tokens, { maxTokens: 96 });
		assert.deepEqual(
			first.filter((chunk) => chunk.heading === "Stable").map((chunk) => chunk.embeddingText),
			second.filter((chunk) => chunk.heading === "Stable").map((chunk) => chunk.embeddingText),
		);
	});
	it("bounds repeated headers even when one table header is larger than the entire chunk budget", () => {
		const text = `| ${"very long heading ".repeat(50)} |\n| --- |\n| row one |\n| row two |\n`;
		const chunks = chunkMarkdown(text, tokens, { maxTokens: 96 });
		assert(chunks.some((chunk) => chunk.text.includes("row two")));
		for (const chunk of chunks) {
			assert(chunk.tokens <= 96);
			assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
		}
	});
});

describe("AutoRAG-owned indexing pipeline", () => {
	it("reports cumulative successful embeddings without changing batch size", async () => {
		const events: IndexEvent[] = [];
		const { root, index, calls } = fixture(undefined, undefined, undefined, {
			onEvent: (event) => events.push(event),
			batchSize: 2,
		});
		const docs = [document(root, "first.md", "First document."), document(root, "second.md", "Second document.")];
		const report = await index.sync(input(docs));
		const completed = events.filter((event) => event.phase === "embed" && event.state === "end");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].length, 2);
		assert.equal(completed[0].progress?.embedded, 2);
		assert.equal(events.at(-1)?.progress?.embedded, report.embedded);
		assert.equal(events.at(-1)?.progress?.chunks, report.chunks);
	});
	it("deduplicates embeddings across sources, then skips unchanged indexing and maintenance", async () => {
		let tokenizerPreparations = 0;
		const f = fixture(undefined, undefined, undefined, {
			onEvent: (event) => {
				if (event.phase === "prepare" && event.source === "tokenizer" && event.state === "start")
					tokenizerPreparations++;
			},
		});
		const a = document(f.root, "a.txt", "Refund approval requires a manager.");
		const b = document(f.root, "b.txt", "Refund approval requires a manager.");
		const first = await f.index.sync(input([a, b]));
		assert.equal(first.embedded, 1);
		assert.equal(first.reused, 1);
		assert.equal(tokenizerPreparations, 1);
		assert.equal(f.store.rows.size, 2);
		assert.equal(new Set([...f.store.rows.values()].map((row) => row.id)).size, 2);
		const calls = f.calls.length;
		const second = await f.index.sync(input([a, b]));
		assert.equal(second.unchanged, 2);
		assert.equal(second.embedded, 0);
		assert.equal(tokenizerPreparations, 2);
		assert.equal(f.calls.length, calls);
		assert.equal(f.store.maintained, 1);
		assert.equal(JSON.parse(readFileSync(second.reportPath, "utf8")).backend, "autorag");
	});
	it("reuses unchanged chunks on force, removes vanished sources and prefilters scope", async () => {
		const f = fixture();
		const a = document(f.root, "a.txt", "Retained evidence.");
		const b = document(f.root, "b.txt", "Deleted evidence.");
		await f.index.sync(input([a, b]));
		const report = await f.index.sync(input([a]), { force: true });
		assert.equal(report.embedded, 0);
		assert.equal(report.deleted, 1);
		assert.equal(f.store.rows.size, 1);
		assert.equal((await f.index.search("evidence", { mode: "bm25", scope: "/docs/other" })).length, 0);
	});
	it("keeps prior rows when a changed document cannot be embedded and records the exact error", async () => {
		const f = fixture(undefined, undefined, async (texts) => {
			if (texts.some((text) => text.includes("REJECT"))) throw new Error("provider failure: fixture bad input");
			return texts.map(() => [1, 0]);
		});
		const old = document(f.root, "policy.txt", "Old policy.");
		await f.index.sync(input([old]));
		const changed = document(f.root, "policy.txt", "REJECT new policy.", "2");
		const report = await f.index.sync(input([changed]));
		assert.equal(report.ok, false);
		assert(report.failures.some((failure) => failure.error.includes("provider failure: fixture bad input")));
		assert([...f.store.rows.values()].some((row) => row.text === "Old policy."));
	});
	it("never sweeps unseen documents if the producer fails during a partial scan", async () => {
		const f = fixture();
		const a = document(f.root, "a.txt", "First.");
		const b = document(f.root, "b.txt", "Second.");
		await f.index.sync(input([a, b]));
		async function* broken() {
			yield a;
			throw new Error("scan EIO at /mounted/docs");
		}
		await assert.rejects(f.index.sync(broken()), /scan EIO/);
		assert.equal(f.store.rows.size, 2);
	});
	it("rejects invalid vectors, observes cancellation and releases the writer lease", async () => {
		const f = fixture(undefined, undefined, async () => [[Number.NaN, 1]]);
		const a = document(f.root, "a.txt", "Bad vector.");
		const report = await f.index.sync(input([a]));
		assert.equal(report.ok, false);
		assert.equal(f.store.rows.size, 0);
		const controller = new AbortController();
		controller.abort(new Error("operator stopped"));
		await assert.rejects(f.index.sync(input([a]), { signal: controller.signal }), /operator stopped/);
		const release = acquireIndexLease(f.index.directory);
		release();
	});
	it("replays a failed commit after restart before acknowledging source state", async () => {
		const root = temporary();
		const store = new MemoryStore();
		const journal = new IndexJournal(root);
		store.failWrite = true;
		await assert.rejects(journal.replace(store, [{ id: "source", fingerprint: "new" }], []), /disk full/);
		assert.equal(journal.unchanged("source", "new"), false);
		journal.close();
		store.failWrite = false;
		const restarted = new IndexJournal(root);
		assert.equal(await restarted.recover(store), 1);
		assert.equal(restarted.unchanged("source", "new"), true);
		assert.equal(await restarted.recover(store), 0);
		restarted.close();
	});
	it("excludes simultaneous writers and does not let a throwing observer fail indexing", async () => {
		const root = temporary();
		const release = acquireIndexLease(root);
		assert.throws(() => acquireIndexLease(root), /another AutoRAG index writer/);
		release();
		const f = fixture(root);
		const report = await f.index.sync(input([document(root, "a.txt", "Valid.")]), {
			onEvent() {
				throw new Error("UI failed");
			},
		});
		assert.equal(report.ok, true);
	});
	it("bounds padded batches and isolates one rejected document from a successful peer", async () => {
		const f = fixture(
			undefined,
			undefined,
			async (texts) => {
				if (texts.some((text) => text.includes("REJECT"))) throw new Error("bad document");
				return texts.map(() => [1, 0]);
			},
			{ maxBatchTokens: 128 },
		);
		const docs = Array.from({ length: 7 }, (_, i) => document(f.root, `${i}.txt`, "x".repeat(50 + i)));
		docs.push(document(f.root, "bad.txt", "REJECT"));
		const report = await f.index.sync(input(docs));
		assert.equal(report.ok, false);
		assert.equal(f.store.rows.size, 7);
		assert.equal(f.index.status(), "degraded");
		assert.equal((await f.index.search("x", { mode: "bm25" })).length, 7);
		assert(f.calls.every((batch) => batch.length * Math.max(...batch.map((text) => tokens.count(text))) <= 128));
	});
	it("invalidates readiness for an explicitly changed model revision", async () => {
		const f = fixture();
		await f.index.sync(input([document(f.root, "a.txt", "Valid.")]));
		assert(f.index.isReady());
		const next = fixture(f.root, f.store, undefined, { embeddingFingerprint: "replacement-model-revision" });
		assert.equal(next.index.isReady(), false);
		await assert.rejects(next.index.search("query"), /not ready/);
	});
	it("explains model mismatches before query embedding and preserves the ready marker", async () => {
		const f = fixture();
		await f.index.sync(input([document(f.root, "a.txt", "Valid.")]));
		const before = readFileSync(join(f.index.directory, "ready.json"), "utf8");
		const next = fixture(f.root, f.store, undefined, {
			identity: { provider: "minsync", model: "Qwen/Qwen3-Embedding-0.6B", dimension: 1024 },
		});
		assert.equal(next.index.status(), "configured");
		await assert.rejects(next.index.search("query"), (error: Error) => {
			assert.match(error.message, /indexed: fixture, 2 dimensions/);
			assert.match(error.message, /configured: Qwen\/Qwen3-Embedding-0.6B, 1024 dimensions/);
			assert.match(error.message, /same --config/);
			return true;
		});
		assert.equal(next.calls.length, 0);
		assert.equal(readFileSync(join(f.index.directory, "ready.json"), "utf8"), before);
	});
	it("rejects zero query vectors and identifies lexical failures by stage", async () => {
		const f = fixture();
		await f.index.sync(input([document(f.root, "a.txt", "Valid.")]));
		const badQuery = fixture(f.root, f.store, async () => [[0, 0]]);
		await assert.rejects(badQuery.index.search("query"), /invalid dimensions or values/);
		const lexical = fixture(f.root, f.store, undefined, {
			analyzer: {
				fingerprint: "failed-analyzer",
				analyze: async () => {
					throw new Error("lexical fixture failed");
				},
			},
		});
		const report = await lexical.index.sync(input([document(f.root, "a.txt", "Changed.", "2")]));
		assert.equal(report.failures[0]?.stage, "lexical");
		assert([...f.store.rows.values()].some((row) => row.text === "Valid."));
	});
	it("finishes maintenance after an interrupted run even when source fingerprints are already current", async () => {
		const f = fixture();
		const doc = document(f.root, "a.txt", "Valid.");
		await f.index.sync(input([doc]));
		const marker = JSON.parse(readFileSync(join(f.index.directory, "ready.json"), "utf8"));
		writeFileSync(join(f.index.directory, marker.profile, "maintenance-needed"), "");
		assert.equal(f.index.status(), "degraded");
		const report = await f.index.sync(input([doc]));
		assert.equal(report.unchanged, 1);
		assert.equal(report.embedded, 0);
		assert.equal(f.store.maintained, 2);
		assert.equal(f.index.status(), "ready");
	});
});

describe("bounded indexing input and config", () => {
	it("releases a blocked producer when the consumer fails", async () => {
		const channel = new DocumentChannel<number>(1);
		await channel.push(1);
		const pending = channel.push(2);
		channel.fail(new Error("index worker failed"));
		await assert.rejects(pending, /index worker failed/);
	});
	it("validates numeric budgets and rejects unknown options", () => {
		assert.throws(() => normalizeLocalIndex({ batchSize: 0 }), /positive integer/);
		assert.throws(() => normalizeLocalIndex({ maxTokens: 100, targetTokens: 200 }), /token budgets/);
		assert.throws(() => normalizeLocalIndex({ surprise: true }), /not a recognized field/);
	});
});

describe("local lexical assets", () => {
	it("segments Chinese words and honors abort before creating a Korean worker", async () => {
		const analyzer = createLexicalAnalyzer();
		assert((await analyzer.analyze("退款审批流程")).includes("退款"));
		const signal = AbortSignal.abort(new Error("cancel morphology"));
		await assert.rejects(analyzer.analyze("인증서를", signal), /cancel morphology/);
		analyzer.close?.();
	});
	it("extracts only named model files and rejects truncated archive data", () => {
		const blocks = KIWI_MODEL_FILES.flatMap((name) => {
			const header = Buffer.alloc(512);
			header.write(`model/${name}`);
			header.write("00000000001", 124, "ascii");
			header[156] = 48;
			const body = Buffer.alloc(512);
			body[0] = 65;
			return [header, body];
		});
		const files = extractKiwiModelFiles(gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
		assert.equal(files.size, KIWI_MODEL_FILES.length);
		assert.equal(files.get("sj.morph")?.[0], 65);
		assert.throws(() => extractKiwiModelFiles(gzipSync(blocks[0])), /invalid Kiwi model archive length/);
	});
});

it("refreshes and searches an empty corpus without loading tokenizer assets or an embedding engine", async () => {
	const { index, calls } = fixture(undefined, undefined, undefined, {
		tokenizer: undefined,
		identity: { provider: "test", model: "fixture", dimension: 2 },
	});
	assert.equal((await index.sync(input([]))).ok, true);
	assert.deepEqual(await index.search("anything"), []);
	assert.equal(calls.length, 0);
});

it("pins the generation before awaiting a concurrent activation", async () => {
	const f = fixture();
	await f.index.sync(input([document(f.root, "a.md", "A stable policy document.")]));
	const pointer = join(f.index.directory, "ready.json");
	const old = JSON.parse(readFileSync(pointer, "utf8"));
	const search = f.index.search("policy");
	writeFileSync(pointer, JSON.stringify({ ...old, profile: "another-generation" }));
	assert.equal((await search).length, 1);
});
