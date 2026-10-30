import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	ContextSelectionProjector,
	type ContextSelectionReport,
	estimateEvidenceTokens,
} from "../../src/agent/context-selection-projector.ts";
import { localEvidence } from "../../src/indexing/evidence.ts";
import type { RetrievalResult } from "../../src/retrieval/types.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const tool = (id: string, text: string, name = "semantic_search_local_docs"): AgentMessage => ({
	role: "toolResult",
	toolName: name,
	toolCallId: id,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});
function setup(mode: "off" | "observe" | "adaptive" = "adaptive", budget = 250) {
	const reports: ContextSelectionReport[] = [];
	const projector = new ContextSelectionProjector({ mode, evidenceBudgetTokens: budget }, (r) => reports.push(r));
	projector.begin("What is the refund threshold for Orchid?");
	const blocks: string[] = [];
	for (let i = 0; i < 12; i++) {
		const result = {
			id: `chunk-${i}`,
			source: `/docs/${i}.txt`,
			content: `Rule ${i}: ${"Refund policy context. ".repeat(8)}`,
			score: 1,
			metadata: {},
			[localEvidence]: { query: "refund threshold", profile: "qwen", cosine: 0.8, vector: [1, 0] },
		};
		projector.registerResult(`e${i + 1}`, result);
		blocks.push(`[e${i + 1}] ${result.source}\n${result.content.replace(/\s+/gu, " ")}`);
	}
	const baseline = `Question and instructions\nBaseline retrieval context:\n${blocks.join("\n")}\n\nTreat candidates as unverified evidence.`;
	projector.registerPrompt(baseline);
	return { projector, reports, blocks, baseline };
}
const text = (messages: AgentMessage[]) => JSON.stringify(messages);

