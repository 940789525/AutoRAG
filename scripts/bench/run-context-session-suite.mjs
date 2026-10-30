import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contextSessionCases } from "./context-session-cases.ts";

const args = process.argv.slice(2);
const credentialInput = args.includes("--credential-stdin") ? readFileSync(0, "utf8") : undefined;
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
assert(args.includes("--run-real"), "Explicit --run-real authorization required");
const workers = Number(flag("--workers", "3"));
assert(Number.isInteger(workers) && workers >= 1 && workers <= 3, "Use 1–3 bounded experiment workers");
const split = flag("--split", "all");
assert(["all", "dev", "test"].includes(split));
const output = resolve(flag("--output", ".omo/evidence/context-completion-suite"));
const review = resolve(flag("--review-manifest", ".omo/evidence/context-session-review-attestation.json"));
assert(existsSync(review), "Freeze the authorized review before starting the suite");
mkdirSync(output, { recursive: true });
const cases = contextSessionCases().filter((task) => split === "all" || task.split === split);
const results = [];
const frozenReview = JSON.parse(readFileSync(review, "utf8"));
const pending = cases.filter((task) => {
	const path = resolve(output, `${task.id}.json`);
	if (!args.includes("--resume") || !existsSync(path)) return true;
	const prior = JSON.parse(readFileSync(path, "utf8"));
	assert(
		prior.datasetSha256 === frozenReview.datasetSha256 &&
			prior.implementationSha256 === frozenReview.implementationSha256,
		"Cannot resume mixed snapshots",
	);
	if (args.includes("--provider"))
		assert(prior.model?.provider === flag("--provider", ""), "Cannot resume a different provider");
	if (args.includes("--model")) assert(prior.model?.id === flag("--model", ""), "Cannot resume a different model");
	if (args.includes("--thinking"))
		assert(prior.model?.thinking === flag("--thinking", ""), "Cannot resume a different reasoning effort");
	if (prior.trials?.length !== 18 || !["completed", "completed_with_failures"].includes(prior.status)) return true;
	results.push({
		caseId: task.id,
		exitCode: prior.status === "completed" ? 0 : 1,
		status: prior.status,
		trials: 18,
		report: path,
		resumed: true,
	});
	return false;
});
let next = 0;
let fatalProviderError;
const summary = () => {
	const report = {
		status: fatalProviderError
			? "blocked_provider"
			: next >= pending.length && results.length === cases.length
				? "completed"
				: "running",
		workers,
		target: {
			provider: flag("--provider", "configured_default"),
			model: flag("--model", "configured_default"),
			thinking: flag("--thinking", "runtime_default"),
		},
		fatalProviderError,
		expectedCases: cases.length,
		expectedTrials: cases.length * 6 * 3,
		latencyControl:
			"Fixed bounded worker concurrency, rotating arms per repeat. Provider cache/routing and shared host load are uncontrolled; latency is descriptive, not an isolated speed benchmark.",
		results: [...results].sort((a, b) => a.caseId.localeCompare(b.caseId)),
	};
	writeFileSync(resolve(output, "suite.json"), JSON.stringify(report, null, 2));
};
await Promise.all(
	Array.from({ length: workers }, async () => {
		while (next < pending.length && !fatalProviderError) {
			const task = pending[next++];
			const report = resolve(output, `${task.id}.json`);
			const fd = openSync(resolve(output, `${task.id}.log`), "w");
			const code = await new Promise((accept, reject) => {
				const child = spawn(
					process.execPath,
					[
						"scripts/bench/context-selection.ts",
						"--sessions",
						...(args.includes("--provider") ? ["--provider", flag("--provider", "")] : []),
						...(args.includes("--model") ? ["--model", flag("--model", "")] : []),
						...(args.includes("--thinking") ? ["--thinking", flag("--thinking", "")] : []),
						...(credentialInput === undefined ? [] : ["--credential-stdin"]),
						"--run-real",
						"--split",
						task.split,
						...(task.split === "test" ? ["--allow-test"] : []),
						"--case",
						task.id,
						"--variants",
						"A,B,C,D,E,F",
						"--repeats",
						"3",
						"--auth-dir",
						flag("--auth-dir", "/dev-home/.pi/agent"),
						"--review-manifest",
						review,
						"--output",
						report,
					],
					{
						stdio: [credentialInput === undefined ? "ignore" : "pipe", fd, fd],
						env: { ...process.env, AUTORAG_BENCH_CONCURRENCY: String(workers) },
					},
				);
				if (credentialInput !== undefined) child.stdin.end(credentialInput);
				child.once("error", reject);
				child.once("exit", (code) => accept(code ?? 1));
			}).finally(() => closeSync(fd));
			const value = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : {};
			if (value.fatalProviderError) fatalProviderError = value.fatalProviderError;
			results.push({
				caseId: task.id,
				exitCode: code,
				status: value.status ?? "missing_report",
				trials: value.trials?.length ?? 0,
				report,
			});
			summary();
			console.log(JSON.stringify(results.at(-1)));
		}
	}),
);
summary();
if (results.some((row) => row.exitCode !== 0 || row.status !== "completed")) process.exitCode = 1;
