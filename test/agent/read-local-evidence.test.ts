import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { CitationNumbers } from "../../src/agent/citation-numbers.ts";
import type { ContextSelectionProjector } from "../../src/agent/context-selection-projector.ts";
import { ConversationQueries } from "../../src/agent/conversation-queries.ts";
import { EvidenceLedger, parseLedgerEntries } from "../../src/agent/evidence-ledger.ts";
import { restoreConversationState } from "../../src/agent/evidence-persistence.ts";
import { assertCompleteEvidenceReads, createReadLocalEvidenceTool } from "../../src/agent/read-local-evidence-tool.ts";
import { contentHash } from "../../src/indexing/chunker.ts";
import { type LocalEvidenceResult, type LocalReadHandle, localEvidence } from "../../src/indexing/evidence.ts";
import type { LocalDocumentIndex } from "../../src/indexing/pipeline.ts";
import { parsedMirrorIndexPath } from "../../src/mirror/paths.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(mode: "off" | "observe" | "adaptive" = "off") {
	const root = mkdtempSync(join(tmpdir(), "autorag-read-evidence-"));
	roots.push(root);
	const docs = join(root, "docs");
	mkdirSync(docs);
	const source = join(docs, "policy.txt");
	const body = "Refund exceptions require director approval. ".repeat(58);
	writeFileSync(source, body);
	const base = nativeIndexFixture();
	let embedCalls = 0;
	let failEmbedding = false;
	const agent = new AutoRAGAgent({
		...base,
		embedder: {
			...base.embedder!,
			embed: async (texts, options) => {
				if (failEmbedding) throw new Error("embedding must not run during evidence reads");
				embedCalls++;
				return base.embedder!.embed(texts, options);
			},
		},
		localIndex: {
			...base.localIndex,
			tokenizer: { fingerprint: "read-fixture", count: (text) => Math.ceil(text.length / 4) },
		},
		searchPaths: [docs],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		jikji: false,
		everything: false,
		fsearch: false,
		webSearch: false,
		jev: false,
		dupey: false,
		memoryEmbedder: false,
		excludeExactDuplicates: false,
		contextSelection: { mode },
	});
	await agent.refresh(false, { methods: ["minsync"] });
	const tools = (agent as unknown as { tools: readonly AgentTool[] }).tools;
	const search = tools.find((tool) => tool.name === "semantic_search_local_docs")!;
	const result = await search.execute("search", { query: "refund approval" } as never);
	const evidenceId = result.content
		.flatMap((part) => (part.type === "text" ? (part.text.match(/\[(e\d+)\]/g) ?? []) : []))
		.at(-1)!
		.slice(1, -1);
	const tool = tools.find((tool) => tool.name === "read_local_evidence")!;
	return {
		root,
		docs,
		source,
		body,
		agent,
		tool,
		evidenceId,
		searchResult: result,
		calls: () => embedCalls,
		disableEmbedding: () => {
			failEmbedding = true;
		},
	};
}

