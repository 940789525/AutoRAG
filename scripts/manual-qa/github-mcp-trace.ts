import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface GitHubQaCall {
	runId: string;
	sessionId: string;
	toolCallId: string;
	parentToolCallId?: string;
	tool: string;
	parameters: Record<string, unknown>;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	status: "running" | "success" | "error" | "cancelled";
	result?: unknown;
	responseBytes?: number;
}

const BUSINESS_KEYS = new Set([
	"owner",
	"repo",
	"method",
	"pullNumber",
	"pull_number",
	"issue_number",
	"job_id",
	"run_id",
	"resource_id",
	"page",
	"perPage",
	"per_page",
	"workflow_runs_filter",
	"workflow_jobs_filter",
	"failed_only",
	"return_content",
	"tail_lines",
]);

/** QA-only observer. Actual nested execution events, not script parsing, count MCP requests. */
export function githubQaTrace(runId: string, calls: GitHubQaCall[]): ExtensionFactory {
	return (pi) => {
		const pending = new Map<string, { call: GitHubQaCall; started: number }>();
		pi.on("tool_execution_start", (event, ctx) => {
			const args = event.args as Record<string, unknown>;
			const parameters =
				event.toolName === "codemode"
					? { code: args.code }
					: event.toolName.startsWith("mcp__github__")
						? Object.fromEntries(Object.entries(args).filter(([key]) => BUSINESS_KEYS.has(key)))
						: {};
			const call: GitHubQaCall = {
				runId,
				sessionId: ctx.sessionManager.getSessionId(),
				toolCallId: event.toolCallId,
				...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
				tool: event.toolName,
				parameters,
				startedAt: new Date().toISOString(),
				status: "running",
			};
			calls.push(call);
			pending.set(event.toolCallId, { call, started: performance.now() });
		});
		pi.on("tool_execution_end", (event) => {
			const item = pending.get(event.toolCallId);
			if (!item) return;
			pending.delete(event.toolCallId);
			item.call.finishedAt = new Date().toISOString();
			item.call.durationMs = event.durationMs ?? performance.now() - item.started;
			item.call.status = event.isError ? "error" : "success";
			if (event.toolName === "codemode" || event.toolName.startsWith("mcp__github__")) {
				item.call.result = event.result;
				item.call.responseBytes = Buffer.byteLength(JSON.stringify(event.result));
			}
		});
		pi.on("agent_end", () => {
			for (const { call, started } of pending.values()) {
				call.status = "cancelled";
				call.finishedAt = new Date().toISOString();
				call.durationMs = performance.now() - started;
			}
			pending.clear();
		});
	};
}
