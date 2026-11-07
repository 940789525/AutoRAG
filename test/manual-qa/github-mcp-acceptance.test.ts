import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
	assertGitHubCatalog,
	boundedGitHubSearch,
	type GitHubSample,
	githubPayloads,
	probeGitHub,
	summarizeGitHubComparison,
	summarizeGitHubUsage,
	validateGitHubCase,
	waitForGitHubTools,
} from "../../scripts/manual-qa/github-mcp-acceptance.ts";
import type { GitHubQaCall } from "../../scripts/manual-qa/github-mcp-trace.ts";
import { GITHUB_READ_TOOLS } from "../../src/agent/github-mcp-evidence.ts";

const sample: GitHubSample = {
	id: "pr",
	url: "https://github.com/example/project/pull/42",
	headSha: "abc123",
	public: true,
	expectedText: ["fix"],
	ci: { runId: 77, jobId: 88, failureText: "FAIL unit" },
};
const base = "https://github.com/example/project";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
function call(tool: string, method: string, data: unknown, index: number): GitHubQaCall {
	return {
		runId: "run",
		sessionId: "session",
		toolCallId: String(index),
		tool: `mcp__github__${tool}`,
		parameters: { method },
		startedAt: `2026-11-03T00:00:0${index}.000Z`,
		finishedAt: `2026-11-03T00:00:0${index}.500Z`,
		status: "success",
		result: result(data),
	};
}
const cited = [sample.url, `${base}/actions/runs/77/job/88`];
function trace(): GitHubQaCall[] {
	return [
		call("pull_request_read", "get", { html_url: sample.url, head: { sha: sample.headSha } }, 1),
		call(
			"actions_get",
			"get_workflow_run",
			{ id: 77, head_sha: sample.headSha, html_url: `${base}/actions/runs/77` },
			2,
		),
		call(
			"actions_list",
			"list_workflow_jobs",
			{ jobs: [{ id: 88, run_id: 77, html_url: `${base}/actions/runs/77/job/88` }] },
			3,
		),
		call("get_job_logs", "", { job_id: 88, logs_content: "FAIL unit" }, 4),
	];
}

