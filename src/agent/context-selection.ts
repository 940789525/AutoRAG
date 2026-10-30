export interface ContextSelectionConfig {
	readonly mode?: "off" | "observe" | "adaptive";
	readonly evidenceBudgetTokens?: number;
}

export const CONTEXT_SELECTION_VERSION = "append-context-v2-evidence-read-experimental";

export function normalizeContextSelection(value: unknown): ContextSelectionConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("contextSelection must be an object");
	const config = value as Record<string, unknown>;
	for (const key of Object.keys(config))
		if (key !== "mode" && key !== "evidenceBudgetTokens")
			throw new Error(`contextSelection.${key} is not recognized`);
	if (
		config.mode !== undefined &&
		(typeof config.mode !== "string" || !["off", "observe", "adaptive"].includes(config.mode))
	)
		throw new Error("contextSelection.mode must be off, observe, or adaptive");
	if (
		config.evidenceBudgetTokens !== undefined &&
		(!Number.isSafeInteger(config.evidenceBudgetTokens) || (config.evidenceBudgetTokens as number) < 1)
	)
		throw new Error("contextSelection.evidenceBudgetTokens must be a positive safe integer");
	return { ...config } as ContextSelectionConfig;
}

/** Positive recognition only; unknown/aggregate intent keeps the original evidence pool. */
export function isSimpleFactQuery(query: string): boolean {
	if (
		query.length > 240 ||
		/所有|全部|完整|汇总|统计|对比|比较|分别|以及|例外|变化|期间|多少个|多少种|多少次|\b(?:all|every|compare|summar|count|except|between|during|changed|and|both|versus)\b/iu.test(
			query,
		)
	)
		return false;
	return /(?:谁|何时|哪里|在哪|上限是多少|保留多少天|有效期|生效日期)|^(?:who\b|when\b|where\b|how many days\b|what (?:is|was)\b.{0,200}\b(?:threshold|limit|amount|rate|fee|deadline|date|name|owner|approver|address|phone|email|duration|period|version|status|cost|price|number|code|identifier|id)\b)/iu.test(
		query.trim(),
	);
}

export interface SelectionCandidate {
	readonly key: string;
	readonly evidenceKey?: string;
	readonly source: string;
	readonly rank: number;
	readonly query: string;
	readonly profile: string;
	readonly cosine?: number;
	readonly vector?: readonly number[];
	readonly tokens: number;
	readonly priority: number;
}

export type SelectionReason = "selected" | "duplicate" | "gap_excluded" | "low_marginal_value" | "budget_excluded";

export interface SelectionDecision {
	readonly selected: readonly string[];
	readonly reasons: ReadonlyMap<string, SelectionReason>;
	readonly tokens: number;
	readonly coverageLimited: boolean;
	readonly fallbacks: ReadonlyMap<string, string>;
}

export function validVector(vector: readonly number[] | undefined): vector is readonly number[] {
	return !!vector?.length && vector.every(Number.isFinite) && vector.some((value) => value !== 0);
}

function validCosine(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= -1 && value <= 1;
}

/** No universal relevance threshold: this detects only a conspicuous within-query distribution gap. */
export function adaptiveCutoff(scores: readonly number[]): number {
	const n = scores.length;
	if (n < 10 || scores.some((s, i) => !validCosine(s) || (i > 0 && s > scores[i - 1]))) return n;
	const gaps = scores.slice(0, -1).map((s, i) => s - scores[i + 1]);
	const considered = gaps.slice(2, Math.min(n - 1, Math.floor(0.9 * n)));
	if (!considered.length) return n;
	const sorted = [...considered].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	const maximum = Math.max(...considered);
	if (maximum < 0.04 || maximum < 3 * Math.max(median, 0.001)) return n;
	const k = considered.lastIndexOf(maximum) + 3;
	return Math.min(n, k + 5);
}

function cosine(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let aa = 0;
	let bb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		aa += a[i] ** 2;
		bb += b[i] ** 2;
	}
	return dot / Math.sqrt(aa * bb);
}

