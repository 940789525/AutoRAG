import { describe, expect, it } from "vitest";
import { gradeContextTrial, gradeContextTurn } from "../../scripts/bench/context-session-grade.ts";
import { contextSessionGold, validateContextGold } from "../../scripts/bench/context-session-review.ts";

describe("single-agent source-based experiment review", () => {
	it("checks every reference fact against the authored corpus, including updated versions", () => {
		expect(validateContextGold()).toEqual({ cases: 30, turns: 120, supportedFacts: 150 });
		expect(contextSessionGold().find((task) => task.id === "M5-1")!.turns[3].facts[0].fact).toContain("832 credits");
	});
	const turn = {
		turnIndex: 0,
		status: "completed",
		answer: "The current threshold is 472 credits [1].",
		results: [
			{
				number: 1,
				source: "/fixture/policy.md",
				evidence: [{ excerpt: "The ordinary refund threshold for Orchid-1 is 472 credits." }],
			},
		],
	};
	it("requires an actually supporting cited source, not just the gold term", () => {
		expect(gradeContextTurn("M1-1", turn).status).toBe("supported_by_automated_rubric");
		expect(gradeContextTurn("M1-1", { ...turn, results: [] }).status).toBe("failed");
		expect(
			gradeContextTurn("M1-1", { ...turn, results: [{ ...turn.results[0], source: "/fixture/unrelated.md" }] })
				.status,
		).toBe("needs_review");
		expect(
			gradeContextTurn("M1-1", {
				...turn,
				results: [{ ...turn.results[0], evidence: [{ excerpt: "Garden inventory." }] }],
			}).status,
		).toBe("needs_review");
	});
	it("does not pass a negated gold amount or an unmatched citation", () => {
		expect(gradeContextTurn("M1-1", { ...turn, answer: "The threshold is not 472 credits [1]." }).status).toBe(
			"needs_review",
		);
		expect(gradeContextTurn("M1-1", { ...turn, answer: "472 credits [99]." }).status).toBe("failed");
	});
	it("keeps wording it cannot recognize and missing evidence as needs_review", () => {
		expect(
			gradeContextTurn("M1-1", { ...turn, answer: "Use the amount established by the current policy [1]." }).status,
		).toBe("needs_review");
	});
	it("does not silently pass an incomplete or failed session", () => {
		expect(gradeContextTrial({ caseId: "M1-1", status: "completed", turns: [turn] }).status).toBe("failed");
		expect(gradeContextTrial({ caseId: "M1-1", status: "failed", turns: [] }).status).toBe("failed");
	});
});
