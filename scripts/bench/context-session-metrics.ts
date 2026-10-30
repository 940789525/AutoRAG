export interface TrialMetrics {
	readonly caseId: string;
	readonly variant: string;
	readonly repeat: number;
	readonly status: string;
	readonly latencyMs?: number;
	readonly cost?: number | null;
}

export function percentile(values: readonly number[], fraction: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = (sorted.length - 1) * fraction;
	const lower = Math.floor(index);
	return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

/** Repeats of one case are not independent cases for a confidence interval; failed/missing coverage stays visible. */
export function summarizeContextTrials(trials: readonly TrialMetrics[]) {
	const variants = [...new Set(trials.map((trial) => trial.variant))].map((variant) => {
		const rows = trials.filter((trial) => trial.variant === variant);
		const complete = rows.filter((trial) => trial.status === "completed");
		const reportedAttempts = rows.filter((trial) => typeof trial.cost === "number" && Number.isFinite(trial.cost));
		const failedCosts = reportedAttempts.filter((trial) => trial.status === "failed");
		const costs = complete.flatMap((trial) =>
			typeof trial.cost === "number" && Number.isFinite(trial.cost) ? [trial.cost] : [],
		);
		const latencies = complete.flatMap((trial) =>
			typeof trial.latencyMs === "number" && Number.isFinite(trial.latencyMs) ? [trial.latencyMs] : [],
		);
		return {
			variant,
			attempted: rows.length,
			completed: complete.length,
			failed: rows.filter((row) => row.status === "failed").length,
			blocked: rows.filter((row) => row.status === "blocked").length,
			costCoverage: costs.length,
			costP50: percentile(costs, 0.5),
			costP50Scope: "completed trials only; failed and incomplete attempts are accounted separately",
			reportedAttemptCostSum: reportedAttempts.length
				? reportedAttempts.reduce((sum, row) => sum + row.cost!, 0)
				: null,
			failedReportedCostSum: failedCosts.length ? failedCosts.reduce((sum, row) => sum + row.cost!, 0) : null,
			missingAttemptCost: rows.filter((row) => row.status !== "blocked").length - reportedAttempts.length,
			latencyP50: percentile(latencies, 0.5),
			latencyP95: percentile(latencies, 0.95),
		};
	});
	const comparisons = [
		["C", "D"],
		["D", "E"],
		["A", "E"],
		["E", "F"],
	].flatMap(([baseline, candidate]) => {
		const prior = new Map(
			trials
				.filter((trial) => trial.variant === baseline)
				.map((trial) => [`${trial.caseId}:${trial.repeat}`, trial]),
		);
		return (["cost", "latencyMs"] as const).map((metric) => {
			let totalPairs = 0;
			let missingOrFailed = 0;
			const byCase = new Map<string, number[]>();
			for (const trial of trials.filter((row) => row.variant === candidate)) {
				const base = prior.get(`${trial.caseId}:${trial.repeat}`);
				if (!base) continue;
				totalPairs++;
				const a = base[metric];
				const b = trial[metric];
				if (
					base.status !== "completed" ||
					trial.status !== "completed" ||
					typeof a !== "number" ||
					typeof b !== "number" ||
					!Number.isFinite(a) ||
					!Number.isFinite(b) ||
					a <= 0
				) {
					missingOrFailed++;
					continue;
				}
				const values = byCase.get(trial.caseId) ?? [];
				values.push((b - a) / a);
				byCase.set(trial.caseId, values);
			}
			const cases = [...byCase.values()].map((values) => percentile(values, 0.5)!);
			let interval: [number, number] | null = null;
			if (cases.length >= 2) {
				let state = 1729;
				const random = () => {
					state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
					return state / 2 ** 32;
				};
				const samples = Array.from(
					{ length: 2000 },
					() =>
						percentile(
							Array.from({ length: cases.length }, () => cases[Math.floor(random() * cases.length)]),
							0.5,
						)!,
				);
				interval = [percentile(samples, 0.025)!, percentile(samples, 0.975)!];
			}
			return {
				baseline,
				candidate,
				metric,
				totalPairs,
				missingOrFailed,
				independentCases: cases.length,
				medianRelativeChange: percentile(cases, 0.5),
				bootstrap95: interval,
				interpretation:
					cases.length < 2
						? "insufficient_independent_cases"
						: interval && interval[0] <= 0 && interval[1] >= 0
							? "insufficient_evidence_of_change"
							: "descriptive_change_requires_quality_gate",
			};
		});
	});
	return {
		variants,
		comparisons,
		method:
			"paired relative changes; median within each case, then median across cases; 2000 fixed-seed case-cluster bootstrap samples; failures/missing coverage retained separately",
	};
}
