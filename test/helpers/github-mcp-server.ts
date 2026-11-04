/** Synthetic GitHub-shaped service. stdout is reserved for the real MCP protocol. */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "github-fixture", version: "1.0.0" });
const base = "https://github.com/example/project";
const repository = {
	owner: z.string(),
	repo: z.string(),
};
const json = (data: Record<string, unknown>) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
	structuredContent: data,
});
server.registerTool(
	"pull_request_read",
	{
		description: "Read PR details, files, diff or comments",
		inputSchema: z
			.object({
				...repository,
				pullNumber: z.number(),
				method: z.enum(["get", "get_diff", "get_files", "get_comments"]),
			})
			.strict(),
	},
	async (args) => {
		if (args.method === "get_comments")
			return {
				isError: true,
				content: [{ type: "text", text: "403 Forbidden: comments unavailable /fixture/comments" }],
			};
		if (args.method === "get_diff")
			return {
				content: [{ type: "text", text: "diff --git a/search.ts b/search.ts\n- return []\n+ return matches" }],
			};
		return json({
			number: 42,
			title: "Fix empty search",
			body: "Fixes #41",
			html_url: `${base}/pull/42`,
			head: { sha: "abc123" },
		});
	},
);
server.registerTool(
	"issue_read",
	{
		description: "Read a linked issue",
		inputSchema: z
			.object({
				...repository,
				method: z.enum(["get", "get_comments"]),
				issue_number: z.number(),
			})
			.strict(),
	},
	async () => json({ number: 41, html_url: `${base}/issues/41`, body: "Search returns no results" }),
);
server.registerTool(
	"actions_list",
	{
		description: "List CI runs or jobs",
		inputSchema: z
			.object({
				...repository,
				method: z.enum(["list_workflow_runs", "list_workflow_jobs"]),
				resource_id: z.string().optional(),
			})
			.strict(),
	},
	async (args) =>
		args.method === "list_workflow_jobs"
			? json({ jobs: [{ id: 88, run_id: 77, conclusion: "failure", html_url: `${base}/actions/runs/77/job/88` }] })
			: json({
					workflow_runs: [
						{ id: 77, head_sha: "abc123", conclusion: "failure", html_url: `${base}/actions/runs/77` },
					],
				}),
);
server.registerTool(
	"actions_get",
	{
		description: "Read a CI run",
		inputSchema: z
			.object({
				...repository,
				method: z.enum(["get_workflow_run"]),
				resource_id: z.string(),
			})
			.strict(),
	},
	async () => json({ id: 77, head_sha: "abc123", conclusion: "failure", html_url: `${base}/actions/runs/77` }),
);
server.registerTool(
	"get_job_logs",
	{
		description: "Read a job log",
		inputSchema: z
			.object({
				...repository,
				job_id: z.number(),
			})
			.strict(),
	},
	async () =>
		json({
			job_id: 88,
			logs_content: "Run unit tests\nFAIL search.test.ts: expected 2 results, got 0",
			original_length: 200,
		}),
);
await server.connect(new StdioServerTransport());
