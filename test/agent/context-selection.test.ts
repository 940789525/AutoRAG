import { describe, expect, it } from "vitest";
import {
	adaptiveCutoff,
	isSimpleFactQuery,
	normalizeContextSelection,
	type SelectionCandidate,
	selectContextCandidates,
} from "../../src/agent/context-selection.ts";

function candidate(i: number, extra: Partial<SelectionCandidate> = {}): SelectionCandidate {
	return {
		key: String(i),
		source: `/docs/${i}`,
		rank: i,
		query: "q",
		profile: "p",
		cosine: 0.8,
		vector: [1, i % 2],
		tokens: 20,
		priority: 0,
		...extra,
	};
}

describe("context selection configuration and intent", () => {
	it("defaults to no policy and validates trusted configuration", () => {
		expect(normalizeContextSelection(undefined)).toBeUndefined();
		expect(normalizeContextSelection({ mode: "observe", evidenceBudgetTokens: 3 })).toEqual({
			mode: "observe",
			evidenceBudgetTokens: 3,
		});
		for (const value of [
			false,
			[],
			{ mode: 7 },
			{ mode: "automatic" },
			{ extra: true },
			{ evidenceBudgetTokens: 0 },
			{ evidenceBudgetTokens: 1.5 },
			{ evidenceBudgetTokens: Number.NaN },
		])
			expect(() => normalizeContextSelection(value)).toThrow(/contextSelection/);
	});
	it.each([
		"What is the ordinary refund threshold for Orchid?",
		"Who approves this refund?",
		"Orchid 的负责人是谁？",
		"资料保留多少天？",
	])("recognizes a bounded fact query: %s", (q) => expect(isSimpleFactQuery(q)).toBe(true));
	it.each([
		"List all owners",
		"What is the threshold and what are the exceptions?",
		"Compare the two policies",
		"总结退款政策",
		"退款有哪些例外？",
		"谁审批所有部门的退款？",
		"Explain this",
		"What is the policy?",
		"What are the refund rules?",
		"What changed during October?",
	])("keeps uncertain or exhaustive intent conservative: %s", (q) => expect(isSimpleFactQuery(q)).toBe(false));
});

describe("adaptive gap", () => {
	it("does not impose a fixed count on small or flat pools", () => {
		expect(adaptiveCutoff([])).toBe(0);
		expect(adaptiveCutoff(Array(8).fill(0.8))).toBe(8);
		expect(adaptiveCutoff(Array(100).fill(0.8))).toBe(100);
	});
	it("selects a conspicuous within-query gap with five buffered candidates", () => {
		const scores = Array.from({ length: 100 }, (_, i) => (i < 8 ? 0.9 - i * 0.001 : 0.4 - i * 0.001));
		expect(adaptiveCutoff(scores)).toBe(13);
	});
	it("ignores tail gaps, invalid scores, and non-monotonic order", () => {
		expect(adaptiveCutoff([...Array(95).fill(0.8), ...Array(5).fill(0.1)])).toBe(100);
		expect(adaptiveCutoff([Number.NaN, ...Array(20).fill(0.8)])).toBe(21);
		expect(adaptiveCutoff([0.5, 0.9, ...Array(20).fill(0.1)])).toBe(22);
	});
	it("breaks equally large gaps towards more evidence", () => {
		const scores = [...Array(3).fill(0.75), ...Array(5).fill(0.5), ...Array(12).fill(0.25)];
		expect(adaptiveCutoff(scores)).toBe(13);
	});
});