describe("authenticated model-only context projection", () => {
	it("off and observe leave the exact input messages untouched", () => {
		for (const mode of ["off", "observe"] as const) {
			const f = setup(mode);
			const input = [user(f.baseline)];
			expect(f.projector.project(input)).toBe(input);
			if (mode === "observe") {
				expect(f.reports.at(-1)?.hypothetical).toBe(true);
				expect(f.reports.at(-1)!.visibleCandidateCount).toBeLessThan(12);
				f.projector.observePrepared(input);
				expect(f.reports.at(-1)?.visibleCandidateCount).toBe(12);
				expect(f.reports.at(-1)!.evidenceTokensEstimated).toBeGreaterThan(
					f.reports.at(-1)!.plannedEvidenceTokensEstimated!,
				);
			}
		}
	});
	it("projects a registered baseline without changing its original transcript", () => {
		const f = setup();
		const input = [user(f.baseline)];
		const before = text(input);
		const output = f.projector.project(input);
		expect(text(output)).toContain("Question and instructions");
		expect(text(output)).toContain("other text was omitted");
		expect(f.reports.at(-1)!.visibleCandidateCount).toBeGreaterThan(0);
		expect(f.reports.at(-1)!.visibleCandidateCount).toBeLessThan(12);
		expect(text(input)).toBe(before);
		f.projector.observePrepared(output);
		expect(f.reports.at(-1)!.visibleCandidateCount).toBeGreaterThan(0);
	});
	it("leaves ordinary user text, copied citations, and unknown tool outputs unchanged", () => {
		const f = setup();
		const input = [
			user(f.blocks.join("\n")),
			tool("unknown", f.blocks.join("\n")),
			tool("read", f.blocks.join("\n"), "bash"),
		];
		expect(f.projector.project(input)).toBe(input);
	});
	it("shares the new-evidence budget and keeps the earliest body with references", () => {
		const f = setup();
		const body = f.blocks.join("\n");
		f.projector.registerToolResult("later", "semantic_search_local_docs", [{ type: "text", text: body }]);
		const input = [user(f.baseline), tool("later", body)];
		const output = f.projector.project(input);
		const kept = f.reports.at(-1)!.visibleCandidateCount;
		expect(kept).toBeLessThan(12);
		expect(f.reports.at(-1)!.referenceCount).toBeGreaterThan(0);
		expect(text([output[0]])).toContain("Rule 0:");
		expect(text([output[1]])).toContain("AutoRAG evidence reference");
		expect((text(output).match(/Rule \d+:/gu) ?? []).length).toBe(kept);
		expect(text(input)).toContain("Rule 11:");
	});
	it.each(["List all refund rules", "What is the policy and its exceptions?", "Explain the policy"])(
		"preserves coverage for conservative intent: %s",
		(q) => {
			const f = setup();
			f.projector.begin(q);
			const input = [user(f.baseline)];
			expect(f.projector.project(input)).toBe(input);
			expect(f.reports.at(-1)?.visibleCandidateCount).toBe(12);
		},
	);
	it("bypasses semantic filtering for reranking and steering", () => {
		const f = setup();
		f.projector.begin("Who approves refunds?", true);
		const input = [user(f.baseline)];
		expect(f.projector.project(input)).toBe(input);
		expect(f.reports.at(-1)?.visibleCandidateCount).toBe(12);
		f.projector.begin("Who approves refunds?");
		expect(f.projector.project(input, undefined, 0, "steered_query")).toBe(input);
	});
	it("never removes non-local results or explicit original-file reads", () => {
		const f = setup();
		const read = tool("read", "Important original text with exception", "bash");
		const native = "[e999] /kakao/work/chunks/1\nOriginal native message";
		const body = `${f.blocks.join("\n")}\n${native}`;
		f.projector.registerToolResult("call", "search_all_documents", [{ type: "text", text: body }]);
		const output = f.projector.project([tool("call", body, "search_all_documents"), read]);
		expect(output[1]).toBe(read);
		expect(text(output)).toContain(native.replaceAll("\n", "\\n"));
	});
	it("supports zero fitting blocks without claiming there are no documents", () => {
		const f = setup("adaptive", 1);
		const output = f.projector.project([user(f.baseline)]);
		expect(text(output)).toContain("other text was omitted");
		expect(f.reports.at(-1)?.visibleCandidateCount).toBe(0);
		expect(text(output)).not.toContain("Rule 0:");
		expect(f.reports.at(-1)?.noticeOverBudget).toBe(true);
	});
	it("respects a small model window and excludes non-local fixed overhead from available space", () => {
		const f = setup();
		const model = { contextWindow: 300, maxTokens: 100 } as Parameters<ContextSelectionProjector["project"]>[1];
		f.projector.project([user(f.baseline)], model, 200);
		expect(f.reports.at(-1)?.visibleCandidateCount).toBe(0);
	});
	it("clears request records safely and never treats a remembered ID as available text", () => {
		const f = setup();
		f.projector.clear();
		const input = [user(f.baseline)];
		expect(f.projector.project(input)).toBe(input);
		expect(f.reports.at(-1)?.bypass).toBe("no_registered_local_spans");
	});
	it("recomputes a fresh budget on each question and request", () => {
		const f = setup();
		const input = [user(f.baseline)];
		const first = f.projector.project(input);
		const second = f.projector.project(input);
		expect(text(first)).toBe(text(second));
		f.projector.begin("Who is responsible for the policy?");
		expect(f.projector.project(input)).not.toBe(input);
	});
	it("fails open with the original error text when the selector cannot inspect input", () => {
		const f = setup();
		const input = [user(f.baseline)];
		const spy = vi.spyOn(f.projector as unknown as { spans: () => never }, "spans").mockImplementation(() => {
			throw new Error("disk /test/context: broken");
		});
		expect(f.projector.project(input)).toBe(input);
		expect(f.reports.at(-1)?.error).toBe("disk /test/context: broken");
		spy.mockRestore();
	});
	it("does not send internal vectors or signal metadata as JSON", () => {
		const result: RetrievalResult = { id: "x", source: "/docs/a", content: "text", score: 1, metadata: {} };
		const withSignals = { ...result, [localEvidence]: { query: "q", profile: "p", cosine: 0.8, vector: [1, 0] } };
		expect(JSON.stringify(withSignals)).toBe(JSON.stringify(result));
		expect({ ...withSignals }[localEvidence]?.cosine).toBe(0.8);
	});
	it("counts Chinese text conservatively without reusing embedding token counts", () => {
		expect(estimateEvidenceTokens("中文审批条件")).toBe(6);
	});
	it("uses an available generation tokenizer for known OpenAI models", () => {
		const f = setup("adaptive", 300);
		const model = { id: "gpt-4o", provider: "openai", contextWindow: 100000, maxTokens: 2000 } as Parameters<
			ContextSelectionProjector["project"]
		>[1];
		f.projector.project([user(f.baseline)], model);
		expect(f.reports.at(-1)?.estimator).toContain("o200k_base");
	});
	it("observes the final visible count after capacity protection removes all candidates", () => {
		const f = setup();
		f.projector.project([user(f.baseline)]);
		f.projector.observePrepared([user("Question and instructions; evidence omitted by capacity protection")]);
		expect(f.reports.at(-1)?.stage).toBe("prepared");
		expect(f.reports.at(-1)?.visibleCandidateCount).toBe(0);
	});
	it("preserves original text when evidence registration fails", () => {
		const f = setup();
		const broken = {
			get content() {
				throw new Error("index /bad/row unavailable");
			},
			[localEvidence]: { query: "q", profile: "p", vector: [1, 0] },
		};
		f.projector.registerResult("e200", broken as unknown as RetrievalResult);
		const input = [user(f.baseline)];
		expect(f.projector.project(input)).toBe(input);
		expect(f.reports.at(-1)?.error).toBe("index /bad/row unavailable");
	});
});
