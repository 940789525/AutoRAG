import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { LanceIndexStore } from "../../src/indexing/lance-store.ts";
import type { IndexRow } from "../../src/indexing/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
	const directory = mkdtempSync(join(tmpdir(), "autorag-lance-"));
	roots.push(directory);
	return directory;
}
function row(id: string, source = "/docs/refunds.txt", text = "refund approval manager", vector = [1, 0]): IndexRow {
	return {
		id,
		source_id: source,
		source_path: `/fixture${source}`,
		text,
		embedding_text: text,
		embedding_key: text,
		lexical_text: text,
		heading: "Refunds",
		kind: "paragraph",
		start: 0,
		end: text.length,
		tokens: 3,
		vector,
	};
}

describe("local LanceDB adapter with actual database operations", () => {
	it("applies a frozen source allowlist before every retrieval mode ranks candidates", async () => {
		const store = await LanceIndexStore.open(root(), 2);
		const allowed = "/papers/old'paper.pdf";
		await store.replace([allowed, "/papers/new.pdf"], [row("old", allowed), row("new", "/papers/new.pdf")]);
		await store.maintain();
		for (const mode of ["vector", "bm25", "hybrid"] as const) {
			const options = { text: "refund", vector: mode === "bm25" ? undefined : [1, 0], mode, topK: 1 };
			assert.equal((await store.search({ ...options, sourceIds: [allowed] }))[0]?.row.id, "old");
			assert.deepEqual(await store.search({ ...options, sourceIds: [] }), []);
			assert.deepEqual(await store.search({ ...options, sourceIds: ["' OR 1=1 --"] }), []);
			assert.deepEqual(await store.search({ ...options, sourceIds: [allowed], scope: "/outside" }), []);
		}
	});
	it("opens existing chunks exactly without vectors, and never creates a missing index", async () => {
		const directory = root();
		const missing = join(directory, "absent");
		await assert.rejects(LanceIndexStore.openExisting(missing), /missing/);
		assert(!existsSync(missing));
		await assert.rejects(LanceIndexStore.openExisting(directory), /missing/);
		assert.deepEqual(readdirSync(directory), []);
		const source = "/docs/quote' OR 1=1.txt";
		const store = await LanceIndexStore.open(directory, 2);
		await store.replace([source, "/docs/other.txt"], [row("chunk", source), row("other", "/docs/other.txt")]);
		const reader = await LanceIndexStore.openExisting(directory);
		const chunk = await reader.readChunk(source, "chunk");
		assert.equal(chunk?.id, "chunk");
		assert.equal(chunk?.source_id, source);
		assert(!Object.hasOwn(chunk!, "vector"));
		assert.equal(await reader.readChunk(source, "other"), undefined);
		assert.equal(await reader.readChunk("' OR 1=1 --", "chunk"), undefined);
	});
	it("commits source-scoped replacements, reuses vectors and keeps other documents intact", async () => {
		const store = await LanceIndexStore.open(root(), 2);
		await store.replace(["/docs/refunds.txt", "/docs/other.txt"], [row("old"), row("other", "/docs/other.txt")]);
		await store.replace(["/docs/refunds.txt"], [row("new", "/docs/refunds.txt", "refund director approval")]);
		await store.maintain();
		const cached = await store.findVectors(["refund director approval"]);
		assert.deepEqual(cached.get("refund director approval"), [1, 0]);
		const hits = await store.search({ text: "refund", mode: "bm25", topK: 10 });
		assert(hits.some((hit) => hit.row.id === "new"));
		assert(hits.some((hit) => hit.row.id === "other"));
		assert(!hits.some((hit) => hit.row.id === "old"));
	});
	it("includes newly written rows in vector and FTS retrieval with scope applied before top-k", async () => {
		const store = await LanceIndexStore.open(root(), 2);
		await store.replace(["/outside/policy"], [row("outside", "/outside/policy")]);
		await store.maintain();
		await store.replace(["/docs/policy"], [row("inside", "/docs/policy")]);
		for (const mode of ["vector", "bm25", "hybrid"] as const) {
			const hits = await store.search({
				text: "refund",
				vector: mode === "bm25" ? undefined : [1, 0],
				mode,
				topK: 1,
				scope: "/docs",
			});
			assert.equal(hits[0]?.row.id, "inside");
		}
	});
	it("handles an empty corpus and deletes exactly the requested source", async () => {
		const store = await LanceIndexStore.open(root(), 2);
		await store.maintain();
		assert.equal((await store.search({ text: "refund", mode: "bm25", topK: 5 })).length, 0);
		await store.replace(["/docs/refunds.txt"], [row("a")]);
		await store.replace(["/docs/refunds.txt"], []);
		assert.equal((await store.search({ text: "refund", mode: "bm25", topK: 5 })).length, 0);
	});
	it("preserves wildcard scopes and treats file scopes as exact source identities", async () => {
		const store = await LanceIndexStore.open(root(), 2);
		const sources = ["/docs/a.txt", "/docs/nested/b.txt", "/docs/a.txt/child", "/elsewhere/c.txt"];
		await store.replace(
			sources,
			sources.map((source, i) => row(String(i), source)),
		);
		await store.maintain();
		for (const [scope, expected] of [
			["/docs/*.txt", ["/docs/a.txt"]],
			["/docs/**", sources.slice(0, 3)],
			["/docs/a.txt", ["/docs/a.txt"]],
		] as const) {
			const hits = await store.search({ text: "refund", mode: "bm25", scope, topK: 10 });
			assert.deepEqual(hits.map((hit) => hit.row.source_id).sort(), [...expected].sort());
		}
	});
});

it("builds the large-corpus ANN index and checks recall against an exact cosine scan", async () => {
	const directory = root();
	const store = await LanceIndexStore.open(directory, 32);
	let seed = 17;
	const vector = () =>
		Array.from({ length: 32 }, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 0x100000000 - 0.5;
		});
	const rows = Array.from({ length: 10_000 }, (_, i) => row(String(i), "/docs/large.txt", `passage ${i}`, vector()));
	await store.replace(["/docs/large.txt"], rows);
	await store.maintain();
	const { connect } = await import("@lancedb/lancedb");
	const db = await connect(directory);
	const table = await db.openTable("chunks");
	try {
		assert((await table.listIndices()).some((index) => index.columns.includes("vector")));
		for (let i = 0; i < 3; i++) {
			const query = vector();
			const exact = await table.vectorSearch(query).distanceType("cosine").bypassVectorIndex().limit(10).toArray();
			const approximate = await store.search({ text: "", vector: query, mode: "vector", topK: 10 });
			const expected = new Set(exact.map((hit) => hit.id));
			const recall = approximate.filter((hit) => expected.has(hit.row.id)).length / 10;
			assert(recall >= 0.9, `ANN recall@10 was ${recall}`);
		}
	} finally {
		table.close();
		db.close();
	}
}, 120_000);
