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
export function githubQaTrace(
	runId: string,
	calls: GitHubQaCall[],
	record?: (event: Record<string, unknown>) => void,
): ExtensionFactory {
	return (pi) => {
		if (record) {
			pi.on("before_provider_request", () => { record({ event: "model_request" }); });
			pi.on("message_end", ({ message }) => {
				if (message.role === "assistant") record({ event: "model_end", stopReason: message.stopReason });
			});
		}
		const checkpoint = (call: GitHubQaCall) => record?.({
			event: "tool", tool: call.tool, toolCallId: call.toolCallId, parentToolCallId: call.parentToolCallId,
			method: call.parameters.method, status: call.status, durationMs: call.durationMs, responseBytes: call.responseBytes,
		});
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
			checkpoint(call);
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
			checkpoint(item.call);
		});
		pi.on("agent_end", () => {
			for (const { call, started } of pending.values()) {
				call.status = "cancelled";
				call.finishedAt = new Date().toISOString();
				call.durationMs = performance.now() - started;
				checkpoint(call);
			}
			pending.clear();
		});
	};
}
