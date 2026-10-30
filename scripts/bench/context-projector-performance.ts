/** Offline CPU measurement, with synthetic trusted local hits and no model or embedding requests. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextSelectionProjector } from "../../src/agent/context-selection-projector.ts";
import { type LocalEvidenceResult, localEvidence } from "../../src/indexing/evidence.ts";
import { percentile } from "./context-session-metrics.ts";

const output = resolve(process.argv[2] ?? ".omo/evidence/context-completion-projector-performance.json");
const body = "Refund exceptions require director approval before payout. ".repeat(20);
const samples: number[] = [];
const selectionSamples: number[] = [];
for (let iteration = 0; iteration < 220; iteration++) {
	const projector = new ContextSelectionProjector({ mode: "adaptive", evidenceBudgetTokens: 6000 }, (report) => {
		if (iteration >= 20 && report.stage === "selection") selectionSamples.push(report.durationMs);
	});
	projector.begin("List all refund policies and exceptions");
	const started = performance.now();
	const text = `Local results:\n\n${Array.from({ length: 100 }, (_, index) => {
		const id = `e${index + 1}`;
		const source = `/synthetic/policy-${index}.txt`;
		const result: LocalEvidenceResult = {
			id: `chunk-${index}`,
			source,
			content: body,
			score: 0.9,
			metadata: {},
			[localEvidence]: { query: "refund", profile: "synthetic", cosine: 0.9, vector: [1, 0] },
		};
		projector.registerResult(id, result);
		return `[${id}] ${source} score=0.9000\n${body}\n\n`;
	}).join("")}`;
	const messages: AgentMessage[] = [
		{ role: "user", content: "List all refund policies and exceptions", timestamp: 0 },
	];
	for (let turn = 0; turn < 2; turn++) {
		const call = `synthetic-${turn}`;
		const toolName = "semantic_search_local_docs";
		const content = [{ type: "text" as const, text }];
		projector.registerToolResult(call, toolName, content);
		messages.push({ role: "toolResult", toolCallId: call, toolName, content, isError: false, timestamp: turn });
		const prepared = projector.finalize(projector.project(messages));
		projector.observePrepared(prepared);
		projector.dispatch(prepared);
		projector.settle(true);
	}
	if (iteration >= 20) samples.push(performance.now() - started);
}
const report = {
	kind: "offline-projector-cpu-measurement",
	realGeneration: false,
	candidates: 100,
	bodyBytesPerCandidate: Buffer.byteLength(body),
	warmupIterations: 20,
	measuredIterations: samples.length,
	selectionP50Ms: percentile(selectionSamples, 0.5),
	selectionP95Ms: percentile(selectionSamples, 0.95),
	registrationAndTwoDispatchesP50Ms: percentile(samples, 0.5),
	registrationAndTwoDispatchesP95Ms: percentile(samples, 0.95),
	selectionUnder10Ms: percentile(selectionSamples, 0.95)! < 10,
	conditions:
		"Shared host; warmed process; 100 synthetic local candidates, followed by an identical retrieval; no provider, embedding, disk reads or model capacity intervention. Selection duration is distinct from end-to-end CPU duration.",
	projectorSha256: createHash("sha256")
		.update(readFileSync(new URL("../../src/agent/context-selection-projector.ts", import.meta.url)))
		.digest("hex"),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
