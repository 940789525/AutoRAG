import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GITHUB_READ_TOOLS } from "../../src/agent/github-mcp-evidence.ts";
import type { GitHubQaCall } from "./github-mcp-trace.ts";

export interface GitHubSample {
	id: string;
	url: string;
	headSha: string;
	public: boolean;
	expectedText: string[];
	question?: string;
	debug?: boolean;
	ci?: { runId: number; jobId: number; failureText: string };
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Read the actual MCP payload, never the assistant's account of it. */
export function githubPayloads(result: unknown): unknown[] {
	const outer = object(result);
	const envelope = object(outer?.structuredContent);
	if (envelope?.structuredContent !== undefined) return [envelope.structuredContent];
	if (envelope && !Array.isArray(envelope.content)) return [envelope];
	const blocks = envelope?.content ?? outer?.content;
	return Array.isArray(blocks)
		? blocks.flatMap((block) => {
				const text = object(block)?.text;
				if (typeof text !== "string" || text.startsWith("AutoRAG evidence") || text.startsWith("GitHub evidence:"))
					return [];
				try {
					return [JSON.parse(text)];
				} catch {
					return [text];
				}
			})
		: [];
}

function objects(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(objects);
	const item = object(value);
	return item ? [item, ...Object.values(item).flatMap(objects)] : [];
}

export function assertGitHubCatalog(
	tools: readonly { name: string; annotations?: { readOnlyHint?: boolean } }[],
): void {
	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		[...GITHUB_READ_TOOLS].sort(),
		"Unexpected GitHub tool directory",
	);
	assert(
		tools.every((tool) => tool.annotations?.readOnlyHint === true),
		"GitHub tools must declare readOnlyHint=true",
	);
}

/** Session binding starts MCP connections in the background; it is not a readiness barrier. */
export async function waitForGitHubTools(
	session: Pick<AgentSession, "getAllTools">,
	notices: string[],
	signal?: AbortSignal,
) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		const tools = session.getAllTools().filter((tool) => tool.name.startsWith("mcp__github__"));
		if (tools.length) {
			assert.deepEqual(
				tools.map((tool) => tool.name).sort(),
				GITHUB_READ_TOOLS.map((name) => `mcp__github__${name}`).sort(),
			);
			return tools;
		}
		if (notices.length) throw new Error(notices.join("\n"));
		await sleep(25, undefined, { signal });
	}
	throw new Error(`GitHub MCP tool directory was not ready within 15000ms. ${notices.join("\n")}`);
}

