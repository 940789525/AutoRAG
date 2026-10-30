import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataset = JSON.parse(readFileSync(new URL("../fixtures/context-selection/cases.json", import.meta.url), "utf8"));
describe("frozen synthetic context selection fixtures", () => {
	it("provides six 20-case groups with disjoint development and test families", () => {
		expect(dataset.cases).toHaveLength(120);
		const families = new Map<string, string>();
		for (let i = 1; i <= 6; i++) {
			const group = dataset.cases.filter((c: { group: string }) => c.group === `G${i}`);
			expect(group).toHaveLength(20);
			expect(group.filter((c: { split: string }) => c.split === "dev")).toHaveLength(8);
			for (const c of group) {
				expect(families.has(c.family)).toBe(false);
				families.set(c.family, c.split);
			}
		}
	});
	it("grounds gold facts in supplied documents, marks no-answer cases, and discloses pending independent review", () => {
		expect(dataset.independentHumanReview).toBe("pending");
		for (const c of dataset.cases) {
			const docs = new Set(c.documents.map((d: { id: string }) => d.id));
			for (const f of c.gold.facts) for (const id of f.evidenceDocumentIds) expect(docs.has(id)).toBe(true);
			if (c.group === "G5") {
				expect(c.gold.answerable).toBe(false);
				expect(c.gold.facts).toHaveLength(0);
			}
		}
	});
});
