import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inertUi } from "../../test/helpers/inert-ui.ts";
import {
	boundedGitHubSearch,
	probeGitHub,
	summarizeGitHubComparison,
	summarizeGitHubUsage,
	validateGitHubCase,
	waitForGitHubTools,
} from "./github-mcp-acceptance.ts";
import { type GitHubQaCall, githubQaTrace } from "./github-mcp-trace.ts";
import { prepareGitHubReview } from "./github-mcp-review.ts";

const { values } = parseArgs({
	options: {
		checks: { type: "boolean", default: false },
		"probe-only": { type: "boolean", default: false },
		"prepare-review": { type: "string" },
		review: { type: "string" },
		reviews: { type: "string" },
		manifest: { type: "string" },
		model: { type: "string" },
		compare: { type: "boolean", default: false },
		"stop-on-error": { type: "boolean", default: false },
		repeats: { type: "string", default: "1" },
		output: { type: "string", default: ".omo/evidence/github-pr-analysis.json" },
	},
});
if (values["prepare-review"]) {
	const input = readFileSync(resolve(values["prepare-review"]), "utf8");
	const packet = prepareGitHubReview(JSON.parse(input), createHash("sha256").update(input).digest("hex"));
	const directory = resolve(values.output!);
	mkdirSync(directory, { recursive: true });
	for (const [name, content] of Object.entries({
		"report.json": packet.reportText, "reviews.pending.json": `${JSON.stringify(packet.reviews, null, 2)}\n`, "review.html": packet.html,
	})) writeFileSync(join(directory, name), content, { flag: "wx", mode: 0o600 });
	console.log(JSON.stringify({ reviewPacket: directory, humanReview: "NOT_RUN" }));
	process.exit(0);
}
if (values.review) {
	assert(values.reviews, "--review <report> requires --reviews <human-review-file>");
	const savedText = readFileSync(resolve(values.review), "utf8");
	const saved = JSON.parse(savedText);
	const reviews = JSON.parse(readFileSync(resolve(values.reviews), "utf8"));
	assert.equal(reviews.runId, saved.runId, "Human reviews must name this report's runId");
	assert(typeof reviews.reviewer === "string" && reviews.reviewer.trim(), "Name the human who reviewed the evidence");
	assert(typeof reviews.reviewedAt === "string" && Number.isFinite(Date.parse(reviews.reviewedAt)), "Record the actual review time");
	if (reviews.reportSha256) assert.equal(reviews.reportSha256, createHash("sha256").update(savedText).digest("hex"), "The reviewed report changed; prepare a fresh packet");
	for (const row of saved.cases) {
		const review = reviews.cases?.[row.caseId];
		if (!review) continue;
		assert(["PASS", "FAIL"].includes(review.businessReview));
		assert(["PASS", "FAIL", "NOT_APPLICABLE"].includes(review.ciReview));
		assert(
			!(row.ciReview === "NOT_RUN" && review.ciReview === "NOT_APPLICABLE"),
			"A required CI case cannot be waived",
		);
		assert(
			Number.isSafeInteger(review.citationsChecked) && review.citationsChecked > 0,
			"Record the number of citations actually reviewed",
		);
		assert(
			Number.isSafeInteger(review.citationsValid) &&
				review.citationsValid >= 0 &&
				review.citationsValid <= review.citationsChecked,
		);
		assert(Number.isSafeInteger(review.unsupportedClaimCount) && review.unsupportedClaimCount >= 0);
		row.businessReview = review.businessReview;
		row.ciReview = review.ciReview;
		row.citationsChecked = review.citationsChecked;
		row.citationsValid = review.citationsValid;
		row.unsupportedClaimCount = review.unsupportedClaimCount;
		row.comparable = review.comparable === true;
		row.status =
			row.automaticChecks !== "PASS" ||
			review.businessReview === "FAIL" ||
			review.ciReview === "FAIL" ||
			review.citationsValid !== review.citationsChecked ||
			review.unsupportedClaimCount > 0
				? "FAIL"
				: "PASS";
	}
	saved.L4 = {
		status: saved.cases.some((row: any) => row.status === "FAIL")
			? "FAIL"
			: saved.cases.length && saved.cases.every((row: any) => row.status === "PASS")
				? "PASS"
				: "NOT_RUN",
	};
	saved.comparison = summarizeGitHubComparison(saved.cases);
	saved.humanReview = { reviewer: reviews.reviewer, reviewedAt: reviews.reviewedAt };
	writeFileSync(resolve(values.review), `${JSON.stringify(saved, null, 2)}\n`);
	console.log(JSON.stringify({ L4: saved.L4.status, comparison: saved.comparison }));
	process.exit(saved.L4.status === "FAIL" ? 1 : 0);
}
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(values.output!);
const root = mkdtempSync(join(tmpdir(), "autorag-github-qa-"));
const dailyPaths = [
	...new Set([
		join(homedir(), ".autorag", "config.json"),
		join(homedir(), ".autorag", "config.fastembed.json"),
		join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "mcp.json"),
		...(process.env.AUTORAG_CONFIG ? [resolve(process.env.AUTORAG_CONFIG)] : []),
	]),
];
const snapshot = () =>
	Object.fromEntries(
		dailyPaths.map((path) => [
			path,
			existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "ABSENT",
		]),
	);