/** Stop the model session as well as timing out the case. An aborted search can return a degraded answer. */
export async function boundedGitHubSearch<T>(
	agent: { searchDocuments(query: string): Promise<T>; abort(): void },
	query: string,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`GitHub QA search exceeded ${timeoutMs}ms`));
			agent.abort();
			onTimeout();
		}, timeoutMs);
	});
	try {
		return await Promise.race([agent.searchDocuments(query), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** QA-only use of the installed SDK: no custom transport or product MCP client. */
export async function probeGitHub(token: string, samples: GitHubSample[]) {
	const client = new Client({ name: "autorag-github-qa", version: "1" });
	const transport = new StreamableHTTPClientTransport(new URL("https://api.githubcopilot.com/mcp/"), {
		requestInit: {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-MCP-Readonly": "true",
				"X-MCP-Tools": GITHUB_READ_TOOLS.join(","),
			},
		},
	});
	try {
		await client.connect(transport, { timeout: 15_000 });
		const tools = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools({ cursor }, { timeout: 15_000 });
			tools.push(...page.tools);
			cursor = page.nextCursor;
		} while (cursor);
		assertGitHubCatalog(tools);
		const reads = [];
		for (const sample of samples) {
			const [, owner, repo, , number] = new URL(sample.url).pathname.split("/");
			const read = async (name: string, args: Record<string, unknown>) => {
				const result = await client.callTool({ name, arguments: { owner, repo, ...args } }, { timeout: 15_000 });
				assert(!result.isError, JSON.stringify(result));
				return result;
			};
			const result = await read("pull_request_read", { pullNumber: Number(number), method: "get" });
			const pr = githubPayloads(result).flatMap(objects).find((item) => item.html_url === sample.url);
			assert.equal(object(pr?.head)?.sha, sample.headSha, `Frozen PR head changed: ${sample.url}`);
			reads.push({ sample: sample.id, result });
			if (sample.ci) {
				const { runId, jobId, failureText } = sample.ci;
				assert(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(jobId) && jobId > 0 && failureText?.trim(), "Invalid frozen CI identity or failure text");
				const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
				const run = await read("actions_get", { method: "get_workflow_run", resource_id: String(runId) });
				assert(githubPayloads(run).flatMap(objects).some(r => r.id === runId && r.head_sha === sample.headSha && r.html_url === runUrl && r.conclusion === "failure"), "Frozen CI run does not identify a failed run for this PR head");
				const job = await read("actions_get", { method: "get_workflow_job", resource_id: String(jobId) });
				assert(githubPayloads(job).flatMap(objects).some(j => j.id === jobId && j.run_id === runId && j.html_url === `${runUrl}/job/${jobId}` && j.conclusion === "failure"), "Frozen CI job is not a failed job in this run");
				const log = await read("get_job_logs", { job_id: jobId, return_content: true, tail_lines: 150 });
				assert(githubPayloads(log).some(payload => typeof payload === "string" ? payload.includes(failureText) : objects(payload).some(l => l.job_id === jobId && typeof l.logs_content === "string" && l.logs_content.includes(failureText))), "Expected failure missing from returned CI log excerpt");
				for (const response of [run, job, log]) reads.push({ sample: sample.id, result: response });
			}
		}
		return {
			status: "PASS",
			serverInfo: client.getServerVersion(),
			negotiatedProtocol: client.getNegotiatedProtocolVersion(),
			toolCatalogDigest: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
			readOnlyVerified: true,
			tools,
			reads,
		};
	} finally {
		await client.close();
	}
}

export function validateGitHubCase(
	sample: GitHubSample,
	exposure: string,
	trace: GitHubQaCall[],
	answer: string,
	resolvedSources: readonly (string | undefined)[],
) {
	const failures: string[] = [];
	const mcp = trace.filter((call) => call.tool.startsWith("mcp__github__"));
	const scripts = trace.filter((call) => call.tool === "codemode");
	if (!mcp.length) failures.push("No actual GitHub MCP call");
	if (
		trace.some(
			(call) => !call.tool.startsWith("mcp__github__") && !["codemode", "read", "tool_search"].includes(call.tool),
		)
	)
		failures.push("Non-MCP substitute tool used");
	if (
		exposure === "direct"
			? scripts.length > 0 || mcp.some((call) => call.parentToolCallId)
			: !scripts.length || !mcp.length || mcp.some((call) => !call.parentToolCallId)
	)
		failures.push("Exposure group mismatch");
	if (!resolvedSources.some(Boolean)) failures.push("No resolved evidence citations");
	const prReads = mcp.filter(
		(call) =>
			call.tool === "mcp__github__pull_request_read" &&
			call.parameters.method === "get" &&
			call.status === "success",
	);
	const prs = prReads
		.flatMap((call) => githubPayloads(call.result).flatMap(objects))
		.filter((item) => item.html_url === sample.url);
	if (!prs.length || prs.some((pr) => object(pr.head)?.sha !== sample.headSha))
		failures.push("PR identity/head SHA is missing or differs from frozen sample");
	const expectedFacts = sample.expectedText.map((text) => ({ text, present: answer.includes(text) }));
	if (expectedFacts.some((fact) => !fact.present)) failures.push("Expected facts missing from answer");
	const logs = mcp.filter((call) => call.tool === "mcp__github__get_job_logs" && call.status === "success");
	const repoUrl = sample.url.split("/pull/")[0];
	for (const log of logs) {
		const prior = mcp.filter(
			(call) => call.status === "success" && call.finishedAt && call.finishedAt <= log.startedAt,
		);
		const metadata = prior.flatMap((call) => githubPayloads(call.result).flatMap(objects));
		const jobIds = githubPayloads(log.result)
			.flatMap(objects)
			.filter((item) => typeof item.logs_content === "string")
			.map((item) => item.job_id);
		if (!jobIds.length && log.parameters.job_id !== undefined) jobIds.push(log.parameters.job_id);
		if (!jobIds.length) failures.push("Log has no verifiable job identity");
		for (const id of jobIds) {
			const job = metadata.find(
				(item) =>
					String(item.id) === String(id) &&
					item.run_id !== undefined &&
					item.html_url === `${repoUrl}/actions/runs/${item.run_id}/job/${id}`,
			);
			const run = metadata.find(
				(item) =>
					String(item.id) === String(job?.run_id) &&
					item.head_sha === sample.headSha &&
					item.html_url === `${repoUrl}/actions/runs/${item.id}`,
			);
			if (sample.ci && String(id) === String(sample.ci.jobId) && String(job?.run_id) !== String(sample.ci.runId))
				failures.push("Expected CI job belongs to a different run");
			if (!job || !run) failures.push(`Job ${id} was not linked to the target SHA before reading logs`);
		}
	}
	if (sample.ci) {
		const ci = sample.ci;
		if (!resolvedSources.includes(`${repoUrl}/actions/runs/${ci.runId}/job/${ci.jobId}`))
			failures.push("Final answer lacks a citation to the expected CI job");
		if (!logs.some(call => githubPayloads(call.result).some(payload =>
			typeof payload === "string"
				? String(call.parameters.job_id) === String(ci.jobId) && payload.includes(ci.failureText)
				: objects(payload).some(item => String(item.job_id) === String(ci.jobId) &&
					typeof item.logs_content === "string" && item.logs_content.includes(ci.failureText))
		))) failures.push("Expected CI failure log not read");
		if (
			!mcp.some(
				(call) =>
					call.status === "success" &&
					githubPayloads(call.result)
						.flatMap(objects)
						.some((item) => String(item.id) === String(ci.runId) && item.head_sha === sample.headSha),
			)
		)
			failures.push("Expected CI run/SHA not verified");
	}
	return {
		status: failures.length ? "FAIL" : "NOT_RUN",
		automaticChecks: failures.length ? "FAIL" : "PASS",
		failures,
		expectedFacts,
		businessReview: "NOT_RUN",
		ciReview: sample.ci ? "NOT_RUN" : "NOT_APPLICABLE",
	};
}

/** Raw measurements stay separate from human-reviewed, comparable business results. */
export function summarizeGitHubComparison(rows: Record<string, any>[]) {
	const pairs = new Map<string, Record<string, any>[]>();
	for (const row of rows.filter((row) => !row.debug)) {
		const key = `${row.sample}/${row.repetition}/${row.phase}`;
		pairs.set(key, [...(pairs.get(key) ?? []), row]);
	}
	const eligible = [...pairs].filter(
		([, pair]) =>
			pair.length === 2 &&
			new Set(pair.map((row) => row.exposure)).size === 2 &&
			pair.every(
				(row) =>
					row.status === "PASS" &&
					row.automaticChecks === "PASS" &&
					row.businessReview === "PASS" &&
					["PASS", "NOT_APPLICABLE"].includes(row.ciReview) &&
					row.comparable === true,
			),
	);
	const median = (values: number[]) => {
		values.sort((a, b) => a - b);
		const middle = Math.floor(values.length / 2);
		return values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null;
	};
	return {
		status: rows.some((row) => row.status === "FAIL")
			? "FAIL"
			: pairs.size > 0 && eligible.length === pairs.size
				? "PASS"
				: "NOT_RUN",
		totalPairs: pairs.size,
		eligiblePairs: eligible.length,
		totalRows: rows.length,
		failedRows: rows.filter((row) => row.status === "FAIL").length,
		skippedRows: rows.filter((row) => row.status === "SKIP").length,
		metrics: ["cold", "warm"].flatMap((phase) =>
			["direct", "codemode"].map((exposure) => {
				const group = eligible
					.flatMap(([, pair]) => pair)
					.filter((row) => row.phase === phase && row.exposure === exposure);
				const raw = rows.filter((row) => row.phase === phase && row.exposure === exposure);
				const usage = group.flatMap((row) => row.modelUsage ?? []);
				const reviewed = raw.filter((row) => row.businessReview === "PASS" || row.businessReview === "FAIL");
				const checked = reviewed.reduce((sum, row) => sum + (row.citationsChecked ?? 0), 0);
				const citationValidityRate = checked
					? reviewed.reduce((sum, row) => sum + (row.citationsValid ?? 0), 0) / checked
					: null;
				const tokens = Object.fromEntries(
					["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map((key) => [
						key,
						usage.length && usage.every((event) => typeof event[key] === "number")
							? usage.reduce((sum, event) => sum + event[key], 0)
							: null,
					]),
				);
				return {
					phase,
					exposure,
					total: raw.length,
					failed: raw.filter((row) => row.status === "FAIL").length,
					unreviewed: raw.filter((row) => row.status === "NOT_RUN").length,
					measured: group.length,
					taskCompletionRate: raw.length ? raw.filter((row) => row.status === "PASS").length / raw.length : null,
					citationValidityRate,
					medianDurationMs: median(group.map((row) => row.durationMs)),
					mcpCalls: group.reduce((sum, row) => sum + row.mcpCalls, 0),
					modelCalls: usage.length,
					tokens,
				};
			}),
		),
		totalTokenCost: null,
		usageScope: "Raw per-phase model usage retained; complete routing/planning cost is not measured.",
	};
}
