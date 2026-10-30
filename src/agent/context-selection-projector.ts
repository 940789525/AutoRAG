import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getEncoding } from "js-tiktoken";
import {
	type LocalEvidence,
	type LocalEvidenceResult,
	type LocalReadHandle,
	localEvidence,
} from "../indexing/evidence.ts";
import type { RetrievalResult } from "../retrieval/types.ts";
import {
	CONTEXT_SELECTION_VERSION,
	type ContextSelectionConfig,
	isSimpleFactQuery,
	normalizeContextSelection,
	type SelectionCandidate,
	selectContextCandidates,
} from "./context-selection.ts";
import { estimateContextMessageTokens, safeContextInputBudget } from "./context-token-guard.ts";

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
const MAX_VIEW_BYTES = 16 * 1024 * 1024;
const MAX_VIEW_MESSAGES = 4096;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const messageSignature = (message: AgentMessage): string => digest(message);

interface RecordEntry {
	readonly key: string;
	readonly id: string;
	readonly source: string;
	readonly body: string;
	readonly signals: { signal: LocalEvidence; turn: number }[];
}
interface Span {
	readonly record: RecordEntry;
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly message: number;
	readonly block: number;
	readonly original: string;
	readonly questionTurn: number;
	readonly kind: "body" | "reference" | "omitted";
	readonly target?: number;
	readonly explicitRead?: boolean;
}
interface View {
	readonly raw: readonly string[];
	readonly messages: AgentMessage[];
	readonly spans: readonly Span[];
	readonly fingerprint: string;
	readonly memoryTurn: number;
	readonly spent: number;
	readonly turn: number;
	readonly epoch: number;
}
interface Plan extends View {
	dispatched: boolean;
}

/** Internal benchmark interventions; deliberately absent from user configuration. */
export interface ContextSelectionExperiment {
	readonly deduplicate?: boolean;
	readonly compact?: boolean;
	readonly semanticSelection?: boolean;
}
export interface ContextSelectionReport {
	readonly stage: "selection" | "prepared" | "dispatch" | "commit" | "abort";
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
	readonly requestId?: string;
	readonly epoch?: number;
	readonly prefixMessages?: number;
	readonly prefixBytes?: number;
	readonly prefixChangeReason?: string;
	readonly referenceCount?: number;
	readonly stubNotSmallerCount?: number;
	readonly rehydratedCount?: number;
	readonly duplicateBodyTokensAvoided?: number;
	readonly newEvidenceTokensEstimated?: number;
	readonly compactionCount?: number;
	readonly compactionTokensBefore?: number;
	readonly compactionTokensAfter?: number;
	readonly capacityTargetMet?: boolean;
}