describe("read_local_evidence with real indexing and LanceDB", () => {
	it.each(["off", "observe", "adaptive"] as const)(
		"reads complete original chunks without embeddings in %s",
		async (mode) => {
			const f = await fixture(mode);
			expect(f.tool).toBeDefined();
			const before = f.calls();
			const ledger = (f.agent as unknown as { evidenceLedger: EvidenceLedger }).evidenceLedger;
			const entries = ledger.localReadEntries();
			f.disableEmbedding();
			f.agent.refresh = async () => {
				throw new Error("refresh must not run during a read");
			};
			f.agent.retrieve = async () => {
				throw new Error("search must not run during a read");
			};
			(f.agent as unknown as { minSyncMethod: { index: LocalDocumentIndex } }).minSyncMethod.index.search =
				async () => {
					throw new Error("index search must not run during a read");
				};
			const result = await f.tool.execute("read", { evidenceId: f.evidenceId } as never);
			expect(result.details).toMatchObject({
				evidenceId: f.evidenceId,
				complete: true,
				source: f.source,
				text: f.body,
			});
			expect((result.details as { bodySha256: string }).bodySha256).toBe(
				createHash("sha256").update(f.body).digest("hex"),
			);
			expect(f.calls()).toBe(before);
			expect(ledger.localReadEntries()).toEqual(entries);
			expect(readFileSync(f.source, "utf8")).toBe(f.body);
		},
	);
	it("rejects changed source content even when size and mtime are restored", async () => {
		const f = await fixture();
		const previous = statSync(f.source);
		writeFileSync(f.source, f.body.replace("director", "DIRECTOR"));
		utimesSync(f.source, previous.atime, previous.mtime);
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/changed|version/i);
	});
	it("rejects unknown IDs, path parameters and extra fields", async () => {
		const f = await fixture();
		for (const params of [
			null,
			{},
			{ evidenceId: "" },
			{ evidenceId: "e0" },
			{ evidenceId: "e01" },
			{ evidenceId: 9 },
			{ evidenceId: "e99999" },
			{ evidenceId: f.source },
			{ evidenceId: f.evidenceId, path: f.source },
		])
			await expect(f.tool.execute("read", params as never)).rejects.toThrow();
	});
	it("preserves the underlying missing-source diagnostic and cancellation", async () => {
		const f = await fixture();
		const abort = new AbortController();
		abort.abort(new Error("cancelled evidence read"));
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never, abort.signal)).rejects.toThrow(
			"cancelled evidence read",
		);
		rmSync(f.source);
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/ENOENT/);
	});
	it("rejects current scope restrictions and an excluded source", async () => {
		const f = await fixture();
		const internal = f.agent as unknown as { activeRetrievalOptions: { scope?: string }; excludePaths: string[] };
		internal.activeRetrievalOptions = { scope: "/docs/other.txt" };
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/scope/);
		internal.activeRetrievalOptions = {};
		internal.excludePaths.push(f.source);
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/scope/);
	});
	it("fails conservatively after clear and on old sessions without verified locators", async () => {
		const f = await fixture();
		const ledger = (f.agent as unknown as { evidenceLedger: EvidenceLedger }).evidenceLedger;
		const saved = ledger.takeUnsaved();
		expect(saved.some((entry) => entry.localReadHandle)).toBe(true);
		ledger.clear();
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/session branch/);
		ledger.restore(saved);
		expect((await f.tool.execute("read", { evidenceId: f.evidenceId } as never)).details).toMatchObject({
			complete: true,
		});
		const legacy = saved.map(({ localReadHandle: _handle, ...entry }) => entry);
		ledger.restore(legacy);
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/no verified/);
	});
	it("rejects edited parsed mirrors and unavailable index profiles without embedding", async () => {
		const f = await fixture();
		f.disableEmbedding();
		const manifest = JSON.parse(readFileSync(parsedMirrorIndexPath(f.root), "utf8"));
		const entry = Object.values(manifest.entries)[0] as { outputPath: string };
		writeFileSync(entry.outputPath, "forged parsed text");
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/version changed/);
		const ready = join(f.root, ".autorag/local-index/ready.json");
		writeFileSync(ready, JSON.stringify({ version: 1, profile: "0".repeat(64) }));
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/profile changed/);
	});
	it("does not follow a source symlink to a different document", async () => {
		const f = await fixture();
		const outside = join(f.root, "outside.txt");
		writeFileSync(outside, f.body);
		rmSync(f.source);
		symlinkSync(outside, f.source);
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/scope|changed/);
	});
	it("does not create an index after it has been removed", async () => {
		const f = await fixture();
		f.disableEmbedding();
		const directory = join(f.root, ".autorag/local-index");
		rmSync(directory, { recursive: true });
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId } as never)).rejects.toThrow(/ENOENT/);
		expect(existsSync(directory)).toBe(false);
	});
	it("ER-U10 rejects a legacy parsed manifest without source fingerprints", async () => {
		const f = await fixture();
		const path = parsedMirrorIndexPath(f.root);
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		for (const entry of Object.values(manifest.entries) as Record<string, unknown>[]) {
			delete entry.sourceSha256;
			delete entry.outputSha256;
		}
		writeFileSync(path, JSON.stringify(manifest));
		f.disableEmbedding();
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId })).rejects.toThrow(/version changed/);
	});
	it("ER-U06/U07 rejects a sibling prefix and a retargeted configured root", async () => {
		const f = await fixture();
		const internal = f.agent as unknown as {
			canReadLocalEvidence: (source: string, id: string) => boolean;
			configuredSearchPaths: string[];
		};
		const sibling = `${f.docs}-other`;
		mkdirSync(sibling);
		const source = join(sibling, "policy.txt");
		writeFileSync(source, f.body);
		expect(internal.canReadLocalEvidence(source, "/docs/policy.txt")).toBe(false);
		internal.configuredSearchPaths[0] = sibling;
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId })).rejects.toThrow(/scope/);
	});
	it("ER-I02 restores a real indexed chunk after deterministic capacity compaction", async () => {
		const f = await fixture("adaptive");
		const p = (f.agent as unknown as { contextSelection: ContextSelectionProjector }).contextSelection;
		const model = { id: "small", contextWindow: 8000, maxTokens: 1000 } as Model<Api>;
		p.begin("List all policies");
		p.registerToolResult("search", "semantic_search_local_docs", f.searchResult.content);
		const raw: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "search",
				toolName: "semantic_search_local_docs",
				content: f.searchResult.content,
				isError: false,
				timestamp: 0,
			},
		];
		const send = () => {
			const view = p.finalize(p.project(raw, model));
			p.observePrepared(view);
			p.dispatch(view);
			p.settle(true);
			return view;
		};
		expect(JSON.stringify(send())).toContain(f.body.trim());
		p.begin("A different question");
		raw.push({ role: "user", content: "X".repeat(17000), timestamp: 1 });
		expect(JSON.stringify(send())).not.toContain(f.body.trim());
		p.begin(`Restore ${f.evidenceId}`);
		f.disableEmbedding();
		const result = await f.tool.execute("restore", { evidenceId: f.evidenceId });
		raw.push({
			role: "toolResult",
			toolCallId: "restore",
			toolName: f.tool.name,
			content: result.content,
			isError: false,
			timestamp: 2,
		});
		const final = send();
		expect(JSON.stringify(final.at(-1))).toContain(f.body.trim());
		expect(JSON.stringify(final.at(-1))).not.toContain("AutoRAG evidence reference");
		expect(() => assertCompleteEvidenceReads(final)).not.toThrow();
	});
	it.each(["missing", "body", "source", "position", "database", "revoked", "cancelled"])(
		"ER-U09/U10/U13 rejects %s during exact index reads without embeddings",
		async (change) => {
			const f = await fixture();
			const internal = f.agent as unknown as {
				minSyncMethod: { index: LocalDocumentIndex };
				evidenceLedger: EvidenceLedger;
				excludePaths: string[];
			};
			const handle = internal.evidenceLedger.localReadEntry(f.evidenceId)!.localReadHandle!;
			const row = await internal.minSyncMethod.index.readEvidence(handle, () => true);
			const abort = new AbortController();
			const options = (
				internal.minSyncMethod.index as unknown as {
					options: { store: { readChunk: () => Promise<typeof row | undefined> } };
				}
			).options;
			options.store = {
				readChunk: async () => {
					if (change === "database") throw new Error("LanceDB fixture I/O failure /fixture/store");
					if (change === "missing") return undefined;
					if (change === "revoked") internal.excludePaths.push(f.source);
					if (change === "cancelled") abort.abort(new Error("cancelled during database read"));
					return {
						...row,
						...(change === "body" ? { text: row.text.replace("director", "DIRECTOR") } : {}),
						...(change === "source" ? { source_id: "/docs/another.txt" } : {}),
						...(change === "position" ? { start: row.start + 1 } : {}),
					};
				},
			};
			f.disableEmbedding();
			await expect(f.tool.execute("read", { evidenceId: f.evidenceId }, abort.signal)).rejects.toThrow(
				change === "database"
					? /LanceDB fixture I\/O failure \/fixture\/store/
					: change === "revoked"
						? /scope/
						: change === "cancelled"
							? /cancelled during database read/
							: /chunk version/,
			);
		},
	);
	it("ER-U05/ER-I06 restores only current-branch read locators and preserves global ID ordinals", async () => {
		const f = await fixture();
		const ledger = (f.agent as unknown as { evidenceLedger: EvidenceLedger }).evidenceLedger;
		const saved = ledger.takeUnsaved();
		const entry = {
			type: "custom" as const,
			id: "branch-a",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "autorag.evidence",
			data: { entries: saved },
		};
		const session = { getEntries: () => [entry], getBranch: () => [] as (typeof entry)[] };
		restoreConversationState(ledger, new CitationNumbers(), new ConversationQueries(), session);
		await expect(f.tool.execute("read", { evidenceId: f.evidenceId })).rejects.toThrow(/no verified/);
		session.getBranch = () => [entry];
		restoreConversationState(ledger, new CitationNumbers(), new ConversationQueries(), session);
		expect((await f.tool.execute("read", { evidenceId: f.evidenceId })).details).toMatchObject({ complete: true });
	});
});

