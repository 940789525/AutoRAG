import { randomUUID } from "node:crypto";
import type { Evidence, PaperNote, Topic } from "./types.ts";

export interface ResearchLibrary {
	id: string;
	name: string;
	state: string;
	root_path: string;
}
export interface ResearchRun {
	id: string;
	state: string;
	asset_id: string;
	topic_snapshot: Topic;
	error?: string;
	result?: unknown;
}
export interface ResearchBatch {
	id: string;
	kind: string;
	status: string;
	counts: { added?: number; duplicates?: number; pending?: number };
	error?: string;
	items?: { path: string; stage: string; error?: string }[];
	progress?: {
		phase: string;
		startedAt: string;
		updatedAt: string;
		ownerAlive: boolean;
		sourceFiles?: { total: number };
		parsedCounts?: { scanned: number };
		indexing?: { phase: string; state: string; count?: number; elapsedMs: number; durationMs?: number };
		error?: string;
	};
}
export interface ResearchOverview {
	libraries: ResearchLibrary[];
	topics: Topic[];
	unread: number;
	runs: ResearchRun[];
	batches: ResearchBatch[];
	modelProcessingEnabled: boolean;
}
export interface InboxSummary {
	id: string;
	title: string;
	priority: string;
	review_state: string;
	validity: string;
}
export interface InboxCard extends InboxSummary {
	payload: PaperNote;
	evidence: Evidence[];
	verificationError?: string;
}
export interface ResearchPaper {
	id: string;
	title: string;
	assets: { id: string; state: string; source_path?: string }[];
}

/** The TUI talks only to a local service; redirects must never forward paper/topic data elsewhere. */
export class ResearchClient {
	readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
		const url = new URL(baseUrl);
		if (
			url.protocol !== "http:" ||
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/"
		)
			throw new Error("Research URL must be an HTTP loopback origin, such as http://127.0.0.1:8765");
		this.baseUrl = url.origin;
		this.fetchImpl = fetchImpl;
	}
	async request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
		const response = await this.fetchImpl(`${this.baseUrl}/research/v1${path}`, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
						body: JSON.stringify(body),
					}),
		});
		const text = await response.text();
		if (!response.ok) {
			let reason = text;
			try {
				reason = (JSON.parse(text) as { error?: string }).error ?? text;
			} catch {
				/* Preserve a non-JSON server diagnostic. */
			}
			throw new Error(`Research HTTP ${response.status}: ${reason}`);
		}
		return JSON.parse(text) as T;
	}
	overview(signal?: AbortSignal): Promise<ResearchOverview> {
		return this.request("/overview", undefined, signal);
	}
}