describe("GitHub QA acceptance gates", () => {
	it("keeps historical, partial, failed and missing provider usage unknown", () => {
		const start = { event: "search_started", usageVersion: 1, sessionId: "s" };
		const usage = {
			event: "model_usage",
			sessionId: "s",
			scope: "answer_session",
			usageReported: true,
			totalTokens: 30,
			cost: 0.01,
		};
		const end = { event: "search_completed", sessionId: "s" };
		expect(summarizeGitHubUsage([start, usage, end])).toMatchObject({
			complete: true,
			fullPipelineTokens: 30,
			totalTokenCost: 0.01,
		});
		for (const events of [
			[{ ...start, usageVersion: undefined }, usage, end],
			[start, usage],
			[start, usage, { ...end, degraded: true }],
			[start, usage, { ...usage, scope: "jev", usageReported: false, totalTokens: null }, end],
			[start, usage, { ...usage, sessionId: "previous" }, end],
		])
			expect(summarizeGitHubUsage(events).fullPipelineTokens).toBeNull();
	});
	it("probes the selected SDK tool catalog and PR identity without a model", async () => {
		const catalog = GITHUB_READ_TOOLS.map((name) => ({
			name,
			inputSchema: { type: "object" as const },
			annotations: { readOnlyHint: true },
		}));
		vi.spyOn(Client.prototype, "connect").mockResolvedValue();
		vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: catalog });
		vi.spyOn(Client.prototype, "getServerVersion").mockReturnValue({ name: "fixture", version: "1" });
		vi.spyOn(Client.prototype, "getNegotiatedProtocolVersion").mockReturnValue("2025-11-25");
		const read = vi
			.spyOn(Client.prototype, "callTool")
			.mockResolvedValue(result({ html_url: sample.url, head: { sha: sample.headSha } }));
		const close = vi.spyOn(Client.prototype, "close").mockResolvedValue();
		try {
			expect(await probeGitHub("fixture-only", [{ ...sample, ci: undefined }])).toMatchObject({
				status: "PASS",
				serverInfo: { name: "fixture" },
				readOnlyVerified: true,
			});
			expect(read).toHaveBeenCalledWith(
				{
					name: "pull_request_read",
					arguments: { owner: "example", repo: "project", pullNumber: 42, method: "get" },
				},
				{ timeout: 15_000 },
			);
			read.mockResolvedValue({
				isError: true,
				content: [{ type: "text", text: "401 Unauthorized /original/path" }],
			});
			await expect(probeGitHub("fixture-only", [sample])).rejects.toThrow("401 Unauthorized /original/path");
			expect(close).toHaveBeenCalledTimes(2);
		} finally {
			vi.restoreAllMocks();
		}
	});
	it("aborts the agent on deadline and rejects even if abort returns a partial answer", async () => {
		let finish!: (answer: string) => void;
		const pending = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const abort = vi.fn(() => finish("partial"));
		const record = vi.fn();
		await expect(boundedGitHubSearch({ searchDocuments: () => pending, abort }, "query", 5, record)).rejects.toThrow(
			"exceeded",
		);
		expect(abort).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledOnce();
	});

	it("stops a frozen CI probe before reading logs when the run belongs to another SHA", async () => {
		const catalog = GITHUB_READ_TOOLS.map((name) => ({
			name,
			inputSchema: { type: "object" as const },
			annotations: { readOnlyHint: true },
		}));
		vi.spyOn(Client.prototype, "connect").mockResolvedValue();
		vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: catalog });
		vi.spyOn(Client.prototype, "close").mockResolvedValue();
		const read = vi
			.spyOn(Client.prototype, "callTool")
			.mockResolvedValueOnce(result({ html_url: sample.url, head: { sha: sample.headSha } }))
			.mockResolvedValueOnce(
				result({ id: 77, head_sha: "other", conclusion: "failure", html_url: base + "/actions/runs/77" }),
			);
		try {
			await expect(probeGitHub("fixture-only", [sample])).rejects.toThrow("failed run for this PR head");
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("checks real payload SHA/job dependencies without claiming human review", () => {
		expect(validateGitHubCase(sample, "direct", trace(), "fix", cited)).toMatchObject({
			status: "NOT_RUN",
			automaticChecks: "PASS",
			businessReview: "NOT_RUN",
			ciReview: "NOT_RUN",
		});
	});

	it("requires the final answer to cite the job and accepts identity-bound plain log text", () => {
		const calls = trace();
		calls[3].result = { content: [{ type: "text", text: "FAIL unit" }] };
		calls[3].parameters = { job_id: 88 };
		expect(validateGitHubCase(sample, "direct", calls, "fix", [sample.url]).failures).toContain(
			"Final answer lacks a citation to the expected CI job",
		);
		expect(validateGitHubCase(sample, "direct", calls, "fix", cited).automaticChecks).toBe("PASS");
	});

	it("rejects drifted PRs, historical CI runs, and logs read before job metadata", () => {
		const stale = trace();
		stale[0].result = result({ html_url: sample.url, head: { sha: "old" } });
		expect(validateGitHubCase(sample, "direct", stale, "fix", cited).failures.join()).toContain("head SHA");
		const oldRun = trace();
		oldRun[1].result = result({ id: 77, head_sha: "old", html_url: `${base}/actions/runs/77` });
		expect(validateGitHubCase(sample, "direct", oldRun, "fix", cited).failures.join()).toContain("target SHA");
		const unordered = trace();
		unordered[2].finishedAt = "2026-11-03T00:00:05.000Z";
		expect(validateGitHubCase(sample, "direct", unordered, "fix", cited).failures.join()).toContain(
			"before reading logs",
		);
	});

	it("rejects cross-repository CI metadata and missing expected facts", () => {
		const wrongRepo = trace();
		wrongRepo[1].result = result({
			id: 77,
			head_sha: sample.headSha,
			html_url: "https://github.com/other/repo/actions/runs/77",
		});
		expect(validateGitHubCase(sample, "direct", wrongRepo, "fix", cited).automaticChecks).toBe("FAIL");
		expect(validateGitHubCase(sample, "direct", trace(), "unrelated", cited).failures).toContain(
			"Expected facts missing from answer",
		);
	});

	it("rejects substituted tools and both kinds of exposure mixing", () => {
		const mixed = trace();
		mixed[0].parentToolCallId = "script";
		expect(validateGitHubCase(sample, "direct", mixed, "fix", cited).failures).toContain("Exposure group mismatch");
		mixed.push({ ...mixed[0], tool: "codemode" });
		expect(validateGitHubCase(sample, "codemode", mixed, "fix", cited).failures).toContain("Exposure group mismatch");
		mixed.push({ ...mixed[0], tool: "bash" });
		expect(validateGitHubCase(sample, "codemode", mixed, "fix", cited).failures).toContain(
			"Non-MCP substitute tool used",
		);
	});

	it("preserves structured SDK and Pi envelopes", () => {
		const data = { html_url: sample.url };
		expect(githubPayloads({ structuredContent: data })).toEqual([data]);
		expect(githubPayloads({ structuredContent: { structuredContent: data, content: [] } })).toEqual([data]);
	});

	it("rejects write tools and tools without a read-only declaration", () => {
		const catalog = GITHUB_READ_TOOLS.map((name) => ({ name, annotations: { readOnlyHint: true } }));
		expect(() => assertGitHubCatalog(catalog)).not.toThrow();
		expect(() =>
			assertGitHubCatalog([...catalog, { name: "merge_pull_request", annotations: { readOnlyHint: false } }]),
		).toThrow();
		expect(() => assertGitHubCatalog(catalog.map((tool) => ({ name: tool.name })))).toThrow("readOnlyHint");
	});

	it("waits for background registration and preserves connection errors or cancellation", async () => {
		let attempts = 0;
		const tools = GITHUB_READ_TOOLS.map((name) => ({ name: `mcp__github__${name}` }));
		const session = { getAllTools: () => (++attempts > 1 ? tools : []) } as unknown as Parameters<
			typeof waitForGitHubTools
		>[0];
		expect(await waitForGitHubTools(session, [])).toEqual(tools);
		const empty = { getAllTools: () => [] };
		await expect(waitForGitHubTools(empty, ["429 rate limit /original/path"])).rejects.toThrow(
			"429 rate limit /original/path",
		);
		await expect(waitForGitHubTools(empty, [], AbortSignal.abort(new Error("cancelled by user")))).rejects.toThrow(
			"cancelled by user",
		);
	});

	it("excludes unreviewed and unmatched pairs from performance conclusions", () => {
		const row = {
			sample: "pr",
			repetition: 0,
			phase: "cold",
			status: "NOT_RUN",
			automaticChecks: "PASS",
			businessReview: "NOT_RUN",
			ciReview: "NOT_RUN",
			durationMs: 100,
			mcpCalls: 4,
		};
		const rows = ["direct", "codemode"].map((exposure) => ({ ...row, exposure }));
		expect(summarizeGitHubComparison(rows)).toMatchObject({ status: "NOT_RUN", totalPairs: 1, eligiblePairs: 0 });
		const reviewed = rows.map((item) => ({
			...item,
			status: "PASS",
			businessReview: "PASS",
			ciReview: "PASS",
			comparable: true,
		}));
		expect(summarizeGitHubComparison(reviewed)).toMatchObject({
			status: "PASS",
			eligiblePairs: 1,
			totalTokenCost: null,
		});
		expect(summarizeGitHubComparison(reviewed.slice(0, 1))).toMatchObject({ status: "NOT_RUN", eligiblePairs: 0 });
	});
});
