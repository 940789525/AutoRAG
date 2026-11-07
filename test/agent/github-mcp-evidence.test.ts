import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { deriveResultsFromAnswer } from "../../src/agent/answer-citations.ts";
import { CitationNumbers } from "../../src/agent/citation-numbers.ts";
import { EvidenceLedger, parseLedgerEntries } from "../../src/agent/evidence-ledger.ts";
import { createGitHubMcpEvidence, GitHubEvidenceAdapter } from "../../src/agent/github-mcp-evidence.ts";

const url = "https://github.com/example/project/pull/42";
const pr = { number: 42, html_url: url, title: "Fix search", body: "Fixes #41", head: { sha: "abc123" } };

function event(tool = "pull_request_read", data: unknown = pr, input: Record<string, unknown> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "script/1",
		parentToolCallId: "script",
		toolName: `mcp__github__${tool}`,
		input: { owner: "example", repo: "project", pullNumber: 42, method: "get", ...input },
		content: [{ type: "text", text: JSON.stringify(data) }],
		structuredContent: { content: [], structuredContent: data } as ToolResultEvent["structuredContent"],
		details: { server: "github", tool },
		isError: false,
	};
}

describe("GitHub MCP evidence contract", () => {
	it("keeps the MCP envelope and business data, and resolves real evidence into results/mapping", () => {
		const ledger = new EvidenceLedger();
		const result = new GitHubEvidenceAdapter(ledger).adapt(event())!;
		expect(result.content).toHaveLength(2);
		expect(result.structuredContent).toMatchObject({
			structuredContent: pr,
			content: [{ type: "text", text: expect.stringContaining("[e1]") }],
		});
		const derived = deriveResultsFromAnswer("修复搜索问题 [e1]。", ledger, {
			allowLocalFiles: false,
			numbers: new CitationNumbers(),
		});
		expect(derived.diagnostics).toEqual([]);
		expect(JSON.stringify(derived.details.results)).toContain(url);
		expect(JSON.stringify(derived.details.mapping)).toContain(url);
		const restored = new EvidenceLedger();
		restored.restore(parseLedgerEntries({ entries: ledger.takeUnsaved() }));
		expect(restored.lookup("e1", { allowLocalFiles: false })[0]).toMatchObject({
			source: url,
			method: "mcp__github__pull_request_read",
		});
	});

	it("supports JSON text results and deduplicates repeated evidence", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		const call = event();
		delete call.structuredContent;
		adapter.adapt(call);
		adapter.adapt(call);
		expect(ledger.takeUnsaved()).toHaveLength(1);
	});

	it("locates diff/files only after a verified PR, retaining the commit and chunk ranges", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		const diff = event("pull_request_read", null, { method: "get_diff" });
		diff.structuredContent = {
			content: [{ type: "text", text: `diff --git a/search.ts b/search.ts\n${"x".repeat(4000)}` }],
		};
		adapter.adapt(diff);
		expect(ledger.takeUnsaved()).toEqual([]);
		adapter.adapt(event());
		adapter.adapt(diff);
		adapter.adapt(event("pull_request_read", [{ filename: "search.ts", patch: "+ fixed" }], { method: "get_files" }));
		const entries = ledger.takeUnsaved();
		expect(entries.filter((entry) => entry.source === `${url}/files`)).toHaveLength(4);
		expect(entries.every((entry) => entry.content.length <= 2000)).toBe(true);
		expect(entries[1]?.evidenceLocation).toContain("abc123");
	});

	it("registers each comment at its own source, including paged containers", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		for (const page of [1, 2])
			adapter.adapt(
				event(
					"pull_request_read",
					{ comments: [{ html_url: `${url}#issuecomment-${page}`, body: `page ${page}` }] },
					{ method: "get_comments", page },
				),
			);
		expect(ledger.takeUnsaved().map((entry) => entry.source)).toEqual([
			`${url}#issuecomment-1`,
			`${url}#issuecomment-2`,
		]);
	});

	it("requires a real job URL before citing plain logs, and forgets identities on reset", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		const logs = event("get_job_logs", null, { job_id: 88 });
		logs.structuredContent = { content: [{ type: "text", text: "test failed: expected 2, got 1" }] };
		adapter.adapt(logs);
		expect(ledger.takeUnsaved()).toEqual([]);
		const jobUrl = "https://github.com/example/project/actions/runs/77/job/88";
		adapter.adapt(event("actions_get", { id: 88, html_url: jobUrl, run_id: 77, head_sha: "abc123" }));
		adapter.adapt(logs);
		expect(ledger.takeUnsaved()).toHaveLength(2);
		adapter.adapt(
			event(
				"get_job_logs",
				{
					logs: [
						{ job_id: 88, logs_content: "another failure", original_length: 900 },
						{ job_id: 99, error: "403 Forbidden" },
					],
				},
				{ run_id: 77 },
			),
		);
		expect(ledger.takeUnsaved()[0]?.content).toContain("original lines 900");
		adapter.clear();
		adapter.adapt(logs);
		expect(ledger.takeUnsaved()).toEqual([]);
	});

	it("cites snake-case review threads and check-run URLs, retaining unread-page diagnostics", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		const reviewUrl = `${url}#discussion_r123`;
		const result = adapter.adapt(
			event(
				"pull_request_read",
				{
					review_threads: [{ comments: { nodes: [{ url: reviewUrl, body: "Please fix the edge case" }] } }],
					pageInfo: { hasNextPage: true },
				},
				{ method: "get_review_comments", page: 2 },
			),
		);
		expect(JSON.stringify(result)).toContain("unread pages");
		adapter.adapt(
			event(
				"pull_request_read",
				{
					check_runs: [
						{
							id: 99,
							status: "completed",
							conclusion: "failure",
							html_url: "https://github.com/example/project/runs/99",
						},
					],
				},
				{ method: "get_check_runs" },
			),
		);
		const entries = ledger.takeUnsaved();
		expect(entries.map((entry) => entry.source)).toEqual([reviewUrl, "https://github.com/example/project/runs/99"]);
		expect(entries[0]?.evidenceLocation).toContain("page 2");
		const answer = deriveResultsFromAnswer("评审提出边界问题 [e1]，检查失败 [e2]。", ledger, {
			allowLocalFiles: false,
			numbers: new CitationNumbers(),
		});
		expect(answer.diagnostics).toEqual([]);
		expect(answer.details.results).toHaveLength(2);
	});

	it("retains verified PR evidence when the next PR is missing and a job log has expired", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		adapter.adapt(event());
		const missing = event("pull_request_read", null, { pullNumber: 404 });
		const expired = event("get_job_logs", null, { job_id: 89 });
		for (const [input, message] of [
			[missing, "404 Not Found"],
			[expired, "410 Gone"],
		] as const) {
			input.structuredContent = { isError: true, content: [{ type: "text", text: message }] };
			expect(adapter.adapt(input)).toBeUndefined();
			expect(input.structuredContent.content).toEqual([{ type: "text", text: message }]);
		}
		expect(ledger.takeUnsaved().map((entry) => entry.source)).toEqual([url]);
	});

	it("does not turn errors, empty/unknown shapes, wrong identities or untrusted tools into evidence", () => {
		const ledger = new EvidenceLedger();
		const adapter = new GitHubEvidenceAdapter(ledger);
		const error = event();
		error.structuredContent = { isError: true, content: [{ type: "text", text: "403 Forbidden /private/path" }] };
		expect(adapter.adapt(error)).toBeUndefined();
		const other = event();
		other.details = { server: "other", tool: "pull_request_read" };
		expect(adapter.adapt(other)).toBeUndefined();
		for (const data of [
			[],
			{ surprise: "unknown" },
			{ ...pr, html_url: `${url}0`, number: 420 },
			{ ...pr, html_url: "https://evil.example/example/project/pull/42" },
		])
			adapter.adapt(event("pull_request_read", data));
		expect(ledger.takeUnsaved()).toEqual([]);
	});
});

