import { describe, expect, it } from "vitest";
import { contextSessionCases } from "../../scripts/bench/context-session-cases.ts";

describe("frozen non-sensitive multi-turn experiment specifications", () => {
	it("provides thirty deterministic families and a 12/18 family-disjoint split", () => {
		const cases = contextSessionCases();
		expect(cases).toEqual(contextSessionCases());
		expect(cases).toHaveLength(30);
		expect(new Set(cases.map((task) => task.family)).size).toBe(30);
		expect(cases.filter((task) => task.split === "dev")).toHaveLength(12);
		expect(cases.filter((task) => task.split === "test")).toHaveLength(18);
		for (let i = 1; i <= 6; i++) {
			const group = cases.filter((task) => task.group === `M${i}`);
			expect(group).toHaveLength(5);
			expect(group.filter((task) => task.split === "dev")).toHaveLength(2);
			for (const task of group) {
				expect(task.turns.length).toBeGreaterThanOrEqual(4);
				expect(task.turns.length).toBeLessThanOrEqual(8);
				expect(task.documents.every((doc) => !doc.name.includes("/") && doc.text.includes(task.family))).toBe(true);
				expect(task.turns.every((turn) => turn.goldTerms.length > 0)).toBe(true);
			}
		}
	});
	it("covers version conflicts, multi-source evidence, capacity pressure and lifecycle actions", () => {
		const cases = contextSessionCases();
		expect(cases.find((task) => task.group === "M2")!.documents.some((doc) => doc.name === "retired-policy.md")).toBe(
			true,
		);
		expect(cases.find((task) => task.group === "M3")!.documents.some((doc) => doc.name === "retention.md")).toBe(
			true,
		);
		expect(cases.find((task) => task.group === "M4")!.documents.length).toBeGreaterThan(10);
		expect(
			cases
				.find((task) => task.group === "M5")!
				.turns.map((turn) => turn.action)
				.filter(Boolean),
		).toEqual(["compact", "update"]);
		expect(cases.find((task) => task.group === "M6")!.documents.some((doc) => doc.text.includes("| Rule |"))).toBe(
			true,
		);
	});
});