describe("budget and novelty selection", () => {
	it("handles empty, eight-item, and zero-budget pools without padding", () => {
		expect(selectContextCandidates([], 100).selected).toEqual([]);
		expect(
			selectContextCandidates(
				Array.from({ length: 8 }, (_, i) => candidate(i)),
				1000,
			).selected,
		).toHaveLength(8);
		expect(selectContextCandidates([candidate(0)], 0).selected).toEqual([]);
	});
	it("keeps the gap buffer and never interprets a normalized ranking as raw cosine", () => {
		const rows = Array.from({ length: 100 }, (_, i) => candidate(i, { cosine: i < 8 ? 0.9 : 0.1, vector: [1, 0] }));
		const selection = selectContextCandidates(rows, 10000);
		expect(selection.reasons.get("13")).toBe("gap_excluded");
		const unscored = rows.map((c) => ({ ...c, cosine: undefined }));
		expect(selectContextCandidates(unscored, 10000).selected).toHaveLength(100);
	});
	it("skips an oversized complete block but admits a later short block", () => {
		const rows = [candidate(0, { tokens: 1000 }), candidate(1, { tokens: 10 })];
		expect(selectContextCandidates(rows, 15).selected).toEqual(["1"]);
		expect(rows[0].tokens).toBe(1000);
	});
	it("does not apply gap thresholds without a reliable profile and vectors", () => {
		const rows = Array.from({ length: 100 }, (_, i) =>
			candidate(i, { cosine: i < 8 ? 0.9 : 0.1, profile: "", vector: undefined }),
		);
		const result = selectContextCandidates(rows, 10000);
		expect(result.selected).toHaveLength(100);
		expect([...result.reasons.values()]).not.toContain("gap_excluded");
	});
	it("keeps distinct chunks and versions even when their vectors are identical", () => {
		const rows = [
			candidate(0, { source: "/policy/v1", vector: [1, 0] }),
			candidate(1, { source: "/policy/v2", vector: [1, 0] }),
			candidate(2, { source: "/policy/v2", vector: [1, 0] }),
		];
		expect(selectContextCandidates(rows, 60).selected).toEqual(["0", "1", "2"]);
	});
	it("chooses novel evidence before a redundant high-scoring passage", () => {
		const rows = [
			candidate(0, { cosine: 0.9, vector: [1, 0] }),
			candidate(1, { cosine: 0.89, vector: [1, 0] }),
			candidate(2, { cosine: 0.8, vector: [0, 1] }),
		];
		expect(selectContextCandidates(rows, 40).selected).toEqual(["0", "2"]);
	});
	it("compares redundancy only within a profile and validates vector dimensions", () => {
		const rows = [
			candidate(0, { vector: [1, 0] }),
			candidate(1, { vector: [1, 0], profile: "other" }),
			candidate(2, { vector: [1, 0, 0] }),
		];
		expect(selectContextCandidates(rows, 60).selected).toHaveLength(3);
		expect(selectContextCandidates(rows, 60).fallbacks.get("2")).toBe("vector_dimension_mismatch");
	});
	it("keeps unknown scores/vectors in ranked budget fallback without embedding", () => {
		const rows = [
			candidate(0, { vector: [Number.NaN], cosine: undefined }),
			candidate(1, { vector: [], cosine: undefined }),
			candidate(2, { profile: "", cosine: undefined }),
		];
		expect(selectContextCandidates(rows, 60).selected).toHaveLength(3);
		expect(selectContextCandidates(rows, 60).fallbacks.size).toBe(3);
	});
	it("does not mark weak evidence as sufficient and stops non-positive marginal values", () => {
		const rows = [candidate(0, { cosine: 0.01, vector: [1, 0] }), candidate(1, { cosine: 0.01, vector: [1, 0] })];
		const result = selectContextCandidates(rows, 100);
		expect(result.selected).toEqual(["0"]);
		expect(result.reasons.get("1")).toBe("low_marginal_value");
		expect(result).not.toHaveProperty("sufficient");
	});
	it("buffers per-query gaps separately and gives each query a first opportunity", () => {
		const rows = [candidate(0), candidate(1, { query: "sub-query" }), candidate(2)];
		expect(selectContextCandidates(rows, 40).selected).toEqual(["0", "1"]);
		expect(selectContextCandidates(rows, 20).coverageLimited).toBe(true);
	});
	it("counts shared evidence once across query partitions", () => {
		const rows = [
			candidate(0, { evidenceKey: "same" }),
			candidate(1, { evidenceKey: "same", query: "q2" }),
			candidate(2, { query: "q2" }),
		];
		const result = selectContextCandidates(rows, 40);
		expect(result.tokens).toBe(40);
		expect(result.reasons.get("1")).toBe("duplicate");
	});
	it("gives newly requested evidence priority over old context", () => {
		const rows = [candidate(0), candidate(1), candidate(2, { priority: 1 }), candidate(3, { priority: 1 })];
		expect(selectContextCandidates(rows, 40).selected).toEqual(["2", "3"]);
	});
	it("is stable and does not change source, identity, text position or input vectors", () => {
		const rows = Array.from({ length: 10 }, (_, i) => candidate(i));
		const before = JSON.stringify(rows);
		expect(selectContextCandidates(rows, 80)).toEqual(selectContextCandidates(rows, 80));
		expect(JSON.stringify(rows)).toBe(before);
	});
});
