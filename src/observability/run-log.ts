import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextSelectionReport } from "../agent/context-selection-projector.ts";
import type { RetrievalPolicy } from "../agent/query-routing.ts";

export type ModelUsageScope = "answer_session" | "pi_compaction" | "jev" | "query_decomposition" | "index_intent";

export type AutoRAGRunEvent =
	| {
			event: "model_usage";
			timestamp: string;
			sessionId: string;
			scope: ModelUsageScope;
			model: string;
			usageReported?: boolean;
			stopReason?: string;
			inputTokens: number | null;
			outputTokens: number | null;
			cacheReadTokens: number | null;
			cacheWriteTokens?: number | null;
			totalTokens?: number | null;
			cost?: number | null;
			latencyMs?: number;
			firstTokenMs?: number | null;
	  }
	| { event: "context_selection"; timestamp: string; sessionId: string; report: ContextSelectionReport }
	| {
			event: "retrieval_step";
			timestamp: string;
			sessionId: string;
			action: "baseline_prefetch" | "tool_call";
			tool?: string;
	  }
	| {
			event: "search_started";
			timestamp: string;
			sessionId: string;
			queryLength: number;
			retrievalPolicy?: RetrievalPolicy;
			model: string;
			/** All application-owned answer, judgment and decomposition calls are observed. */
			usageVersion?: 1;
	  }
	| {
			event: "search_completed";
			timestamp: string;
			sessionId: string;
			resultCount: number;
			/** True when the run ended without a final answer message and fell back to a degraded response. */
			degraded?: boolean;
	  }
	| {
			event: "search_failed";
			timestamp: string;
			sessionId: string;
			errorType: string;
	  }
	| {
			event: "cleanup_failed";
			timestamp: string;
			sessionId: string;
			failureCount: number;
			errorTypes: string[];
	  };

/** pi's all-zero fallback is not a provider usage report. Missing usage stays unknown. */
export function assistantUsageEvent(
	message: AssistantMessage | undefined,
	scope: ModelUsageScope,
	sessionId: string,
	timing: { latencyMs: number; firstTokenMs?: number },
): Extract<AutoRAGRunEvent, { event: "model_usage" }> {
	const usage = message?.usage;
	const reported = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].some(
		(value) => Number.isFinite(value) && value! > 0,
	);
	const count = (value: number | undefined) => (reported && Number.isFinite(value) && value! >= 0 ? value! : null);
	return {
		event: "model_usage",
		timestamp: new Date().toISOString(),
		sessionId,
		scope,
		model: message?.model ?? "unknown",
		usageReported: reported,
		stopReason: message?.stopReason ?? "error",
		inputTokens: count(usage?.input),
		outputTokens: count(usage?.output),
		cacheReadTokens: count(usage?.cacheRead),
		cacheWriteTokens: count(usage?.cacheWrite),
		totalTokens: count(usage?.totalTokens),
		cost: count(usage?.cost?.total),
		latencyMs: timing.latencyMs,
		firstTokenMs: timing.firstTokenMs ?? null,
	};
}

export class AutoRAGRunLogger {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	write(event: AutoRAGRunEvent): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
		} catch (error) {
			// Run logging is diagnostic only; never change search behavior for logger failures.
			void error;
		}
	}
}
