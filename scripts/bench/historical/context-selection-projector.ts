import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getEncoding } from "js-tiktoken";
import { type LocalEvidence, type LocalEvidenceResult, localEvidence } from "../../../src/indexing/evidence.ts";
import type { RetrievalResult } from "../../../src/retrieval/types.ts";
import {
	CONTEXT_SELECTION_VERSION,
	type ContextSelectionConfig,
	isSimpleFactQuery,
	normalizeContextSelection,
	type SelectionCandidate,
	selectContextCandidates,
} from "./context-selection.ts";
import { estimateContextMessageTokens, MAX_OUTPUT_TOKENS } from "../../../src/agent/context-token-guard.ts";

const MAX_RECORDS = 1024;
const MAX_REGISTERED_TEXT = 256_000;
export const estimateEvidenceTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
const encodings = new Map<string, ReturnType<typeof getEncoding>>();
function tokenCounter(model?: Model<Api>): { count: (text: string) => number; name: string } {
	const id =
		model?.provider === "openai" || model?.id?.startsWith("openai/") ? model.id.replace(/^openai\//u, "") : "";
	const encoding = /^(?:gpt-4o|gpt-4\.1)(?:-|$)/u.test(id)
		? "o200k_base"
		: /^(?:gpt-4-turbo|gpt-3\.5-turbo)(?:-|$)/u.test(id)
			? "cl100k_base"
			: undefined;
	if (!encoding) return { count: estimateEvidenceTokens, name: "utf8-div3-v1" };
	let tokenizer = encodings.get(encoding);
	if (!tokenizer) {
		tokenizer = getEncoding(encoding);
		encodings.set(encoding, tokenizer);
	}
	return { count: (text) => tokenizer.encode(text, [], []).length, name: `js-tiktoken-1.0.21-${encoding}` };
}
const marker = (total: number, kept: number): string =>
	`\n[AutoRAG context selection: showing ${kept} of ${total} local candidate occurrences; other text was omitted from this request, not judged irrelevant. Refine the query or read source files if evidence is insufficient.]\n`;

interface RecordEntry {
	readonly source: string;
	readonly body: string;
	readonly signals: { signal: LocalEvidence; turn: number }[];
}
interface Span {
	readonly id: string;
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly message: number;
	readonly block: number;
}
export interface ContextSelectionReport {
	readonly stage: "selection" | "prepared";
	readonly version: string;
	readonly mode: string;
	readonly queryId: string;
	readonly questionTurn: number;
	readonly estimator: string;
	readonly hypothetical: boolean;
	readonly candidateCount: number;
	readonly visibleCandidateCount: number;
	readonly plannedVisibleCandidateCount?: number;
	readonly evidenceTokensEstimated: number;
	readonly plannedEvidenceTokensEstimated?: number;
	readonly budget: number;
	readonly durationMs: number;
	readonly coverageLimited?: boolean;
	readonly bypass?: string;
	readonly error?: string;
	readonly noticeOverBudget?: boolean;
	readonly efficiencyBudgetExceeded?: boolean;
	readonly partitions?: readonly { queryId: string; profile: string; scope?: string }[];
	readonly decisions?: readonly { id: string; reason: string }[];
	readonly fallbacks?: readonly { id: string; reason: string }[];
}

/** Bounded, ephemeral records authenticate text spans; arbitrary user/tool text is never parsed as evidence. */
export class ContextSelectionProjector {
	readonly config: ContextSelectionConfig;
	private readonly report?: (report: ContextSelectionReport) => void;
	private readonly records = new Map<string, RecordEntry>();
	private readonly prompts = new Set<string>();
	private readonly toolResults = new Map<string, { name: string; text: string }>();
	private query = "";
	private turn = 0;
	private rerank = false;
	private lastReport: ContextSelectionReport | undefined;
	private countTokens = estimateEvidenceTokens;
	private registrationError: string | undefined;
	private readonly preparedUserIndexes = new Set<number>();
	constructor(config?: ContextSelectionConfig, report?: (report: ContextSelectionReport) => void) {
		this.config = normalizeContextSelection(config) ?? {};
		this.report = report;
	}
	get enabled(): boolean {
		return this.config.mode !== undefined && this.config.mode !== "off";
	}
	begin(query: string, rerank = false): void {
		this.query = query;
		this.turn++;
		this.rerank = rerank;
		this.lastReport = undefined;
		this.registrationError = undefined;
	}
	clear(): void {
		this.records.clear();
		this.prompts.clear();
		this.toolResults.clear();
		this.lastReport = undefined;
		this.preparedUserIndexes.clear();
	}
	registerResult(id: string, result: RetrievalResult): void {
		try {
			this.captureResult(id, result);
		} catch (error) {
			this.registrationError = error instanceof Error ? error.message : String(error);
		}
	}
	private captureResult(id: string, result: RetrievalResult): void {
		if (!this.enabled) return;
		const signal = (result as LocalEvidenceResult)[localEvidence];
		if (!signal || result.content.length > MAX_REGISTERED_TEXT) return;
		const existing = this.records.get(id);
		const signals =
			existing?.signals.filter((entry) => entry.turn === this.turn && entry.signal.query !== signal.query) ?? [];
		signals.push({ signal, turn: this.turn });
		this.records.set(id, {
			source: result.source,
			body: result.content.replace(/\s+/gu, " "),
			signals: signals.slice(-8),
		});
		while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!);
	}
	registerPrompt(prompt: string): string {
		if (this.enabled) {
			this.prompts.add(prompt);
			while (this.prompts.size > 8) this.prompts.delete(this.prompts.values().next().value!);
		}
		return prompt;
	}
	registerToolResult(id: string, name: string, content: readonly { type: string; text?: string }[]): void {
		if (!this.enabled || content.some((c) => c.type !== "text")) return;
		const text = content.map((c) => c.text ?? "").join("");
		if (text.length > 4 * MAX_REGISTERED_TEXT) return;
		this.toolResults.set(id, { name, text });
		while (this.toolResults.size > 64) this.toolResults.delete(this.toolResults.keys().next().value!);
	}
	private spans(messages: readonly AgentMessage[], authenticate = true): Span[] {
		const spans: Span[] = [];
		for (const [messageIndex, message] of messages.entries()) {
			if (message.role !== "user" && message.role !== "toolResult") continue;
			const blocks =
				typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			for (const [blockIndex, block] of blocks.entries()) {
				if (block.type !== "text") continue;
				const text = block.text;
				if (message.role === "user") {
					if (
						authenticate
							? ![...this.prompts].some((prompt) => text.startsWith(prompt))
							: !this.preparedUserIndexes.has(messageIndex)
					)
						continue;
					if (authenticate) this.preparedUserIndexes.add(messageIndex);
				} else {
					const known = this.toolResults.get(message.toolCallId);
					if (!known || known.name !== message.toolName || (authenticate && known.text !== text)) continue;
				}
				for (const [id, record] of this.records) {
					// The header must have exactly the renderer's known source and body, including any score.
					const prefix = `[${id}] ${record.source}`;
					let at = text.indexOf(prefix);
					while (at >= 0) {
						const newline = text.indexOf("\n", at);
						const header = newline < 0 ? "" : text.slice(at, newline);
						const suffix = header.slice(prefix.length);
						const end = newline + 1 + record.body.length;
						if (
							(at === 0 || text[at - 1] === "\n") &&
							(suffix === "" || /^ score=-?\d+(?:\.\d+)?$/u.test(suffix)) &&
							text.slice(newline + 1, end) === record.body &&
							(end === text.length || text[end] === "\n")
						) {
							let sectionEnd = end;
							while (text[sectionEnd] === "\n") sectionEnd++;
							spans.push({
								id,
								start: at,
								end: sectionEnd,
								text: text.slice(at, sectionEnd),
								message: messageIndex,
								block: blockIndex,
							});
						}
						at = text.indexOf(prefix, at + prefix.length);
					}
				}
			}
		}
		return spans.sort((a, b) => a.message - b.message || a.block - b.block || a.start - b.start);
	}
	project(messages: AgentMessage[], model?: Model<Api>, fixedOverheadTokens = 0, bypass?: string): AgentMessage[] {
		if (!this.enabled) return messages;
		const started = performance.now();
		this.countTokens = estimateEvidenceTokens;
		let candidateCount = 0;
		let counter = { count: estimateEvidenceTokens, name: "utf8-div3-v1" };
		const emit = (data: Partial<ContextSelectionReport>): void => {
			this.lastReport = {
				stage: "selection",
				version: CONTEXT_SELECTION_VERSION,
				mode: this.config.mode!,
				queryId: createHash("sha256").update(this.query).digest("hex"),
				questionTurn: this.turn,
				estimator: counter.name,
				hypothetical: this.config.mode === "observe",
				candidateCount,
				visibleCandidateCount: candidateCount,
				evidenceTokensEstimated: 0,
				budget: this.config.evidenceBudgetTokens ?? 6000,
				durationMs: performance.now() - started,
				...data,
				noticeOverBudget:
					(data.evidenceTokensEstimated ?? 0) > (data.budget ?? this.config.evidenceBudgetTokens ?? 6000),
			};
			try {
				this.report?.(this.lastReport);
			} catch {
				/* Diagnostics cannot affect the request. */
			}
		};
		try {
			this.preparedUserIndexes.clear();
			if (this.registrationError) throw new Error(this.registrationError);
			const spans = this.spans(messages);
			candidateCount = spans.length;
			if (bypass || this.rerank || !isSimpleFactQuery(this.query)) {
				emit({ bypass: bypass ?? (this.rerank ? "rerank_enabled" : "conservative_bypass") });
				return messages;
			}
			if (!spans.length) {
				emit({ bypass: "no_registered_local_spans" });
				return messages;
			}
			counter = tokenCounter(model);
			this.countTokens = counter.count;
			const emptied = render(messages, spans, new Set(), false);
			const fixed = estimateContextMessageTokens(emptied);
			let budget = this.config.evidenceBudgetTokens ?? 6000;
			if (model && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
				const usable = Math.floor(model.contextWindow / 1.2);
				const reserve = Math.min(Math.floor(usable / 4), MAX_OUTPUT_TOKENS, Math.max(0, model.maxTokens || 0));
				budget = Math.min(budget, Math.max(0, usable - reserve - fixedOverheadTokens - fixed));
			}
			const sections = new Set(spans.map((s) => `${s.message}:${s.block}`)).size;
			const markerCost = sections * counter.count(marker(spans.length, spans.length));
			const latest = new Map<string, Span>();
			for (const span of spans) latest.set(span.id, span);
			const candidates: SelectionCandidate[] = [];
			for (const [id, span] of latest) {
				const record = this.records.get(id)!;
				const current = record.signals.filter((s) => s.turn === this.turn);
				const signals = current.length ? current.map((s) => s.signal) : [undefined];
				for (const [index, signal] of signals.entries())
					candidates.push({
						key: `${id}:${index}`,
						evidenceKey: id,
						source: record.source,
						rank: spans.indexOf(span),
						query: signal?.query ?? "historical",
						profile: signal?.profile ?? "",
						cosine: signal?.cosine,
						vector: signal?.vector,
						tokens: counter.count(span.text + "\n"),
						priority: span.message,
					});
			}
			const decision = selectContextCandidates(candidates, Math.max(0, budget - markerCost));
			const selected = new Set(decision.selected.map((key) => key.slice(0, key.lastIndexOf(":"))));
			const kept = new Set([...selected].map((id) => latest.get(id)!));
			const projected = render(messages, spans, kept, true);
			const partitions = new Map<string, { queryId: string; profile: string; scope?: string }>();
			for (const id of latest.keys())
				for (const { signal } of this.records.get(id)!.signals) {
					const partition = {
						queryId: createHash("sha256").update(signal.query).digest("hex"),
						profile: signal.profile,
						scope: signal.scope,
					};
					partitions.set(JSON.stringify(partition), partition);
				}
			emit({
				visibleCandidateCount: kept.size,
				plannedVisibleCandidateCount: kept.size,
				evidenceTokensEstimated:
					decision.tokens +
					[...new Set(spans.map((s) => `${s.message}:${s.block}`))].reduce((sum, section) => {
						const members = spans.filter((s) => `${s.message}:${s.block}` === section);
						const count = members.filter((s) => kept.has(s)).length;
						return sum + (count < members.length ? counter.count(marker(members.length, count)) : 0);
					}, 0),
				budget,
				coverageLimited: decision.coverageLimited,
				partitions: [...partitions.values()],
				decisions: [...decision.reasons].map(([id, reason]) => ({ id, reason })),
				fallbacks: [...decision.fallbacks].map(([id, reason]) => ({ id, reason })),
			});
			return this.config.mode === "observe" ? messages : projected;
		} catch (error) {
			emit({ bypass: "selection_failed", error: error instanceof Error ? error.message : String(error) });
			return messages;
		}
	}
	/** Run after the capacity guard so diagnostics distinguish planned and actually visible evidence. */
	observePrepared(messages: AgentMessage[]): void {
		if (!this.lastReport) return;
		try {
			const spans = this.spans(messages, false);
			let actualTokens = spans.reduce((sum, span) => sum + this.countTokens(span.text + "\n"), 0);
			for (const message of messages) {
				if (message.role !== "user" && message.role !== "toolResult") continue;
				const blocks =
					typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
				for (const block of blocks)
					if (block.type === "text")
						for (const match of block.text.matchAll(/\n\[AutoRAG context selection:[^\n]*\]\n/gu))
							actualTokens += this.countTokens(match[0]);
			}
			this.report?.({
				...this.lastReport,
				stage: "prepared",
				visibleCandidateCount: spans.length,
				plannedEvidenceTokensEstimated: this.lastReport.evidenceTokensEstimated,
				evidenceTokensEstimated: actualTokens,
				efficiencyBudgetExceeded: actualTokens > this.lastReport.budget,
				hypothetical: false,
			});
		} catch {
			/* Observers never alter provider input. */
		}
	}
}

function render(
	messages: AgentMessage[],
	spans: readonly Span[],
	keep: ReadonlySet<Span>,
	includeMarker: boolean,
): AgentMessage[] {
	return messages.map((message, messageIndex) => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		const blocks =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		let changed = false;
		const content = blocks.map((block, blockIndex) => {
			if (block.type !== "text") return block;
			const matches = spans.filter((s) => s.message === messageIndex && s.block === blockIndex);
			if (!matches.some((s) => !keep.has(s))) return block;
			changed = true;
			let text = block.text;
			for (const span of [...matches].reverse())
				if (!keep.has(span)) text = text.slice(0, span.start) + text.slice(span.end);
			if (includeMarker) text += marker(matches.length, matches.filter((s) => keep.has(s)).length);
			return { ...block, text };
		});
		if (!changed) return message;
		return {
			...message,
			content:
				typeof message.content === "string"
					? content.map((b) => (b.type === "text" ? b.text : "")).join("")
					: content,
		} as AgentMessage;
	});
}
