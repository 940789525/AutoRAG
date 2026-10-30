/** Isolated real-local-embedding + faux-provider request verification; never claims real answer quality. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const output = resolve(process.argv[2] ?? ".omo/evidence/context-selection-local.json");
const defaultConfig = join(homedir(), ".autorag", "config.json");
const hashConfig = () =>
	existsSync(defaultConfig) ? createHash("sha256").update(readFileSync(defaultConfig)).digest("hex") : "absent";
const before = hashConfig();
const root = mkdtempSync(join(tmpdir(), "autorag-context-live-"));
const saved = Object.fromEntries(
	["AUTORAG_HOME", "AUTORAG_CONFIG", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
);
process.env.AUTORAG_HOME = join(root, "home");
process.env.AUTORAG_CONFIG = join(root, "config.json");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
mkdirSync(process.env.AUTORAG_HOME);
assert(process.env.AUTORAG_CONFIG.startsWith(root + "/"));
console.log(`QA config: ${process.env.AUTORAG_CONFIG}`);

let cleanupRuntime = async () => {};
const evidence: Record<string, unknown> = {
	kind: "real-local-embedding-and-faux-provider",
	realGeneration: false,
	releaseGate: "not_evaluated",
	beforeConfigHash: before,
	implementationSha256: createHash("sha256")
		.update(
			[
				"agent/context-selection.ts",
				"agent/context-selection-projector.ts",
				"agent/agent.ts",
				"agent/pi-session.ts",
				"agent/evidence-ledger.ts",
				"indexing/evidence.ts",
				"indexing/method.ts",
				"indexing/pipeline.ts",
				"indexing/lance-store.ts",
				"indexing/types.ts",
				"cli/config.ts",
				"observability/run-log.ts",
			]
				.map((p) => p + "\n" + readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8"))
				.join("\n"),
		)
		.digest("hex"),
};
try {
	const { AutoRAGAgent } = await import("../../src/agent/agent.ts");
	const { createEmbedderFromConfig, releaseEmbedders } = await import("../../src/embedding/index.ts");
	const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
	const { registerFauxProvider } = await import("@earendil-works/pi-ai/compat");
	const docs = join(root, "docs");
	mkdirSync(docs);
	const source = join(docs, "refund-policy.txt");
	writeFileSync(
		source,
		"# Orchid refund policy\n\nThe ordinary refund threshold for Orchid is 472 credits. Refund exceptions require director approval before payout.\n",
	);
	const longSource = join(docs, "long-policy.txt");
	const longBody = `${"The long refund policy requires director approval for all refund exceptions. ".repeat(30)}FULL_BODY_END`;
	writeFileSync(longSource, longBody);
	for (let i = 0; i < 105; i++)
		writeFileSync(
			join(docs, `garden-${i}.txt`),
			`# Garden inventory ${i}\n\nThe Lotus-${i} garden has ${100 + i} chairs and ${20 + i} pots. Inspect irrigation valves every Monday. The maintenance coordinator is Garden-${i}.\n`,
		);
	writeFileSync(
		process.env.AUTORAG_CONFIG,
		JSON.stringify({
			workspacePath: root,
			searchPaths: [docs],
			minSync: { autoInstall: false },
			jikji: false,
			everything: false,
			fsearch: false,
		}),
	);
	const embedder = createEmbedderFromConfig({});
	let embeddingCalls = 0;
	const countedEmbedder = new Proxy(embedder, {
		get(target, key) {
			if (key === "embed")
				return (...args: Parameters<typeof embedder.embed>) => {
					embeddingCalls++;
					return target.embed(...args);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	cleanupRuntime = releaseEmbedders;
	const health = await embedder.health();
	assert(health.alive && health.backend !== "remote", JSON.stringify(health));
	const identity = await embedder.identity();
	assert.equal(identity.model, "Qwen/Qwen3-Embedding-0.6B");
	assert.equal(identity.dimension, 1024);
	evidence.embedding = { backend: health.backend, ...identity, remote: false };
	const registration = registerFauxProvider({
		api: `faux-context-qa-${process.pid}`,
		models: [{ id: "qa-reader", contextWindow: 100_000, maxTokens: 2000 }],
	});
	cleanupRuntime = async () => {
		registration.unregister();
		await releaseEmbedders();
	};
	const requests: string[] = [];
	const response = (context: { messages: readonly unknown[] }) => {
		requests.push(
			JSON.stringify(
				context.messages.map((message) => {
					const { role, content } = message as { role: string; content: unknown };
					return { role, content };
				}),
			),
		);
		return fauxAssistantMessage("Request capture completed; no answer quality assertion.");
	};
	const base = {
		model: registration.getModel(),
		apiKey: "faux",
		embedder: countedEmbedder,
		...(process.env.AUTORAG_QA_TOKENIZER_PATH
			? { localIndex: { tokenizerPath: process.env.AUTORAG_QA_TOKENIZER_PATH } }
			: {}),
		searchPaths: [docs],
		workspacePath: root,
		minSync: { autoInstall: false },
		jikji: false as const,
		everything: false as const,
		fsearch: false as const,
		webSearch: false as const,
		dupey: false as const,
		jev: false as const,
		rerank: false as const,
		memoryEmbedder: false as const,
		permissionMode: "full" as const,
	};
	const setup = new AutoRAGAgent({ ...base, memoryPath: join(root, "setup", "memory.json") });
	const refresh = await setup.refresh(false, { methods: ["minsync"] });
	assert.equal(refresh.minsync?.ok, true);
	const hits = await setup.retrieve("What is the ordinary refund threshold for Orchid?", { topK: 100 });
	const hit = hits.find((h) => h.source === source);
	assert(hit);
	assert(isAbsolute(hit.source));
	assert.match(readFileSync(hit.source, "utf8"), /472 credits/);
	evidence.index = {
		report: refresh.minsync?.report,
		candidateCount: hits.length,
		semanticHit: true,
		sourceAbsoluteAndReadable: true,
	};
	const modes: Record<string, unknown> = {};
	for (const mode of ["off", "observe", "adaptive"] as const) {
		registration.setResponses([response]);
		const memory = join(root, mode, "memory.json");
		const agent = new AutoRAGAgent({
			...base,
			memoryPath: memory,
			contextSelection: { mode, evidenceBudgetTokens: 1500 },
		});
		const start = performance.now();
		await agent.searchDocuments("What is the ordinary refund threshold for Orchid?");
		const request = requests.at(-1)!;
		const count = (request.match(/\[e\d+\] \/[^\n]*?\\n/gu) ?? []).length;
		const events = readFileSync(join(dirname(memory), "logs", "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		modes[mode] = {
			requestBytes: Buffer.byteLength(request),
			capturedOccurrences: count,
			answerProvider: "faux",
			durationMs: performance.now() - start,
			selection: events.filter((e) => e.event === "context_selection").map((e) => e.report),
		};
	}
	assert(requests[0] === requests[1], "observe must not alter normalized provider role/content");
	assert(requests[2].length < requests[0].length);
	assert(requests[2].includes("472 credits"), "the relevant original evidence must remain visible");
	// Exercise real local retrieval across a bound conversation; the answering provider remains simulated.
	const agent = new AutoRAGAgent({
		...base,
		memoryPath: join(root, "multi", "memory.json"),
		contextSelection: { mode: "adaptive", evidenceBudgetTokens: 1500 },
	});
	const runtime = await agent.createPiInteractiveRuntime();
	try {
		const start = requests.length;
		registration.setResponses([
			response,
			(context) => {
				response(context);
				return fauxAssistantMessage(
					fauxToolCall("search_all_documents", {
						query: "What is the ordinary refund threshold for Orchid?",
					}),
					{ stopReason: "toolUse" },
				);
			},
			response,
			(context) => {
				response(context);
				return fauxAssistantMessage(
					fauxToolCall("search_all_documents", {
						query: "What is the ordinary refund threshold for Orchid?",
					}),
					{ stopReason: "toolUse" },
				);
			},
			response,
		]);
		await agent.searchDocuments("List all refund policies and garden inventory information.");
		await agent.searchDocuments("Search the refund policy sources again.");
		await agent.searchDocuments("Search the same refund policy sources one more time.");
		const turns = requests.slice(start).map((text) => JSON.parse(text) as { role: string; content: unknown }[]);
		assert.equal(turns.length, 5);
		for (let i = 1; i < turns.length; i++)
			assert.deepEqual(turns[i].slice(0, turns[i - 1].length), turns[i - 1], "previous provider prefix changed");
		const final = JSON.stringify(turns.at(-1));
		assert(final.includes("AutoRAG evidence reference"), "repeated hits must produce compact references");
		assert(final.includes("472 credits"), "original policy evidence must remain visible");
		evidence.multiTurn = {
			userTurns: 3,
			providerRequests: turns.length,
			prefixStable: true,
			references: (final.match(/AutoRAG evidence reference/gu) ?? []).length,
			requestBytes: turns.map((turn) => Buffer.byteLength(JSON.stringify(turn))),
			realGeneration: false,
			actualCacheHit: "not_measured",
		};
		const { evidenceLedger, tools } = agent as unknown as {
			evidenceLedger: import("../../src/agent/evidence-ledger.ts").EvidenceLedger;
			tools: readonly import("@earendil-works/pi-agent-core").AgentTool[];
		};
		const searchTool = tools.find((tool) => tool.name === "semantic_search_local_docs")!;
		await searchTool.execute("long-source-qa", { query: "long refund policy requires director approval" } as never);
		const entry = evidenceLedger
			.localReadEntries()
			.find((item) => item.source === longSource && item.content.startsWith("The long refund policy"));
		assert(entry, "long local evidence must have a verified locator");
		runtime.runtime.session.settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
		});
		registration.setResponses([
			fauxAssistantMessage("## Goal\nRead complete local policy evidence.\n## Progress\nEvidence IDs are retained."),
			fauxAssistantMessage("Original policy evidence may be read again."),
		]);
		await runtime.runtime.session.compact();
		const beforeReadEmbeddings = embeddingCalls;
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("read_local_evidence", { evidenceId: entry.id }), { stopReason: "toolUse" }),
			response,
		]);
		await agent.searchDocuments(`Restore the complete original text of evidence ${entry.id}.`);
		const restored = requests.at(-1)!;
		assert(restored.includes("AutoRAG complete local evidence:") && restored.includes("FULL_BODY_END"));
		assert.equal(embeddingCalls, beforeReadEmbeddings, "explicit evidence restoration must not embed again");
		const readTool = tools.find((tool) => tool.name === "read_local_evidence")!;
		const complete = await readTool.execute("read-whole-qa", { evidenceId: entry.id } as never);
		const details = complete.details as { text: string; bodySha256: string; complete: boolean };
		assert.equal(details.text, longBody);
		assert(details.text.length > 2000);
		assert(details.complete);
		assert.equal(details.bodySha256, createHash("sha256").update(longBody).digest("hex"));
		writeFileSync(longSource, longBody.replace("director", "DIRECTOR"));
		await assert.rejects(readTool.execute("changed-source-qa", { evidenceId: entry.id } as never), /version changed/);
		evidence.restoration = {
			afterPiCompaction: true,
			completeBodyBytes: Buffer.byteLength(details.text),
			bodySha256: details.bodySha256,
			additionalEmbeddingCalls: embeddingCalls - beforeReadEmbeddings,
			changedSourceRejected: true,
			realGeneration: false,
		};
	} finally {
		await runtime.dispose();
	}

	evidence.modes = modes;
	evidence.status = "pass";
} catch (error) {
	evidence.status = "blocked_or_failed";
	evidence.error = error instanceof Error ? error.stack : String(error);
	process.exitCode = 1;
} finally {
	await cleanupRuntime();
	evidence.afterConfigHash = hashConfig();
	evidence.configUnchanged = before === evidence.afterConfigHash;
	if (before !== evidence.afterConfigHash) {
		evidence.status = "failed";
		evidence.error = "Default home config hash changed during isolated QA";
		process.exitCode = 1;
	}
	rmSync(root, { recursive: true, force: true });
	evidence.cleanup = { temporaryRootRemoved: !existsSync(root), existingDaemonUntouched: true };
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
	console.log(
		JSON.stringify({
			status: evidence.status,
			error: evidence.error,
			output,
			realGeneration: false,
			configUnchanged: evidence.configUnchanged,
			cleanup: evidence.cleanup,
		}),
	);
}
