import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type GitHubQaCall, githubQaTrace } from "./github-mcp-trace.ts";

const { values } = parseArgs({
	options: {
		checks: { type: "boolean", default: false },
		manifest: { type: "string" },
		model: { type: "string" },
		compare: { type: "boolean", default: false },
		repeats: { type: "string", default: "1" },
		output: { type: "string", default: ".omo/evidence/github-pr-analysis.json" },
	},
});
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
	"src/agent/github-mcp-evidence.ts",
	"skills/github-pr-analysis/SKILL.md",
	"scripts/manual-qa/github-mcp-trace.ts",
	"scripts/manual-qa/run-qa-github-mcp.mts",
	"test/agent/github-mcp-evidence.test.ts",
	"test/agent/github-mcp-workflow.test.ts",
	"test/helpers/github-mcp-server.ts",
	"test/manual-qa/github-mcp-qa.test.ts",
];
const report: Record<string, any> = {
	version: 1,
	runId: randomUUID(),
	date: new Date().toISOString(),
	code: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(),
	implementationSha256: Object.fromEntries(
		implementationFiles.map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(join(repoRoot, path)))
				.digest("hex"),
		]),
	),
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
			[process.execPath, "node_modules/vitest/vitest.mjs", "run", ...tests, "test/manual-qa/github-mcp-qa.test.ts"],
			["bun", "run", "build"],
		];
		for (const [command, ...args] of commands) {
			const started = performance.now();
			const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
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
		!values.model && "--model",
	].filter(Boolean);
	if (missing.length) {
		const skip = { status: "SKIP", reason: `Missing ${missing.join(", ")}; no real GitHub/model requests made.` };
		report.L3 = skip;
		report.L4 = skip;
		report.comparison = skip;
	} else {
		const [{ AutoRAGAgent }, configApi, { GITHUB_READ_TOOLS }] = await Promise.all([
			import("../../src/agent/agent.ts"),
			import("../../src/cli/config.ts"),
			import("../../src/agent/github-mcp-evidence.ts"),
		]);
		const manifest = JSON.parse(readFileSync(resolve(values.manifest!), "utf8"));
		assert(
			Array.isArray(manifest.samples) && manifest.samples.length > 0,
			"Manifest must contain frozen public samples",
		);
		const modelConfig = JSON.parse(readFileSync(resolve(values.model!), "utf8"));
		assert.deepEqual(
			Object.keys(modelConfig),
			["model"],
			"Supply a model-only reference config, never a copy of daily configuration",
		);
		const repeats = Number(values.repeats);
		assert(Number.isSafeInteger(repeats) && repeats > 0, "--repeats must be a positive integer");
		for (let repetition = 0; repetition < repeats; repetition++)
			for (const sample of manifest.samples) {
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
					? repetition % 2
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
						piAgentDir: agentDir,
						piSessionDir: join(caseRoot, "sessions"),
						persistPiSessions: true,
					});
					const calls: GitHubQaCall[] = [];
					let hosted: Awaited<ReturnType<typeof agent.createPiInteractiveRuntime>> | undefined;
					try {
						hosted = await agent.createPiInteractiveRuntime({
							extensionFactories: [githubQaTrace(report.runId, calls)],
						});
						const session = hosted.runtime.session;
						await session.bindExtensions({});
						const tools = session.getAllTools().filter((tool) => tool.name.startsWith("mcp__github__"));
						const names = tools.map((tool) => tool.name);
						assert(
							names.length === GITHUB_READ_TOOLS.length &&
								names.every((name) => GITHUB_READ_TOOLS.some((tool) => name === `mcp__github__${tool}`)),
							"GitHub tool directory is incomplete or exposes unselected tools",
						);
						report.L3 = {
							status: "PASS",
							tools,
							serverInfo: null,
							negotiatedProtocol: null,
							note: "Actual Pi tool directory; server version/protocol are not exposed by this observer and still require operator recording.",
						};
						if (exposure === "direct")
							session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "codemode"));
						for (const phase of ["cold", "warm"]) {
							const firstCall = calls.length;
							const started = performance.now();
							const query =
								phase === "cold" && sample.debug === true
									? `请先通过 codemode 发现 GitHub PR 读取工具并输出发现结果，再分析 ${sample.url} 的问题、变更、讨论和当前提交 CI。给出真实证据引用；失败时保留原错误。`
									: `请分析 ${sample.url} 解决的问题、主要修改、讨论中的未决事项和当前提交 CI。读取可用的失败日志，给出来源及不能确认的内容。`;
							assert(
								!(exposure === "direct" && sample.debug === true),
								"Use separate non-debug samples for direct/codemode comparisons",
							);
							const response = await agent.searchDocuments(query);
							const trace = calls.slice(firstCall);
							const mcp = trace.filter((call) => call.tool.startsWith("mcp__github__"));
							const scripts = trace.filter((call) => call.tool === "codemode");
							const substituted = trace.some(
								(call) =>
									!call.tool.startsWith("mcp__github__") &&
									!["codemode", "read", "tool_search"].includes(call.tool),
							);
							const protocolValid =
								mcp.length > 0 &&
								!substituted &&
								(exposure === "direct"
									? scripts.length === 0 && mcp.every((call) => !call.parentToolCallId)
									: mcp.some((call) => !!call.parentToolCallId));
							const entries = session.sessionManager
								.getEntries()
								.filter((entry) => entry.type === "custom" && entry.customType === "autorag.evidence");
							const facts = (sample.expectedText ?? []).map((text: string) => ({
								text,
								present: response.answer.includes(text),
							}));
							const row = {
								sample: sample.id,
								url: sample.url,
								expectedHeadSha: sample.headSha,
								repetition,
								exposure,
								phase,
								debug: sample.debug === true,
								query,
								status: protocolValid && response.results.length > 0 ? "PASS" : "FAIL",
								businessReview: "NOT_RUN",
								ciReview: "NOT_RUN",
								durationMs: performance.now() - started,
								response,
								trace,
								evidence: entries,
								expectedFacts: facts,
								mcpCalls: mcp.length,
								scripts: scripts.length,
							};
							report.cases.push(row);
							if (row.status === "FAIL") process.exitCode = 1;
						}
						const logPath = join(caseRoot, "logs", "runs.jsonl");
						if (existsSync(logPath))
							report.cases[report.cases.length - 1].runLog = readFileSync(logPath, "utf8")
								.trim()
								.split("\n")
								.map((line) => JSON.parse(line));
					} catch (error) {
						report.cases.push({
							sample: sample.id,
							exposure,
							repetition,
							status: "FAIL",
							error: error instanceof Error ? error.stack : String(error),
							trace: calls,
						});
						process.exitCode = 1;
					} finally {
						if (hosted) await hosted.dispose();
						else await agent.indexJobs.close();
					}
				}
			}
		report.L4 = {
			status: report.cases.some((row: any) => row.status === "FAIL") ? "FAIL" : "NOT_RUN",
			note: "Raw real-model runs recorded; manually verify SHA/run/job alignment, claims, citations and CI before declaring business acceptance PASS.",
		};
		report.comparison = {
			status: values.compare ? "NOT_RUN" : "SKIP",
			reason:
				"Paired raw rows retained; review mutable GitHub data and expected facts before comparing. No performance improvement is presumed.",
			totalTokenCost: null,
		};
	}
} catch (error) {
	report.error = error instanceof Error ? error.stack : String(error);
	if (report.L3.status !== "PASS") report.L3 = { status: "FAIL", error: report.error };
	report.L4 = { status: "FAIL", error: report.error };
	process.exitCode = 1;
} finally {
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