/** Only authenticated local blocks are transformed; committed provider views are append-only until capacity pressure. */
export class ContextSelectionProjector {
	readonly config: ContextSelectionConfig;
	private readonly records = new Map<string, RecordEntry>();
	private readonly prompts = new Map<string, readonly Span[]>();
	private readonly toolResults = new Map<string, { name: string; text: string; spans: readonly Span[] }>();
	private query = "";
	private turn = 0;
	private rerank = false;
	private memory = "";
	private committed?: View;
	private pending?: Plan;
	private epoch = 0;
	private invalidationReason?: string;
	private lastReport?: ContextSelectionReport;
	private countTokens = estimateEvidenceTokens;
	private registrationError?: string;
	private readonly report?: (report: ContextSelectionReport) => void;
	private readonly experiment: ContextSelectionExperiment;
	constructor(
		config?: ContextSelectionConfig,
		report?: (report: ContextSelectionReport) => void,
		experiment: ContextSelectionExperiment = {},
	) {
		this.config = normalizeContextSelection(config) ?? {};
		this.report = report;
		this.experiment = { ...experiment };
	}
	get enabled(): boolean {
		return this.config.mode !== undefined && this.config.mode !== "off";
	}
	get adaptive(): boolean {
		return this.config.mode === "adaptive";
	}
	begin(query: string, rerank = false): void {
		this.query = query;
		this.turn++;
		this.rerank = rerank;
		this.memory = "";
		this.pending = undefined;
		this.lastReport = undefined;
		this.registrationError = undefined;
	}
	setMemoryContext(text: string): void {
		this.memory = text;
	}
	invalidate(reason: string): void {
		this.committed = undefined;
		this.pending = undefined;
		this.epoch++;
		this.invalidationReason = reason;
	}
	clear(): void {
		this.invalidate("session_reset");
		this.records.clear();
		this.prompts.clear();
		this.toolResults.clear();
		this.memory = "";
		this.lastReport = undefined;
		this.registrationError = undefined;
	}
	registerResult(id: string, result: RetrievalResult): void {
		try {
			if (!this.enabled) return;
			const signal = (result as LocalEvidenceResult)[localEvidence];
			if (!signal || result.content.length > MAX_REGISTERED_TEXT) return;
			const key = digest([
				result.source,
				result.id,
				result.content,
				result.metadata.version,
				result.metadata.revision,
			]);
			const previous = this.records.get(key);
			const signals = previous?.signals.filter((s) => s.turn === this.turn && s.signal.query !== signal.query) ?? [];
			signals.push({ signal, turn: this.turn });
			this.records.set(key, {
				key,
				id,
				source: result.source,
				body: result.content.replace(/\s+/gu, " "),
				signals: signals.slice(-8),
			});
			while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!);
		} catch (error) {
			this.registrationError = error instanceof Error ? error.message : String(error);
		}
	}
	registerPrompt(prompt: string): string {
		if (this.enabled) {
			this.prompts.set(prompt, this.scan(prompt));
			while (this.prompts.size > 8) this.prompts.delete(this.prompts.keys().next().value!);
		}
		return prompt;
	}
	registerToolResult(id: string, name: string, content: readonly { type: string; text?: string }[]): void {
		if (!this.enabled || content.some((c) => c.type !== "text")) return;
		const text = content.map((c) => c.text ?? "").join("");
		const registered = this.toolResults.get(id);
		if (name === "read_local_evidence" && registered?.name === name && registered.text === text) return;
		if (text.length > 4 * MAX_REGISTERED_TEXT) return;
		this.toolResults.set(id, { name, text, spans: this.scan(text) });
		while (this.toolResults.size > 64) this.toolResults.delete(this.toolResults.keys().next().value!);
	}
	registerEvidenceRead(callId: string, id: string, handle: LocalReadHandle, body: string, text: string): void {
		if (!this.enabled) return;
		const result: LocalEvidenceResult = {
			id: handle.chunkId,
			source: handle.source,
			content: body,
			score: 0,
			metadata: {},
			[localEvidence]: { query: this.query, profile: handle.profile, vector: [] },
		};
		this.registerResult(id, result);
		const key = digest([result.source, result.id, body, undefined, undefined]);
		const record = this.records.get(key);
		if (!record) throw new Error("Complete evidence read could not register its trusted body");
		const span: Span = {
			record,
			start: 0,
			end: text.length,
			text,
			original: text,
			message: 0,
			block: 0,
			questionTurn: this.turn,
			kind: "body",
			explicitRead: true,
		};
		this.toolResults.set(callId, { name: "read_local_evidence", text, spans: [span] });
		while (this.toolResults.size > 64) this.toolResults.delete(this.toolResults.keys().next().value!);
	}
	private scan(text: string): Span[] {
		const spans: Span[] = [];
		for (const record of this.records.values()) {
			const prefix = `[${record.id}] ${record.source}`;
			let at = text.indexOf(prefix);
			while (at >= 0) {
				const newline = text.indexOf("\n", at);
				const suffix = newline < 0 ? "?" : text.slice(at + prefix.length, newline);
				const end = newline + 1 + record.body.length;
				if (
					(at === 0 || text[at - 1] === "\n") &&
					(suffix === "" || /^ score=-?\d+(?:\.\d+)?$/u.test(suffix)) &&
					text.slice(newline + 1, end) === record.body &&
					(end === text.length || text[end] === "\n")
				) {
					let sectionEnd = end;
					while (text[sectionEnd] === "\n") sectionEnd++;
					const original = text.slice(at, sectionEnd);
					spans.push({
						record,
						start: at,
						end: sectionEnd,
						text: original,
						original,
						questionTurn: this.turn,
						kind: "body",
						message: 0,
						block: 0,
					});
				}
				at = text.indexOf(prefix, at + prefix.length);
			}
		}
		// Renderers normalize whitespace. If two raw identities fit the same text, neither is safe to deduplicate.
		return spans
			.filter((s) => !spans.some((other) => other !== s && other.start < s.end && s.start < other.end))
			.sort((a, b) => a.start - b.start);
	}
	private spans(messages: readonly AgentMessage[]): Span[] {
		return messages.flatMap((message, index) => {
			if (message.role !== "user" && message.role !== "toolResult") return [];
			return textBlocks(message).flatMap(({ text, block }) => {
				let registered: readonly Span[] = [];
				if (message.role === "user") {
					for (const [prompt, spans] of this.prompts)
						if (text.startsWith(prompt)) {
							registered = spans;
							break;
						}
				} else {
					const tool = this.toolResults.get(message.toolCallId);
					if (tool?.name === message.toolName && tool.text === text) registered = tool.spans;
				}
				return registered.map((span) => ({ ...span, message: index, block, questionTurn: this.turn }));
			});
		});
	}
	project(
		messages: AgentMessage[],
		model?: Model<Api>,
		fixedOverheadTokens = 0,
		bypass?: string,
		fingerprint = "",
	): AgentMessage[] {
		if (!this.enabled) return messages;
		const started = performance.now();
		const counter = tokenCounter(model);
		this.countTokens = counter.count;
		const raw = messages.map(messageSignature);
		fingerprint = digest([
			fingerprint,
			model?.id,
			model?.provider,
			model?.api,
			model?.baseUrl,
			model?.contextWindow,
			model?.maxTokens,
		]);
		let prefix = this.committed;
		let reason = this.invalidationReason;
		if (prefix && (prefix.fingerprint !== fingerprint || prefix.raw.some((hash, i) => hash !== raw[i]))) {
			reason = prefix.fingerprint !== fingerprint ? "request_configuration_changed" : "history_changed";
			prefix = undefined;
		}
		try {
			if (this.registrationError) throw new Error(this.registrationError);
			const prefixLength = prefix?.raw.length ?? 0;
			const suffix = messages.slice(prefixLength);
			const suffixSpans = this.spans(suffix);
			let view = [...(prefix?.messages ?? []), ...suffix];
			let spans = [
				...(prefix?.spans ?? []),
				...suffixSpans.map((span) => ({ ...span, message: span.message + (prefix?.messages.length ?? 0) })),
			];
			const fixedPrefixLength = prefix?.messages.length ?? 0;
			if (this.memory && prefix?.memoryTurn !== this.turn) {
				let at = view.length;
				for (let i = view.length - 1; i >= fixedPrefixLength; i--)
					if (view[i].role === "user") {
						at = i;
						break;
					}
				view.splice(at, 0, {
					role: "user",
					content: [{ type: "text", text: `<memory_context>\n${this.memory}\n</memory_context>` }],
					timestamp: 0,
				});
				spans = spans.map((s) => (s.message >= at ? { ...s, message: s.message + 1 } : s));
			}
			const fresh = spans.filter((s) => s.message >= fixedPrefixLength);
			const spent = prefix?.turn === this.turn ? prefix.spent : 0;
			const budget = this.config.evidenceBudgetTokens ?? 6000;
			const anchors = new Map<string, Span>();
			for (const span of spans.filter((s) => s.message < fixedPrefixLength && s.kind === "body"))
				if (!anchors.has(span.record.key)) anchors.set(span.record.key, span);
			const candidates = new Map<string, Span>();
			for (const span of fresh)
				if (!anchors.has(span.record.key) && !candidates.has(span.record.key))
					candidates.set(span.record.key, span);
			const conservative =
				this.experiment.semanticSelection === false || bypass || this.rerank || !isSimpleFactQuery(this.query);
			const selection: SelectionCandidate[] = [...candidates.values()].map((span, rank) => {
				const signal = span.record.signals.find((s) => s.turn === this.turn)?.signal;
				return {
					key: span.record.key,
					evidenceKey: span.record.key,
					source: span.record.source,
					rank,
					query: signal?.query ?? "historical",
					profile: signal?.profile ?? "",
					cosine: signal?.cosine,
					vector: signal?.vector,
					tokens: this.countTokens(span.text),
					priority: 0,
				};
			});
			const capacity = safeContextInputBudget(model);
			const empty = replaceSpans(
				view,
				spans,
				new Map(fresh.map((s) => [s, { text: "", kind: "omitted" as const }])),
			).messages;
			const remainingCapacity =
				capacity === undefined
					? Infinity
					: capacity - fixedOverheadTokens - estimateContextMessageTokens(empty, false);
			const decision = conservative
				? { selected: [...candidates.keys()], fallbacks: new Map<string, string>(), coverageLimited: false }
				: selectContextCandidates(selection, Math.max(0, Math.min(budget - spent, remainingCapacity)));
			const selected = conservative ? new Set(candidates.keys()) : new Set(decision.selected);
			// A specific subsequent tool request may need a complete block even after its question's soft budget.
			if (!selected.size && spent > 0) {
				const explicit = [...candidates.values()].find((s) => view[s.message].role === "toolResult");
				if (explicit) selected.add(explicit.record.key);
			}
			const replacements = new Map<Span, { text: string; kind: Span["kind"]; target?: number }>();
			let avoided = 0;
			let stubNotSmaller = 0;
			for (const span of fresh) {
				if (this.experiment.deduplicate === false) {
					anchors.set(span.record.key, span);
					continue;
				}
				if (span.explicitRead) {
					anchors.set(span.record.key, span);
					continue;
				}
				const anchor = anchors.get(span.record.key);
				if (anchor) {
					const text = referenceText(span, anchor.message);
					if (this.countTokens(text) < this.countTokens(span.text)) {
						replacements.set(span, { text, kind: "reference", target: anchor.message });
						avoided += this.countTokens(span.text) - this.countTokens(text);
					} else stubNotSmaller++;
				} else if (selected.has(span.record.key)) anchors.set(span.record.key, span);
				else replacements.set(span, { text: omittedText(span), kind: "omitted" });
			}
			({ messages: view, spans } = replaceSpans(view, spans, replacements));
			const newTokens = evidenceTokens(
				view,
				spans.filter((s) => s.message >= fixedPrefixLength),
				this.countTokens,
			);
			const before = estimateContextMessageTokens(view, false) + fixedOverheadTokens;
			let compacted = false;
			const byteLimit = model?.inputLimits?.maxRequestBytes;
			const bytesBefore = Buffer.byteLength(JSON.stringify(view)) + fixedOverheadTokens * 4;
			if (
				this.experiment.compact !== false &&
				((capacity !== undefined && before >= capacity * 0.8) ||
					(byteLimit !== undefined && bytesBefore >= byteLimit * 0.8))
			) {
				const protectedKeys = new Set(
					spans
						.filter((s) => s.questionTurn === this.turn || s.message >= fixedPrefixLength)
						.map((s) => s.record.key),
				);
				const requestedIds = new Set(
					view
						.slice(fixedPrefixLength)
						.filter((m) => m.role === "user")
						.flatMap((m) =>
							textBlocks(m).flatMap((b) => [...b.text.matchAll(/\[(e\d+)\]/gu)].map((match) => match[1])),
						),
				);
				for (const span of spans) if (requestedIds.has(span.record.id)) protectedKeys.add(span.record.key);
				const edits = new Map<Span, { text: string; kind: Span["kind"] }>();
				let total = before;
				let bytes = bytesBefore;
				for (const span of spans) {
					if (
						(capacity === undefined || total <= capacity * 0.6) &&
						(byteLimit === undefined || bytes <= byteLimit * 0.6)
					)
						break;
					if (
						span.explicitRead ||
						span.message >= fixedPrefixLength ||
						span.kind !== "body" ||
						protectedKeys.has(span.record.key)
					)
						continue;
					const text = omittedText(span);
					const saving = Math.ceil((span.text.length - text.length) / 4);
					if (saving <= 0) continue;
					edits.set(span, { text, kind: "omitted" });
					total -= saving;
					bytes -= Buffer.byteLength(span.text) - Buffer.byteLength(text);
					for (const ref of spans)
						if (ref.kind === "reference" && ref.record.key === span.record.key) {
							edits.set(ref, { text: omittedText(ref), kind: "omitted" });
						}
				}
				if (edits.size) {
					({ messages: view, spans } = replaceSpans(view, spans, edits));
					compacted = true;
				}
			}
			const epoch = (prefix?.epoch ?? this.epoch) + (reason || compacted ? 1 : 0);
			this.pending = this.adaptive
				? {
						raw,
						messages: structuredClone(view),
						spans,
						fingerprint,
						memoryTurn: this.turn,
						spent: spent + newTokens,
						turn: this.turn,
						epoch,
						dispatched: false,
					}
				: undefined;
			this.lastReport = {
				stage: "selection",
				version: CONTEXT_SELECTION_VERSION,
				mode: this.config.mode!,
				queryId: digest(this.query),
				questionTurn: this.turn,
				estimator: counter.name,
				hypothetical: !this.adaptive,
				candidateCount: spans.length,
				visibleCandidateCount: spans.filter((s) => s.kind === "body").length,
				plannedVisibleCandidateCount: spans.filter((s) => s.kind === "body").length,
				evidenceTokensEstimated: evidenceTokens(view, spans, this.countTokens),
				budget,
				durationMs: performance.now() - started,
				requestId: digest([this.turn, raw, fingerprint]),
				epoch,
				prefixMessages: fixedPrefixLength,
				prefixBytes: prefix ? Buffer.byteLength(JSON.stringify(prefix.messages)) : 0,
				prefixChangeReason: compacted ? "capacity_compaction" : reason,
				stubNotSmallerCount: stubNotSmaller,
				referenceCount: spans.filter((s) => s.kind === "reference").length,
				duplicateBodyTokensAvoided: avoided,
				newEvidenceTokensEstimated: newTokens,
				efficiencyBudgetExceeded: spent + newTokens > budget,
				noticeOverBudget: newTokens > budget,
				compactionCount: compacted ? 1 : 0,
				compactionTokensBefore: before,
				compactionTokensAfter: estimateContextMessageTokens(view, false) + fixedOverheadTokens,
				capacityTargetMet:
					capacity === undefined && byteLimit === undefined
						? undefined
						: (capacity === undefined ||
								estimateContextMessageTokens(view, false) + fixedOverheadTokens <= capacity * 0.6) &&
							(byteLimit === undefined ||
								Buffer.byteLength(JSON.stringify(view)) + fixedOverheadTokens * 4 <= byteLimit * 0.6),
				bypass: !spans.length
					? "no_registered_local_spans"
					: capacity === undefined
						? "capacity_unknown"
						: undefined,
				decisions: fresh.map((s) => ({ id: s.record.id, reason: replacements.get(s)?.kind ?? "body" })),
				fallbacks: [...decision.fallbacks].map(([id, why]) => ({ id, reason: why })),
				coverageLimited: decision.coverageLimited,
			};
			this.emit();
			return this.adaptive ? (equalMessages(view, messages) ? messages : view) : messages;
		} catch (error) {
			const fallback = prefix ? [...prefix.messages, ...messages.slice(prefix.raw.length)] : messages;
			this.pending = this.adaptive
				? {
						raw,
						messages: structuredClone(fallback),
						spans: prefix?.spans ?? [],
						fingerprint,
						memoryTurn: prefix?.memoryTurn ?? 0,
						spent: prefix?.spent ?? 0,
						turn: this.turn,
						epoch: prefix?.epoch ?? this.epoch,
						dispatched: false,
					}
				: undefined;
			this.lastReport = {
				stage: "selection",
				version: CONTEXT_SELECTION_VERSION,
				mode: this.config.mode!,
				queryId: digest(this.query),
				questionTurn: this.turn,
				estimator: counter.name,
				hypothetical: !this.adaptive,
				candidateCount: 0,
				visibleCandidateCount: 0,
				evidenceTokensEstimated: 0,
				budget: this.config.evidenceBudgetTokens ?? 6000,
				durationMs: performance.now() - started,
				bypass: "selection_failed",
				error: error instanceof Error ? error.message : String(error),
			};
			this.emit();
			// Never restore a full raw history over an already committed projection on a transient error.
			return fallback;
		}
	}
	/** Called after all capacity transforms. Repairs references once; the caller must fit and validate again. */
	finalize(messages: AgentMessage[]): AgentMessage[] {
		const plan = this.pending;
		if (!plan) {
			this.observePrepared(messages);
			return messages;
		}
		let located = locateSpans(plan, messages);
		const edits = new Map<Span, { text: string; kind: Span["kind"] }>();
		for (const ref of located.filter((s) => s.kind === "reference")) {
			if (
				!located.some(
					(s) =>
						s.kind === "body" &&
						s.record.key === ref.record.key &&
						(s.message < ref.message ||
							(s.message === ref.message &&
								(s.block < ref.block || (s.block === ref.block && s.start < ref.start)))),
				)
			)
				edits.set(ref, { text: ref.original, kind: "body" });
		}
		const result = replaceSpans(messages, located, edits);
		located = result.spans;
		const altered = !equalMessages(messages, plan.messages);
		this.pending = {
			...plan,
			messages: structuredClone(result.messages),
			spans: located,
			epoch: plan.epoch + (altered ? 1 : 0),
			dispatched: false,
		};
		if (this.lastReport)
			this.lastReport = {
				...this.lastReport,
				rehydratedCount: edits.size,
				prefixChangeReason: altered ? "final_context_limits" : this.lastReport.prefixChangeReason,
				epoch: this.pending.epoch,
			};
		this.observePrepared(result.messages);
		return result.messages;
	}
	/** At the actual stream boundary, after extension transforms and LLM conversion. No guessed cache visibility. */
	dispatch(messages: readonly AgentMessage[]): void {
		const plan = this.pending;
		if (!plan) return;
		const spans = locateSpans(plan, messages);
		for (const ref of spans.filter((s) => s.kind === "reference")) {
			if (
				!spans.some(
					(s) =>
						s.kind === "body" &&
						s.record.key === ref.record.key &&
						(s.message < ref.message ||
							(s.message === ref.message &&
								(s.block < ref.block || (s.block === ref.block && s.start < ref.start)))),
				)
			)
				throw new Error(
					`AutoRAG evidence reference [${ref.record.id}] has no complete preceding body after final request limits`,
				);
		}
		const mapping = locateMessages(plan.messages, messages);
		const managed = new Set(plan.spans.map((s) => s.message));
		const actual = plan.messages.flatMap((message, i) => {
			const at = mapping.get(i);
			return at === undefined ? (managed.has(i) ? [] : [message]) : [messages[at]];
		});
		const altered = !equalMessages(plan.messages, actual);
		this.pending = {
			...plan,
			messages: structuredClone(actual),
			spans: locateSpans(plan, actual),
			epoch: plan.epoch + (altered ? 1 : 0),
			dispatched: true,
		};
		if (altered && this.lastReport)
			this.lastReport = {
				...this.lastReport,
				epoch: this.pending.epoch,
				prefixChangeReason: "provider_context_changed",
			};
		if (this.lastReport) {
			this.lastReport = { ...this.lastReport, stage: "dispatch" };
			this.emit();
		}
	}
	settle(success: boolean): void {
		const plan = this.pending;
		if (!plan) return;
		if (success && plan.dispatched) {
			if (
				plan.messages.length <= MAX_VIEW_MESSAGES &&
				Buffer.byteLength(JSON.stringify(plan.messages)) +
					plan.spans.reduce(
						(bytes, span) => bytes + Buffer.byteLength(span.original) + Buffer.byteLength(span.text),
						0,
					) <=
					MAX_VIEW_BYTES
			) {
				this.committed = plan;
				this.epoch = plan.epoch;
				this.invalidationReason = undefined;
			} else this.invalidate("view_capacity");
		}
		if (this.lastReport) {
			this.lastReport = { ...this.lastReport, stage: success && plan.dispatched ? "commit" : "abort" };
			this.emit();
		}
		this.pending = undefined;
	}
	observePrepared(messages: AgentMessage[]): void {
		if (!this.lastReport) return;
		const spans = this.pending ? locateSpans(this.pending, messages) : this.spans(messages);
		if (this.pending) {
			const altered = !equalMessages(this.pending.messages, messages);
			this.pending = {
				...this.pending,
				messages: structuredClone(messages),
				spans,
				epoch: this.pending.epoch + (altered ? 1 : 0),
			};
			if (altered)
				this.lastReport = {
					...this.lastReport,
					epoch: this.pending.epoch,
					prefixChangeReason: "final_context_limits",
				};
		}
		this.lastReport = {
			...this.lastReport,
			stage: "prepared",
			hypothetical: false,
			plannedEvidenceTokensEstimated:
				this.lastReport.plannedEvidenceTokensEstimated ?? this.lastReport.evidenceTokensEstimated,
			visibleCandidateCount: spans.filter((s) => s.kind === "body").length,
			evidenceTokensEstimated: evidenceTokens(messages, spans, this.countTokens),
		};
		this.emit();
	}
	private emit(): void {
		try {
			if (this.lastReport) this.report?.(this.lastReport);
		} catch {
			/* Logging never changes the request. */
		}
	}
}