const before = snapshot();
const implementationFiles = [
	"src/agent/agent.ts",
	"src/agent/mcp-client.ts",
	"src/agent/pi-session.ts",
	"src/agent/intent-tracing.ts",
	"src/agent/github-mcp-evidence.ts",
	"skills/github-pr-analysis/SKILL.md",
	"scripts/manual-qa/github-mcp-trace.ts",
	"scripts/manual-qa/github-mcp-acceptance.ts",
	"scripts/manual-qa/run-qa-github-mcp.mts",
	"test/agent/github-mcp-evidence.test.ts",
	"test/agent/github-mcp-workflow.test.ts",
	"test/agent/intent-tracing.test.ts",
	"test/helpers/github-mcp-server.ts",
	"test/manual-qa/github-mcp-qa.test.ts",
	"test/manual-qa/github-mcp-acceptance.test.ts",
];
const implementationSnapshot = () =>
	Object.fromEntries(
		implementationFiles.map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(join(repoRoot, path)))
				.digest("hex"),
		]),
	);
const report: Record<string, any> = {
	version: 1,
	runId: randomUUID(),
	date: new Date().toISOString(),
	code: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(),
	implementationSha256: implementationSnapshot(),
	checks: [],
	L3: { status: "NOT_RUN" },
	L4: { status: "NOT_RUN" },
	comparison: { status: "NOT_RUN" },
	realConfigBefore: before,
	cases: [],
};
// Imports that construct agents happen only after all four application directories are isolated.
process.env.HOME = join(root, "home");
process.env.AUTORAG_HOME = join(root, "autorag");
process.env.AUTORAG_CONFIG = join(root, "autorag", "config.json");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
for (const path of [
	process.env.HOME,
	process.env.AUTORAG_HOME,
	process.env.PI_CODING_AGENT_DIR,
	process.env.PI_CODING_AGENT_SESSION_DIR,
	join(root, "docs"),
])
	mkdirSync(path!, { recursive: true });

