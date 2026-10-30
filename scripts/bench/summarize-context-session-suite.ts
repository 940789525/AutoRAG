import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contextSessionCases } from "./context-session-cases.ts";
import { type GradeTurn, gradeContextTrial } from "./context-session-grade.ts";
import { percentile, summarizeContextTrials, type TrialMetrics } from "./context-session-metrics.ts";
import { contextSessionGold } from "./context-session-review.ts";

interface Trial extends TrialMetrics {
	readonly turns?: GradeTurn[];
	readonly inputTokens?: number | null;
	readonly cacheReadTokens?: number | null;
	readonly readCalls?: number;
	readonly readErrors?: number;
	readonly toolCalls?: number;
	readonly readObservations?: { isError: boolean; bytes: number | null; latencyMs: number | null }[];
	readonly usage?: {
		inputTokens: number | null;
		cacheReadTokens: number | null;
		firstTokenMs: number | null;
		scope: string;
		usageReported: boolean;
	}[];
	readonly selection?: {
		stage: string;
		requestId?: string;
		newEvidenceTokensEstimated?: number;
		compactionCount?: number;
		durationMs: number;
	}[];
}

const directory = resolve(process.argv[2] ?? ".omo/evidence/context-completion-suite");
const output = resolve(process.argv[3] ?? ".omo/evidence/context-completion-evaluation.json");
const review = JSON.parse(
	readFileSync(process.argv[4] ?? ".omo/evidence/context-session-review-attestation.json", "utf8"),
);
const expectedDataset = createHash("sha256").update(JSON.stringify(contextSessionCases())).digest("hex");
assert(review.datasetSha256 === expectedDataset, "Gold review is stale");
const trials: Trial[] = [];
const reports: { caseId: string; status: string; sharedConfigUnchanged?: boolean; workers?: number }[] = [];
let target: string | undefined;
for (const task of contextSessionCases()) {
	const path = resolve(directory, `${task.id}.json`);
	const found = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
	if (found) {
		assert(
			found.datasetSha256 === expectedDataset && found.implementationSha256 === review.implementationSha256,
			`Mixed snapshot in ${task.id}`,
		);
		const observed = JSON.stringify({
			provider: found.model?.provider,
			model: found.model?.id,
			thinking: found.model?.thinking,
		});
		assert(target === undefined || target === observed, "Different models or reasoning efforts cannot be pooled");
		target = observed;
		reports.push({
			caseId: task.id,
			status: found.status,
			sharedConfigUnchanged: found.sharedConfigUnchanged,
			workers: found.concurrentSuiteWorkers,
		});
	}
	for (const variant of ["A", "B", "C", "D", "E", "F"])
		for (let repeat = 0; repeat < 3; repeat++) {
			const rows: Trial[] = (found?.trials ?? []).filter(
				(row: Trial) => row.caseId === task.id && row.variant === variant && row.repeat === repeat,
			);
			assert(rows.length <= 1, `Duplicate trial ${task.id}/${variant}/${repeat}`);
			trials.push(rows[0] ?? { caseId: task.id, variant, repeat, status: "not_run", cost: null });
		}
}
const grades = trials.map((trial) => ({
	caseId: trial.caseId,
	variant: trial.variant,
	repeat: trial.repeat,
	...gradeContextTrial(trial),
}));
const summarize = (rows: Trial[]) => ({
	...summarizeContextTrials(rows),
	quality: ["A", "B", "C", "D", "E", "F"].map((variant) => {
		const subset = rows.filter((row) => row.variant === variant);
		const graded = subset.map((row) => gradeContextTrial(row));
		const expectedFacts = subset.reduce(
			(n, row) =>
				n +
				contextSessionGold()
					.find((task) => task.id === row.caseId)!
					.turns.reduce((count, turn) => count + turn.facts.length, 0),
			0,
		);
		const supportedFacts = graded
			.flatMap((row) => row.turns)
			.flatMap((turn) => turn.facts)
			.filter((fact) => "citationSupported" in fact && fact.citationSupported).length;
		const reads = subset.flatMap((row) => row.readObservations ?? []);
		const modelCalls = subset.flatMap((row) => row.usage ?? []);
		const prepared = subset.flatMap((row) => [
			...new Map(
				(row.selection ?? [])
					.filter((event) => event.stage === "prepared")
					.map((event, index) => [event.requestId ?? String(index), event]),
			).values(),
		]);
		return {
			variant,
			attempted: subset.length,
			executionCompleted: subset.filter((row) => row.status === "completed").length,
			executionFailed: subset.filter((row) => row.status === "failed").length,
			notRun: subset.filter((row) => row.status === "not_run").length,
			automatedSupportedSessions: graded.filter((row) => row.status === "supported_by_automated_rubric").length,
			needsReview: graded.filter((row) => row.status === "needs_review").length,
			rubricFailedOrMissing: graded.filter((row) => row.status === "failed").length,
			expectedFacts,
			supportedFacts,
			automatedFactSupportLowerBound: expectedFacts ? supportedFacts / expectedFacts : null,
			danglingCitations: graded
				.flatMap((row) => row.turns)
				.reduce((n, turn) => n + turn.danglingCitations.length, 0),
			readCalls: subset.reduce((n, row) => n + (row.readCalls ?? 0), 0),
			readErrors: subset.reduce((n, row) => n + (row.readErrors ?? 0), 0),
			retrievalToolCalls: subset.reduce((n, row) => n + (row.toolCalls ?? 0) - (row.readCalls ?? 0), 0),
			readBytes: reads.filter((row) => !row.isError).reduce((n, row) => n + (row.bytes ?? 0), 0),
			readLatencyP50: percentile(
				reads.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs])),
				0.5,
			),
			readLatencyP95: percentile(
				reads.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs])),
				0.95,
			),
			reportedModelCalls: modelCalls.filter((row) => row.usageReported).length,
			missingModelUsage: modelCalls.filter((row) => !row.usageReported).length,
			callsWithPositiveCacheRead: modelCalls.filter((row) => row.cacheReadTokens !== null && row.cacheReadTokens > 0)
				.length,
			callsWithReportedZeroCacheRead: modelCalls.filter((row) => row.usageReported && row.cacheReadTokens === 0)
				.length,
			firstAnswerModelTextDeltaP50: percentile(
				modelCalls
					.filter((row) => row.scope === "answer_session")
					.flatMap((row) => (row.firstTokenMs === null ? [] : [row.firstTokenMs])),
				0.5,
			),
			projectionOverheadP95: percentile(
				prepared.map((row) => row.durationMs),
				0.95,
			),
		};
	}),
});
const dev = trials.filter((row) => contextSessionCases().find((task) => task.id === row.caseId)!.split === "dev");
const test = trials.filter((row) => contextSessionCases().find((task) => task.id === row.caseId)!.split === "test");
const report = {
	status: trials.every((row) => row.status !== "not_run") ? "all_attempts_recorded" : "incomplete",
	expectedTrials: 540,
	recordedTrials: trials.filter((row) => row.status !== "not_run").length,
	review,
	reports,
	scoringMethod:
		"Conservative single-agent source/quote/citation rules; supported is a rule result, not independent semantic or human approval. Unrecognized wording stays needs_review. Missing/failed trials remain in denominators.",
	graderSha256: createHash("sha256")
		.update(readFileSync(new URL("./context-session-grade.ts", import.meta.url)))
		.digest("hex"),
	splits: { all: summarize(trials), dev: summarize(dev), test: summarize(test) },
	grades,
	releaseGates: {
		independentHumanReview: "not_claimed_user_authorized_single_agent_review",
		providerColdCacheControl:
			"unavailable_with_current_shared_automatic_cache; positive cacheRead is observed, not experimentally isolated",
		latencyCausality: "not_established_shared_host_and_worker_concurrency_changes",
		quality: "automated_rubric_counts_published; needs_review_is_not_a_pass",
		cost: "paired_catalog_price_estimates_published_with_case_bootstrap; inspect_intervals_and_quality_before_claiming_savings",
		defaultMode: "off",
	},
};
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(
	JSON.stringify({ output, status: report.status, recordedTrials: report.recordedTrials, expectedTrials: 540 }),
);