describe("read locator trust and final capacity boundary", () => {
	const handle = (source = "/docs/policy.txt"): LocalReadHandle => ({
		version: 1,
		source,
		sourceId: "/docs/policy.txt",
		chunkId: "chunk",
		profile: "a".repeat(64),
		bodySha256: contentHash("a b"),
		sourceSha256: "b".repeat(64),
		outputSha256: "c".repeat(64),
	});
	it("ER-U03 preserves table whitespace, Unicode and UTF-16 locations without prepending the heading", async () => {
		const body = "规则😀\n\n| 项目 | 数值 |\n| --- | --- |\n| 审批 | 总监 |\n\n原始  空白\n";
		const ledger = new EvidenceLedger();
		const locator = { ...handle(), bodySha256: contentHash(body) };
		const id = ledger.registerResult("local", {
			id: locator.chunkId,
			source: locator.source,
			content: body,
			score: 1,
			metadata: {},
			[localEvidence]: { query: "q", profile: locator.profile, vector: [], readHandle: locator },
		} as LocalEvidenceResult);
		const tool = createReadLocalEvidenceTool(ledger, async () => ({
			id: locator.chunkId,
			source_id: locator.sourceId,
			source_path: locator.source,
			text: body,
			heading: "Separate heading",
			kind: "paragraph",
			start: 5,
			end: 5 + body.length,
			tokens: 1,
		}));
		const result = await tool.execute("read", { evidenceId: id });
		expect(result.details).toMatchObject({
			text: body,
			heading: "Separate heading",
			start: 5,
			end: 5 + body.length,
			bodySha256: contentHash(body),
		});
		const text = result.content[0];
		expect(text.type === "text" && text.text.slice(text.text.indexOf("\n") + 1)).toBe(body);
	});
	it.each([65535, 65536, 65537])("ER-U12 enforces the exact UTF-8 boundary at %i bytes", async (bytes) => {
		const body = "中".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
		expect(Buffer.byteLength(body)).toBe(bytes);
		const ledger = new EvidenceLedger();
		const locator = { ...handle(), bodySha256: contentHash(body) };
		const id = ledger.registerResult("local", {
			id: locator.chunkId,
			source: locator.source,
			content: body,
			score: 1,
			metadata: {},
			[localEvidence]: { query: "q", profile: locator.profile, vector: [], readHandle: locator },
		} as LocalEvidenceResult);
		const tool = createReadLocalEvidenceTool(ledger, async () => ({
			id: locator.chunkId,
			source_id: locator.sourceId,
			source_path: locator.source,
			text: body,
			heading: "",
			kind: "paragraph",
			start: 0,
			end: body.length,
			tokens: 1,
		}));
		if (bytes > 65536) await expect(tool.execute("read", { evidenceId: id })).rejects.toThrow(/65536/);
		else
			expect((await tool.execute("read", { evidenceId: id })).details).toMatchObject({ text: body, complete: true });
	});
	it.each(["web_fetch", "bash", "search_datasource_kakao", "obsidian"])(
		"ER-U18 refuses %s evidence before accessing a reader",
		async (method) => {
			const ledger = new EvidenceLedger();
			const id = ledger.registerResult(method, {
				id: "untrusted",
				source: method === "web_fetch" ? "https://example.com" : "/kakao/account/chunks/1",
				content: "a b",
				score: 1,
				metadata: { readHandle: handle() },
			});
			let reads = 0;
			const tool = createReadLocalEvidenceTool(ledger, async () => {
				reads++;
				throw new Error("reader must not run");
			});
			await expect(tool.execute("read", { evidenceId: id })).rejects.toThrow(/no verified/);
			expect(reads).toBe(0);
		},
	);
	it("does not trust public metadata or an ordinary registered excerpt", () => {
		const ledger = new EvidenceLedger();
		const id = ledger.registerResult("web_fetch", {
			id: "chunk",
			source: "/docs/policy.txt",
			content: "a b",
			score: 1,
			metadata: { readHandle: handle() },
		});
		expect(ledger.localReadEntry(id)).toBeUndefined();
	});
	it("removes ambiguous locators when normalized citation IDs collide", () => {
		const ledger = new EvidenceLedger();
		const result = (body: string, readHandle: LocalReadHandle) => ({
			id: "chunk",
			source: readHandle.source,
			content: body,
			score: 1,
			metadata: {},
			[localEvidence]: { query: "q", profile: readHandle.profile, vector: [], readHandle },
		});
		const id = ledger.registerResult("local", result("a b", handle()));
		expect(ledger.localReadEntry(id)).toBeDefined();
		expect(ledger.registerResult("local", result("a  b", { ...handle(), bodySha256: contentHash("a  b") }))).toBe(id);
		expect(ledger.localReadEntry(id)).toBeUndefined();
		ledger.registerResult("local", result("a b", handle()));
		expect(ledger.localReadEntry(id)).toBeUndefined();
	});
	it("preserves legacy citations when optional locator metadata is corrupt", () => {
		const ledger = new EvidenceLedger();
		ledger.register({ method: "local", source: "/docs/policy.txt", content: "a b" });
		const parsed = parseLedgerEntries({
			entries: ledger.takeUnsaved().map((entry) => ({ ...entry, localReadHandle: { version: 999 } })),
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0].localReadHandle).toBeUndefined();
	});
	it("rejects a provider payload if a final guard alters its complete body", async () => {
		const ledger = new EvidenceLedger();
		const locator = handle();
		const id = ledger.registerResult("local", {
			id: "chunk",
			source: locator.source,
			content: "a b",
			score: 1,
			metadata: {},
			[localEvidence]: { query: "q", profile: locator.profile, vector: [], readHandle: locator },
		} as LocalEvidenceResult);
		const tool = createReadLocalEvidenceTool(ledger, async () => ({
			id: "chunk",
			source_id: locator.sourceId,
			source_path: locator.source,
			text: "a b",
			heading: "",
			kind: "paragraph",
			start: 0,
			end: 3,
			tokens: 2,
		}));
		const result = await tool.execute("r", { evidenceId: id });
		const message = {
			role: "toolResult" as const,
			toolName: tool.name,
			toolCallId: "r",
			timestamp: 0,
			isError: false,
			content: result.content,
		};
		expect(() => assertCompleteEvidenceReads([message])).not.toThrow();
		expect(() => assertCompleteEvidenceReads([message], () => false)).toThrow(/current search roots or scope/);
		const truncated = structuredClone(message);
		if (truncated.content[0].type === "text") truncated.content[0].text = truncated.content[0].text.slice(0, -1);
		expect(() => assertCompleteEvidenceReads([truncated])).toThrow(/truncated or altered/);
	});
	it("bounds restored read locators without deleting citations or reusing evidence IDs", () => {
		const ledger = new EvidenceLedger();
		for (let n = 0; n < 1025; n++) {
			const locator = handle(`/docs/${n}.txt`);
			ledger.registerResult("local", {
				id: "chunk",
				source: locator.source,
				content: "a b",
				score: 1,
				metadata: {},
				[localEvidence]: { query: "q", profile: locator.profile, vector: [], readHandle: locator },
			} as LocalEvidenceResult);
		}
		expect(ledger.localReadEntry("e1")).toBeUndefined();
		expect(ledger.lookup("e1", { allowLocalFiles: false })).toHaveLength(1);
		expect(ledger.localReadEntries()).toHaveLength(1024);
		const saved = ledger.takeUnsaved();
		ledger.restore(saved);
		expect(ledger.localReadEntries()).toHaveLength(1024);
		ledger.clear();
		expect(ledger.register({ method: "local", source: "/new", content: "new" })).toBe("e1026");
	});
	it.each(["branch", "raw-body", "oversized"])("rejects a %s change at the read boundary", async (mode) => {
		const ledger = new EvidenceLedger();
		const body = mode === "oversized" ? "中".repeat(22000) : "a b";
		const locator = { ...handle(), bodySha256: contentHash(body) };
		const id = ledger.registerResult("local", {
			id: "chunk",
			source: locator.source,
			content: body,
			score: 1,
			metadata: {},
			[localEvidence]: { query: "q", profile: locator.profile, vector: [], readHandle: locator },
		} as LocalEvidenceResult);
		const tool = createReadLocalEvidenceTool(ledger, async () => {
			if (mode === "branch") ledger.clear();
			return {
				id: "chunk",
				source_id: locator.sourceId,
				source_path: locator.source,
				text: mode === "raw-body" ? "a  b" : body,
				heading: "",
				kind: "paragraph",
				start: 0,
				end: body.length,
				tokens: 2,
			};
		});
		await expect(tool.execute("r", { evidenceId: id })).rejects.toThrow(
			mode === "branch" ? /session branch/ : mode === "raw-body" ? /verified locator/ : /byte complete-body limit/,
		);
	});
});