function textBlocks(message: AgentMessage): { text: string; block: number }[] {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return [{ text: content, block: 0 }];
	return Array.isArray(content)
		? content.flatMap((b, block) => (b.type === "text" ? [{ text: b.text, block }] : []))
		: [];
}
function equalMessages(a: readonly AgentMessage[], b: readonly AgentMessage[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function referenceText(span: Span, target: number): string {
	return `[${span.record.id}] ${span.record.source}\n[AutoRAG evidence reference: full text of ${span.record.id} in message m${target + 1}.]\n\n`;
}
function omittedText(_span: Span): string {
	return "";
}
const OMISSION_NOTE =
	"\n[AutoRAG context selection: other text was omitted from this request, not judged irrelevant; refine the query or read sources to restore evidence.]\n";
function replaceSpans(
	messages: AgentMessage[],
	spans: readonly Span[],
	edits: ReadonlyMap<Span, { text: string; kind: Span["kind"]; target?: number }>,
): { messages: AgentMessage[]; spans: Span[] } {
	const next: Span[] = [];
	const output = messages.map((message, index) => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		const blocks = textBlocks(message);
		let content = message.content;
		for (const { text, block } of blocks) {
			const matches = spans
				.filter((s) => s.message === index && s.block === block)
				.sort((a, b) => a.start - b.start);
			let result = "";
			let end = 0;
			for (const span of matches) {
				result += text.slice(end, span.start);
				const replacement = edits.get(span);
				const start = result.length;
				result += replacement?.text ?? span.text;
				next.push({ ...span, ...replacement, start, end: result.length, text: replacement?.text ?? span.text });
				end = span.end;
			}
			result += text.slice(end);
			if (matches.some((s) => edits.get(s)?.kind === "omitted") && !result.endsWith(OMISSION_NOTE))
				result += OMISSION_NOTE;
			if (result === text) continue;
			if (typeof content === "string") content = result;
			else content = content.map((b, i) => (i === block && b.type === "text" ? { ...b, text: result } : b));
		}
		return content === message.content ? message : ({ ...message, content } as AgentMessage);
	});
	return { messages: output, spans: next };
}
/** Locate exact managed spans after final guards or system-message insertion, never parse arbitrary IDs as evidence. */
function locateSpans(plan: View, messages: readonly AgentMessage[]): Span[] {
	const spans: Span[] = [];
	for (const [index, found] of locateMessages(plan.messages, messages)) {
		const blocks = textBlocks(messages[found]);
		for (const block of blocks) {
			let offset = 0;
			for (const span of plan.spans.filter((s) => s.message === index && s.block === block.block)) {
				const at = block.text.indexOf(span.text, offset);
				if (at >= 0) {
					spans.push({ ...span, message: found, start: at, end: at + span.text.length });
					offset = at + span.text.length;
				} else if (
					span.kind === "reference" &&
					block.text.indexOf(
						span.text.slice(
							0,
							span.text.indexOf("[AutoRAG evidence reference:") + "[AutoRAG evidence reference:".length,
						),
						offset,
					) >= 0
				) {
					throw new Error(
						`AutoRAG evidence reference [${span.record.id}] was truncated or changed by a request transform`,
					);
				}
			}
		}
	}
	return spans;
}

function locateMessages(originals: readonly AgentMessage[], messages: readonly AgentMessage[]): Map<number, number> {
	const mapping = new Map<number, number>();
	let cursor = 0;
	for (const [index, original] of originals.entries()) {
		const found = messages.findIndex(
			(m, i) =>
				i >= cursor &&
				m.role === original.role &&
				(original.role === "toolResult"
					? m.role === "toolResult" && m.toolCallId === original.toolCallId
					: "timestamp" in original && "timestamp" in m && m.timestamp === original.timestamp),
		);
		if (found < 0) continue;
		mapping.set(index, found);
		cursor = found + 1;
	}
	return mapping;
}

function evidenceTokens(
	messages: readonly AgentMessage[],
	spans: readonly Span[],
	count: (text: string) => number,
): number {
	const blocks = new Set(spans.map((s) => `${s.message}:${s.block}`));
	return (
		spans.reduce((sum, s) => sum + count(s.text), 0) +
		[...blocks].reduce((sum, key) => {
			const [message, block] = key.split(":").map(Number);
			const text = textBlocks(messages[message]).find((b) => b.block === block)?.text;
			return sum + (text?.endsWith(OMISSION_NOTE) ? count(OMISSION_NOTE) : 0);
		}, 0)
	);
}