describe("GitHub MCP extension lifecycle", () => {
	it("ignores aborted, duplicate, stale-session and shutdown results", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const ledger = new EvidenceLedger();
		const api = {
			on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
			getMcpServers: () => [{ name: "github" }],
		} as unknown as ExtensionAPI;
		await createGitHubMcpEvidence(ledger)(api);
		let session = "first";
		const controller = new AbortController();
		const ctx = { sessionManager: { getSessionId: () => session }, signal: controller.signal };
		const call = event();
		handlers.get("tool_call")!(call, ctx);
		controller.abort();
		expect(handlers.get("tool_result")!(call, ctx)).toBeUndefined();
		ctx.signal = new AbortController().signal;
		handlers.get("tool_call")!(call, ctx);
		session = "second";
		expect(handlers.get("tool_result")!(call, ctx)).toBeUndefined();
		handlers.get("tool_call")!(call, ctx);
		handlers.get("session_tree")!();
		expect(handlers.get("tool_result")!(call, ctx)).toBeUndefined();
		handlers.get("tool_call")!(call, ctx);
		handlers.get("session_shutdown")!();
		expect(handlers.get("tool_result")!(call, ctx)).toBeUndefined();
		expect(ledger.takeUnsaved()).toEqual([]);
		handlers.get("session_start")!();
		handlers.get("tool_call")!(call, ctx);
		expect(handlers.get("tool_result")!(call, ctx)?.content).toBeDefined();
		expect(handlers.get("tool_result")!(call, ctx)).toBeUndefined();
		expect(ledger.takeUnsaved()).toHaveLength(1);
	});
});
