export interface AssetRevision {
	id: string;
	paperId: string;
	sha256: string;
	sourceId: string;
	source: string;
	outputSha256: string;
}

export interface Topic {
	id: string;
	library_id: string;
	title: string;
	question: string;
	focus: string[];
	exclusions: string[];
	revision: number;
	active: boolean;
}

export interface Evidence extends AssetRevision {
	evidenceId: string;
	start: number;
	end: number;
	text: string;
}

export interface Claim {
	text: string;
	evidenceIds: string[];
}

export interface PaperNote {
	title: string;
	method: Claim;
	experiments: Claim;
	findings: Claim;
	limitations: Claim;
	relationship: Claim;
	comparability: "comparable" | "different_conditions" | "insufficient_evidence";
	readingAdvice: string;
	priority: "read_first" | "optional" | "defer" | "needs_review";
	relevance: "high" | "medium" | "low" | "uncertain";
}

export interface ReadingInput {
	target: AssetRevision;
	topic: Topic;
	baseline: AssetRevision[];
}

export interface ReadingResult {
	note: PaperNote;
	evidence: Evidence[];
	coverage: { baselineWorks: number; retrievedWorks: number; excerptCount: number; partial: boolean };
	usage?: { requests: number; inputTokens: number; outputTokens: number; cost: number };
	diagnostics?: string[];
}

export const TERMINAL_RUNS = ["not_selected", "deferred", "succeeded", "needs_review", "failed", "cancelled"];

export class ResearchError extends Error {
	readonly statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
