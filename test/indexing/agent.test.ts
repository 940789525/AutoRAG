import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import type { IndexEvent } from "../../src/indexing/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent uses the native local indexing workflow", () => {
	it("indexes and searches without a MinSync binary, exposing timings and original sources", async () => {
		const root = mkdtempSync(join(tmpdir(), "autorag-agent-native-index-"));
		roots.push(root);
		const docs = join(root, "docs");
		mkdirSync(docs);
		const source = join(docs, "refunds.md");
		writeFileSync(source, "# Refunds\n\nDirector approval is required before payout.");
		let embedded = 0;
		let failQuery = false;
		const agent = new AutoRAGAgent({
			searchPaths: [docs],
			workspacePath: root,
			memoryPath: join(root, "memory.json"),
			jikji: false,
			everything: false,
			fsearch: false,
			excludeExactDuplicates: false,
			minSync: { binaryPath: join(root, "must-not-be-executed"), autoInstall: false },
			embedder: {
				identity: async () => ({ provider: "fixture", model: "fixture", dimension: 2 }),
				embed: async (texts, options) => {
					if (failQuery && options?.role === "query") throw new Error("fixture embedding endpoint is down");
					embedded += texts.length;
					return texts.map(() => [1, 0]);
				},
				health: async () => ({ backend: "in-process", alive: true }),
				describeEndpoint: async () => undefined,
				close: async () => {},
			},
			localIndex: {
				tokenizer: { fingerprint: "test", count: (text) => text.length },
				analyzer: { fingerprint: "test", analyze: async (text) => text.toLowerCase() },
			},
		});
		const events: IndexEvent[] = [];
		const first = await agent.refresh(false, { methods: ["minsync"], onIndexEvent: (event) => events.push(event) });
		expect(first.minsync?.report?.backend).toBe("autorag");
		expect(events.some((event) => event.phase === "embed")).toBe(true);
		const hits = await agent.retrieve("director approval", { topK: 5 });
		expect(
			hits.some(
				(hit) =>
					hit.source === source && isAbsolute(hit.source) && readFileSync(hit.source, "utf8").includes("Director"),
			),
		).toBe(true);
		const before = embedded;
		const warm = await agent.refresh(false, { methods: ["minsync"] });
		expect(warm.minsync?.report?.unchanged).toBe(1);
		expect(embedded).toBe(before);
		expect(agent.refreshComponentStatus().minsync).toBe("ready");
		failQuery = true;
		const methods = agent.getRetrievalEngine().getMethodRegistry();
		const lexical = await methods.get("hybrid")!.retrieve("approval offline", { topK: 5 });
		expect(lexical.some((hit) => hit.source === source)).toBe(true);
		expect(lexical[0].metadata).toMatchObject({
			retrievalMode: "bm25",
			embeddingError: "fixture embedding endpoint is down",
		});
		await expect(methods.get("minsync")!.retrieve("approval offline", { topK: 5 })).rejects.toThrow(
			"fixture embedding endpoint is down",
		);
	});
});
