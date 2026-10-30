import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { ContextV1Adapter } from "../../scripts/bench/context-v1-adapter.ts";
import { ContextSelectionProjector } from "../../src/agent/context-selection-projector.ts";
import { localEvidence } from "../../src/indexing/evidence.ts";

describe("recovered historical v1 control", () => {
	it("keeps its frozen runtime files consistent with their recovery manifest", () => {
		const root = new URL("../../scripts/bench/historical/", import.meta.url);
		const manifest = JSON.parse(readFileSync(new URL("provenance.json", root), "utf8"));
		for (const [name, entry] of Object.entries(manifest.files) as [string, { runtimeSha256: string }][]) {
			expect(
				createHash("sha256")
					.update(readFileSync(new URL(name, root)))
					.digest("hex"),
			).toBe(entry.runtimeSha256);
		}
	});
	it("executes historical latest-copy selection while v2 preserves the already-sent prefix", () => {
		const body = `The refund threshold is 472 credits. ${"Verbatim policy details. ".repeat(50)}`;
		const result = {
			id: "chunk",
			source: "/docs/policy.txt",
			content: body,
			score: 1,
			metadata: {},
			[localEvidence]: { query: "refund threshold", profile: "local", cosine: 0.99, vector: [1, 0] },
		};
		for (const historical of [true, false]) {
			const p = historical
				? new ContextV1Adapter(() => {})
				: new ContextSelectionProjector({ mode: "adaptive", evidenceBudgetTokens: 6000 });
			p.begin("What is the refund threshold?");
			p.registerResult("e1", result);
			const make = (callId: string): AgentMessage => {
				const text = `[e1] /docs/policy.txt\n${body}\n\n`;
				p.registerToolResult(callId, "semantic_search_local_docs", [{ type: "text", text }]);
				return {
					role: "toolResult",
					toolName: "semantic_search_local_docs",
					toolCallId: callId,
					timestamp: 0,
					content: [{ type: "text", text }],
					isError: false,
				};
			};
			const raw = [make("first")];
			const first = p.finalize(p.project(raw));
			p.observePrepared(first);
			p.dispatch(first);
			p.settle(true);
			p.begin("What is the refund threshold?");
			p.registerResult("e1", result);
			raw.push({ role: "user", content: "What is the refund threshold?", timestamp: 1 }, make("second"));
			const next = p.project(raw);
			if (historical) {
				expect(next[0]).not.toEqual(first[0]);
				expect(JSON.stringify(next.at(-1))).toContain("472 credits");
			} else {
				expect(next[0]).toEqual(first[0]);
				expect(JSON.stringify(next.at(-1))).toContain("AutoRAG evidence reference");
			}
		}
	});
});
