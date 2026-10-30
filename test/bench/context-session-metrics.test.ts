import { describe, expect, it } from "vitest";
import { percentile, summarizeContextTrials } from "../../scripts/bench/context-session-metrics.ts";

describe("paired session experiment metrics", () => {
	it("reports percentiles and never treats repeat trials as independent sessions", () => {
		expect(percentile([], 0.5)).toBeNull();
		expect(percentile([1, 3], 0.5)).toBe(2);
		const trials = Array.from({ length: 3 }, (_, repeat) => [
			{ caseId: "one", variant: "E", repeat, status: "completed", cost: 10 },
			{ caseId: "one", variant: "F", repeat, status: "completed", cost: 8 },
		]).flat();
		const result = summarizeContextTrials(trials).comparisons.find(
			(row) => row.baseline === "E" && row.metric === "cost",
		)!;
		expect(result.totalPairs).toBe(3);
		expect(result.independentCases).toBe(1);
		expect(result.bootstrap95).toBeNull();
		expect(result.interpretation).toBe("insufficient_independent_cases");
	});
	it("retains failed/missing coverage instead of imputing free calls or dropping failures", () => {
		const summary = summarizeContextTrials([
			{ caseId: "one", variant: "E", repeat: 0, status: "completed", cost: 10 },
			{ caseId: "one", variant: "F", repeat: 0, status: "failed", cost: null },
			{ caseId: "two", variant: "B", repeat: 0, status: "blocked" },
		]);
		expect(summary.variants.find((row) => row.variant === "F")).toMatchObject({
			failed: 1,
			costP50: null,
			costCoverage: 0,
		});
		expect(summary.variants.find((row) => row.variant === "B")).toMatchObject({ blocked: 1 });
		expect(summary.comparisons.find((row) => row.baseline === "E" && row.metric === "cost")).toMatchObject({
			totalPairs: 1,
			missingOrFailed: 1,
			independentCases: 0,
		});
	});
	it("uses a deterministic case-cluster bootstrap and keeps the quality gate separate", () => {
		const trials = ["one", "two", "three"].flatMap((caseId) => [
			{ caseId, variant: "E", repeat: 0, status: "completed", cost: 10 },
			{ caseId, variant: "F", repeat: 0, status: "completed", cost: 8 },
		]);
		const a = summarizeContextTrials(trials);
		expect(a).toEqual(summarizeContextTrials(trials));
		expect(a.comparisons.find((row) => row.baseline === "E" && row.metric === "cost")).toMatchObject({
			independentCases: 3,
			bootstrap95: [-0.2, -0.2],
			interpretation: "descriptive_change_requires_quality_gate",
		});
	});
	it("retains the reported cost of failed attempts outside completed-session comparisons", () => {
		const summary = summarizeContextTrials([
			{ caseId: "one", variant: "F", repeat: 0, status: "failed", cost: 2 },
			{ caseId: "two", variant: "F", repeat: 0, status: "completed", cost: 3 },
			{ caseId: "three", variant: "F", repeat: 0, status: "failed", cost: null },
		]);
		expect(summary.variants[0]).toMatchObject({
			costP50: 3,
			reportedAttemptCostSum: 5,
			failedReportedCostSum: 2,
			missingAttemptCost: 1,
		});
	});
});