try {
	if (values.checks) {
		const tests = [
			"github-mcp-evidence",
			"github-mcp-workflow",
			"github-mcp-lifecycle",
			"jev-pipeline",
			"query-decomposition",
			"intent-tracing",
			"mcp-client",
			"answer-citations",
			"citation-links",
			"citation-numbers",
			"evidence-ledger",
			"evidence-refs-e2e",
			"pi-session",
		].map((name) => `test/agent/${name}.test.ts`);
		const commands = [
			["bun", "run", "check"],
			["bun", "run", "lint"],
			["bun", "run", "typecheck"],
			[
				process.execPath,
				"node_modules/vitest/vitest.mjs",
				"run",
				...tests,
				"test/manual-qa/github-mcp-qa.test.ts",
				"test/manual-qa/github-mcp-acceptance.test.ts",
				"test/observability/run-log.test.ts",
			],
			["bun", "run", "build"],
		];
		for (const [command, ...args] of commands) {
			const started = performance.now();
			const result = spawnSync(command, args, {
				cwd: repoRoot,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
				timeout: 60_000,
			});
			const log = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
			const logPath = `${output}.${report.checks.length}.log`;
			mkdirSync(dirname(logPath), { recursive: true });
			writeFileSync(logPath, log);
			report.checks.push({
				command: [command, ...args],
				status: result.status === 0 ? "PASS" : "FAIL",
				exitCode: result.status,
				durationMs: performance.now() - started,
				logPath,
			});
			console.log(`${result.status === 0 ? "PASS" : "FAIL"}: ${command} ${args.slice(0, 3).join(" ")} (${logPath})`);
			if (result.status !== 0) {
				process.exitCode = 1;
				break;
			}
		}
	}
	const missing = [
		!process.env.GITHUB_MCP_TOKEN && "GITHUB_MCP_TOKEN",
		!values.manifest && "--manifest",
		!values.model && !values["probe-only"] && "--model",
	].filter(Boolean);
	if (missing.length) {
		const skip = { status: "SKIP", reason: `Missing ${missing.join(", ")}; no real GitHub/model requests made.` };
		report.L3 = skip;
		report.L4 = skip;
		report.comparison = skip;
	} else {
		const manifest = JSON.parse(readFileSync(resolve(values.manifest!), "utf8"));
		assert(
			Array.isArray(manifest.samples) && manifest.samples.length > 0,
			"Manifest must contain frozen public samples",
		);
		assert.equal(manifest.version, 1, "Unsupported sample manifest version");
		for (const sample of manifest.samples) {
			assert(
				sample.public === true &&
					/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(sample.url),
				"Only explicitly public github.com PRs are allowed",
			);
			assert(/^[a-f0-9]{40}$/iu.test(sample.headSha), "Freeze a full PR head SHA");
			assert(sample.question === undefined || (typeof sample.question === "string" && sample.question.trim()), "A custom question must be nonempty");
			assert(
				Array.isArray(sample.expectedText) &&
					sample.expectedText.length > 0 &&
					sample.expectedText.every((fact: unknown) => typeof fact === "string" && fact.trim()),
				"Freeze nonempty expected facts",
			);
		}
		report.fixture = manifest;
		report.L3 = await probeGitHub(process.env.GITHUB_MCP_TOKEN!, manifest.samples);
		if (values["probe-only"]) {
			report.L4 = { status: "SKIP", reason: "L3-only run; no model invoked" };
			report.comparison = { status: "SKIP", reason: "L3-only run; no model invoked" };
		} else {
			const [{ AutoRAGAgent }, configApi] = await Promise.all([
				import("../../src/agent/agent.ts"),
				import("../../src/cli/config.ts"),
			]);
			const modelConfig = JSON.parse(readFileSync(resolve(values.model!), "utf8"));
			const access = process.env.AUTORAG_QA_CODEX_ACCESS;
			delete process.env.AUTORAG_QA_CODEX_ACCESS;
			let piCredentials;
			if (modelConfig.model?.provider === "openai-codex" && access) {
				const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
				const expires = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()).exp * 1000;
				assert(expires > Date.now() + 300_000, "A current Codex OAuth session is required");
				piCredentials = new InMemoryCredentialStore();
				await piCredentials.modify("openai-codex", async () => ({ type: "oauth", access, refresh: "", expires }));
			}
			report.model = {
				provider: modelConfig.model?.provider,
				id: modelConfig.model?.id,
				apiKeyEnv: modelConfig.model?.apiKeyEnv,
				thinking: { fast: "low", final: "low" },
			};
			assert.deepEqual(
				Object.keys(modelConfig),
				["model"],
				"Supply a model-only reference config, never a copy of daily configuration",
			);
			const repeats = Number(values.repeats);
			assert(Number.isSafeInteger(repeats) && repeats > 0, "--repeats must be a positive integer");
			for (let repetition = 0; repetition < repeats; repetition++)
				for (const [sampleIndex, sample] of manifest.samples.entries()) {
					assert(sample.public === true, "Each fixture must be explicitly confirmed public by the operator");
					assert(
						/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(sample.url),
						"Only explicit public github.com PR samples are supported",
					);
					assert(
						typeof sample.headSha === "string" && sample.headSha.length > 0,
						"Freeze the expected headSha before running",
					);
					const groups = values.compare
						? (repetition + sampleIndex) % 2
							? ["codemode", "direct"]
							: ["direct", "codemode"]
						: ["codemode"];
					for (const exposure of groups) {
						const caseRoot = mkdtempSync(join(root, "case-"));
						const agentDir = join(caseRoot, "pi");
						mkdirSync(agentDir);
						const configPath = join(caseRoot, "config.json");
						assert(configPath.startsWith(root), "Config target must be inside this run's temp root");
						writeFileSync(
							configPath,
							JSON.stringify({
								...modelConfig,
								searchPaths: [join(root, "docs")],
								workspacePath: caseRoot,
								memoryPath: join(caseRoot, "memory.json"),
								rerank: false,
								queryDecomposition: false,
								jikji: false,
							}),
						);
						const template = JSON.parse(
							readFileSync(join(repoRoot, "docs", "examples", `github-mcp.${exposure}.json`), "utf8"),
						);
						writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(template));
						const config = configApi.resolveConfigReadOnly({ flags: { config: configPath }, cwd: caseRoot });
						const model = await configApi.resolveAgentModel(config, { agentDir });
						const agent = new AutoRAGAgent({
							...configApi.buildAgentOptions(config, agentDir),
							...model,
							piCredentials,
							thinking: report.model.thinking,
							piAgentDir: agentDir,
							piSessionDir: join(caseRoot, "sessions"),
							persistPiSessions: true,
						});
						const calls: GitHubQaCall[] = [];
						let phaseName = "setup";
						const journal = `${output}.${report.runId}.events.jsonl`;
						report.journal = journal;
						mkdirSync(dirname(output), { recursive: true });
						const record = (event: Record<string, unknown>) => appendFileSync(journal, JSON.stringify({
							at: new Date().toISOString(), sample: sample.id, repetition, exposure, phase: phaseName, ...event,
						}) + "\n", { mode: 0o600 });
						record({ event: "setup" });
						let hosted: Awaited<ReturnType<typeof agent.createPiInteractiveRuntime>> | undefined;
						try {
							hosted = await agent.createPiInteractiveRuntime({
								extensionFactories: [githubQaTrace(report.runId, calls, record)],
							});
							const session = hosted.runtime.session;
							const notices: string[] = [];
							await session.bindExtensions({ uiContext: inertUi(notices) });
							await waitForGitHubTools(session, notices);
							if (values.compare) {
								// tool_search can promote a deferred MCP tool to a top-level call in either group.
								session.setActiveToolsByName(
									session.getActiveToolNames().filter((name) =>
										name !== "tool_search" &&
										(exposure === "direct" ? name !== "codemode" : !name.startsWith("mcp__github__")),
									),
								);
							}
							for (const phase of ["cold", "warm"]) {
								phaseName = phase;
								record({ event: "search_start" });
								const firstCall = calls.length;
								const logPath = join(caseRoot, "logs", "runs.jsonl");
								const firstLog = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;
								const started = performance.now();
								const query =
									phase === "cold" && sample.debug === true
										? `请先通过 codemode 发现 GitHub PR 读取工具并输出发现结果，再分析 ${sample.url} 的问题、变更、讨论和当前提交 CI。给出真实证据引用；失败时保留原错误。`
									: sample.question
										? `${sample.url}\n${sample.question}`
										: `请分析 ${sample.url} 解决的问题、主要修改、讨论中的未决事项和当前提交 CI。读取可用的失败日志，给出来源及不能确认的内容。`;
								assert(
									!(exposure === "direct" && sample.debug === true),
									"Use separate non-debug samples for direct/codemode comparisons",
								);
								const response = await boundedGitHubSearch(agent, query, 60_000, () => record({ event: "deadline" }));
								const trace = calls.slice(firstCall);
								const mcp = trace.filter((call) => call.tool.startsWith("mcp__github__"));
								const scripts = trace.filter((call) => call.tool === "codemode");
								const entries = session.sessionManager
									.getEntries()
									.filter((entry) => entry.type === "custom" && entry.customType === "autorag.evidence");
								const validation = validateGitHubCase(
									sample,
									exposure,
									trace,
									response.answer,
									response.results.map(result => result.source),
								);
								const runLog = existsSync(logPath)
									? readFileSync(logPath, "utf8")
											.slice(firstLog)
											.trim()
											.split("\n")
											.filter(Boolean)
											.map((line) => JSON.parse(line))
									: [];
								const row = {
									...validation,
									caseId: `${sample.id}/${repetition}/${exposure}/${phase}`,
									sample: sample.id,
									url: sample.url,
									expectedHeadSha: sample.headSha,
									repetition,
									exposure,
									phase,
									debug: sample.debug === true,
									query,
									durationMs: performance.now() - started,
									response,
									trace,
									evidence: entries,
									runLog,
									modelUsage: runLog.filter((event: any) => event.event === "model_usage"),
									pipelineUsage: summarizeGitHubUsage(runLog),
									mcpCalls: mcp.length,
									scripts: scripts.length,
								};
								report.cases.push(row);
								record({ event: "search_end", status: row.status, durationMs: row.durationMs, results: response.results.length });
								if (row.status === "FAIL") process.exitCode = 1;
							}
						} catch (error) {
							report.cases.push({
								sample: sample.id,
								exposure,
								repetition,
								phase: phaseName,
								status: "FAIL",
								error: error instanceof Error ? error.stack : String(error),
								trace: calls,
							});
							process.exitCode = 1;
							if (values["stop-on-error"]) throw error;
						} finally {
							record({ event: "cleanup_start" });
							try { await hosted?.dispose(); } finally { await agent.indexJobs.close(); }
							record({ event: "cleanup_end" });
						}
					}
				}
			report.L4 = {
				status: report.cases.some((row: any) => row.status === "FAIL") ? "FAIL" : "NOT_RUN",
				note: "Raw real-model runs recorded; manually verify SHA/run/job alignment, claims, citations and CI before declaring business acceptance PASS.",
			};
			report.comparison = values.compare
				? summarizeGitHubComparison(report.cases)
				: { status: "SKIP", reason: "--compare not requested" };
		}
	}
} catch (error) {
	report.error = error instanceof Error ? error.stack : String(error);
	if (report.L3.status !== "PASS") report.L3 = { status: "FAIL", error: report.error };
	report.L4 = { status: "FAIL", error: report.error };
	process.exitCode = 1;
} finally {
	// `check --write` can format files before the tests; fingerprint the verified files.
	report.implementationSha256 = implementationSnapshot();
	report.realConfigAfter = snapshot();
	report.realConfigUnchanged = JSON.stringify(before) === JSON.stringify(report.realConfigAfter);
	if (!report.realConfigUnchanged) process.exitCode = 1;
	rmSync(root, { recursive: true, force: true });
	report.cleanup = { tempRootRemoved: !existsSync(root), stoppedOnlyOwnedClients: true };
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		JSON.stringify({
			output,
			checks: report.checks.map((check: any) => check.status),
			L3: report.L3.status,
			L4: report.L4.status,
			realConfigUnchanged: report.realConfigUnchanged,
			cleanup: report.cleanup,
		}),
	);
}