/** Pure, deterministic selection. Candidate text and public retrieval results never change. */
export function selectContextCandidates(
	candidates: readonly SelectionCandidate[],
	budget: number,
	experiment: { readonly gap?: boolean; readonly mmr?: boolean; readonly mmrWeight?: number } = {},
): SelectionDecision {
	if (
		experiment.mmrWeight !== undefined &&
		(!Number.isFinite(experiment.mmrWeight) || experiment.mmrWeight < 0 || experiment.mmrWeight > 1)
	)
		throw new RangeError("MMR weight must be between zero and one");
	const reasons = new Map<string, SelectionReason>();
	const fallbacks = new Map<string, string>();
	const groups = new Map<string, SelectionCandidate[]>();
	const seen = new Set<string>();
	const dimensions = new Map<string, number>();
	const scoredKeys = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate.key)) continue;
		seen.add(candidate.key);
		if (candidate.profile && validVector(candidate.vector) && !dimensions.has(candidate.profile))
			dimensions.set(candidate.profile, candidate.vector.length);
		const scored =
			!!candidate.profile &&
			validCosine(candidate.cosine) &&
			validVector(candidate.vector) &&
			dimensions.get(candidate.profile) === candidate.vector.length;
		if (scored) scoredKeys.add(candidate.key);
		else
			fallbacks.set(
				candidate.key,
				!candidate.profile
					? "missing_profile"
					: !validCosine(candidate.cosine)
						? "missing_or_invalid_raw_cosine"
						: !validVector(candidate.vector)
							? "missing_or_invalid_vector"
							: "vector_dimension_mismatch",
			);
		const partition = JSON.stringify([candidate.priority, candidate.query, candidate.profile, scored]);
		const group = groups.get(partition) ?? [];
		group.push(candidate);
		groups.set(partition, group);
	}
	const ordered = [...groups.values()].sort((a, b) => b[0].priority - a[0].priority);
	for (const group of ordered) {
		group.sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
		const cutoff =
			experiment.gap === false || !scoredKeys.has(group[0].key)
				? group.length
				: adaptiveCutoff(group.map((c) => c.cosine ?? Number.NaN));
		for (const c of group.splice(cutoff)) reasons.set(c.key, "gap_excluded");
	}
	const selected: SelectionCandidate[] = [];
	let tokens = 0;
	const redundancies = new Map<string, number>();
	for (const priority of new Set(ordered.map((g) => g[0].priority))) {
		const tier = ordered.filter((g) => g[0].priority === priority);
		let advanced = true;
		while (advanced) {
			advanced = false;
			for (const group of tier) {
				let best: SelectionCandidate | undefined;
				let bestValue = Number.NEGATIVE_INFINITY;
				for (const c of group) {
					if (reasons.has(c.key)) continue;
					if (!Number.isFinite(c.tokens) || c.tokens < 0 || tokens + c.tokens > budget) {
						reasons.set(c.key, "budget_excluded");
						continue;
					}
					let value = 1;
					if (experiment.mmr !== false && scoredKeys.has(c.key)) {
						const redundancy = redundancies.get(c.key) ?? 0;
						const weight = experiment.mmrWeight ?? 0.75;
						value = weight * Math.max(0, c.cosine!) - (1 - weight) * redundancy;
					}
					if (value <= 0 || (selected.length > 0 && value < 0.05)) continue;
					if (value > bestValue) {
						best = c;
						bestValue = value;
					}
				}
				if (best) {
					reasons.set(best.key, "selected");
					selected.push(best);
					tokens += best.tokens;
					if (experiment.mmr !== false && validVector(best.vector)) {
						for (const c of ordered.flat()) {
							if (
								!reasons.has(c.key) &&
								c.profile === best.profile &&
								validVector(c.vector) &&
								c.vector.length === best.vector.length
							) {
								redundancies.set(c.key, Math.max(redundancies.get(c.key) ?? 0, cosine(c.vector, best.vector)));
							}
						}
					}
					for (const other of ordered.flat())
						if (
							other.key !== best.key &&
							!reasons.has(other.key) &&
							(other.evidenceKey ?? other.key) === (best.evidenceKey ?? best.key)
						)
							reasons.set(other.key, "duplicate");
					advanced = true;
				}
			}
		}
	}

	for (const group of ordered)
		for (const c of group) if (!reasons.has(c.key)) reasons.set(c.key, "low_marginal_value");
	return {
		selected: selected.map((c) => c.key),
		reasons,
		tokens,
		coverageLimited: ordered.some(
			(g) =>
				g.length > 0 && !g.some((c) => selected.some((s) => (s.evidenceKey ?? s.key) === (c.evidenceKey ?? c.key))),
		),
		fallbacks,
	};
}
