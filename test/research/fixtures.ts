import type { Evidence, PaperNote } from "../../src/research/types.ts";
export const target: Evidence = {
	id: "asset-new",
	paperId: "paper-new",
	sha256: "a".repeat(64),
	outputSha256: "b".repeat(64),
	sourceId: "/papers/new.pdf",
	source: "/fixture/new.pdf",
	evidenceId: "ev-new",
	start: 0,
	end: 8,
	text: "evidence",
};
export function note(ids = [target.evidenceId]): PaperNote {
	const claim = { text: "Evidence is insufficient for a stronger claim.", evidenceIds: ids };
	return {
		title: "Paper",
		method: claim,
		experiments: claim,
		findings: claim,
		limitations: claim,
		relationship: claim,
		comparability: "insufficient_evidence",
		priority: "optional",
		relevance: "medium",
		readingAdvice: "Check the original experimental setup.",
	};
}
