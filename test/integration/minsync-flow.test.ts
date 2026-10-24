import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

let root: string;
let docs: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "autorag-index-flow-"));
	docs = join(root, "docs");
	mkdirSync(docs);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function agent() {
	return new AutoRAGAgent({
		...nativeIndexFixture(),
		searchPaths: [docs],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		jikji: false,
		everything: false,
		fsearch: false,
		excludeExactDuplicates: false,
		minSync: { binaryPath: join(root, "missing-minsync"), autoInstall: false },
	});
}

describe("AutoRAG local indexing integration (legacy method name minsync)", () => {
	it("uses original readable paths without executing the MinSync CLI", async () => {
		writeFileSync(join(docs, "handbook.txt"), "Refund decisions require manager review.\n");
		const runtime = agent();
		const refresh = await runtime.refresh(false, { methods: ["minsync"] });
		expect(refresh.minsync?.report).toMatchObject({ backend: "autorag", ok: true });
		const results = await runtime.retrieve("refund approval", { topK: 1 });
		expect(results).toHaveLength(1);
		expect(results[0]?.source).toBe(realpathSync(join(docs, "handbook.txt")));
		expect(readFileSync(results[0]!.source, "utf8")).toContain("manager review");
		expect(results[0]?.metadata).toMatchObject({ indexBackend: "autorag", virtualPath: "/docs/handbook.txt" });
		expect(existsSync(join(root, ".minsync"))).toBe(false);
	});
	it("applies source scope before top-k", async () => {
		mkdirSync(join(docs, "sub"));
		writeFileSync(join(docs, "outside.txt"), "Refund approval.");
		writeFileSync(join(docs, "sub", "inside.txt"), "Inside refund policy.");
		const runtime = agent();
		await runtime.refresh(false, { methods: ["minsync"] });
		const results = await runtime.retrieve("refund approval", { topK: 1, scope: "/docs/sub" });
		expect(results).toHaveLength(1);
		expect(results[0]?.source).toBe(realpathSync(join(docs, "sub", "inside.txt")));
	});
	it("reports an unbuilt native index with its actual path", async () => {
		const { diagnostics } = await agent().retrieveWithDiagnostics("manager", { topK: 5 });
		expect(
			diagnostics.some((item) => item.reason?.includes("Local index is not ready") && item.reason.includes(root)),
		).toBe(true);
	});
});
