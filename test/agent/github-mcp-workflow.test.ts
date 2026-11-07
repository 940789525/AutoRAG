import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { resolveGrammarConstrainedSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { MockBackend } from "jev-use";
import { describe, expect, it } from "vitest";
import { type GitHubQaCall, githubQaTrace } from "../../scripts/manual-qa/github-mcp-trace.ts";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { CitationNumbers } from "../../src/agent/citation-numbers.ts";
import { ConversationQueries } from "../../src/agent/conversation-queries.ts";
import { EVIDENCE_ENTRY_TYPE, EvidenceLedger } from "../../src/agent/evidence-ledger.ts";
import { restoreConversationState } from "../../src/agent/evidence-persistence.ts";
import {
	DECOMPOSE_QUESTION_ID,
	FOLLOW_UP_QUESTION_ID,
	QUERY_ROUTE_QUESTION_ID,
} from "../../src/agent/query-routing.ts";
import { inertUi } from "../helpers/inert-ui.ts";

const server = fileURLToPath(new URL("../helpers/github-mcp-server.ts", import.meta.url));
const repository = { owner: "example", repo: "project" };
const input = { ...repository, pullNumber: 42, method: "get" };
const call = (tool: string, args: Record<string, string | number>, exposure: string): FauxResponseStep =>
	fauxAssistantMessage(
		[
			exposure === "direct"
				? fauxToolCall(`mcp__github__${tool}`, args)
				: fauxToolCall("codemode", { code: `return await tools.mcp__github__${tool}(${JSON.stringify(args)});` }),
		],
		{ stopReason: "toolUse" },
	);

describe("GitHub evidence through the real Pi MCP pipeline (synthetic service/model)", () => {
	for (const mode of ["headless", "tui"])
		for (const exposure of ["direct", "codemode"]) {
			it(`${mode}: ${exposure} preserves actual sources, partial errors, CI evidence and citations`, async () => {
				const root = mkdtempSync(join(tmpdir(), "autorag-github-workflow-"));
				const agentDir = join(root, "pi");
				mkdirSync(agentDir);
				writeFileSync(
					join(agentDir, "mcp.json"),
					JSON.stringify({ mcpServers: { github: { command: process.execPath, args: [server], exposure } } }),
				);
				const registration = registerFauxProvider({
					api: `faux-github-${randomUUID()}`,
					models: [{ id: "github-test" }],
				});
				const responses: FauxResponseStep[] = [
					...(exposure === "codemode"
						? [
								(context: Context) => {
									const tool = getCurrentTools(context.messages).find((entry) => entry.name === "codemode");
									if (!tool) throw new Error("codemode was not declared");
									// Use the provider's real validation: faux responses alone do not enforce grammar schemas.
									expect(resolveGrammarConstrainedSampling(tool, true)).toMatchObject({
										inputProperty: "code",
									});
									return fauxAssistantMessage(
										[fauxToolCall("codemode", { code: 'return searchTools("github pull request");' })],
										{ stopReason: "toolUse" },
									);
								},
							]
						: []),
					call("pull_request_read", input, exposure),
					call("issue_read", { ...repository, method: "get", issue_number: 41 }, exposure),
					...(exposure === "codemode"
						? [
								fauxAssistantMessage(
									[
										fauxToolCall("codemode", {
											code: `return await Promise.allSettled([tools.mcp__github__pull_request_read(${JSON.stringify({ ...input, method: "get_diff" })}), tools.mcp__github__pull_request_read(${JSON.stringify({ ...input, method: "get_comments" })})]);`,
										}),
									],
									{ stopReason: "toolUse" },
								),
							]
						: [
								call("pull_request_read", { ...input, method: "get_diff" }, exposure),
								call("pull_request_read", { ...input, method: "get_comments" }, exposure),
							]),
					call("actions_list", { ...repository, method: "list_workflow_runs" }, exposure),
					call("actions_list", { ...repository, method: "list_workflow_jobs", resource_id: "77" }, exposure),
					call("get_job_logs", { ...repository, job_id: 88 }, exposure),
					(context) => {
						const text = JSON.stringify(context.messages);
						expect(text).toContain("403 Forbidden: comments unavailable /fixture/comments");
						expect(text).toContain("FAIL search.test.ts");
						expect(text).toContain("github-pr-analysis");
						return fauxAssistantMessage(
							"修复空搜索结果 [e1]，关联问题描述搜索无结果 [e2]。日志显示测试预期 2 条而实际为 0 [e6]。评论读取失败：403 Forbidden: comments unavailable /fixture/comments。",
							{ stopReason: "stop" },
						);
					},
				];
				registration.setResponses(responses);
				const agent = new AutoRAGAgent({
					model: registration.getModel(),
					apiKey: "test-key",
					searchPaths: [root],
					workspacePath: root,
					memoryPath: join(root, "memory.json"),
					piAgentDir: agentDir,
					piSessionDir: join(root, "sessions"),
					minSync: { autoInstall: false },
					jikji: false,
					jev: {
						backend: new MockBackend({
							[QUERY_ROUTE_QUESTION_ID]: {
								answer: "extra",
								distribution: { local: 0.1, organize: 0.1, extra: 0.8 },
								confidence: 0.8,
							},
							[DECOMPOSE_QUESTION_ID]: { answer: 0.1 },
							[FOLLOW_UP_QUESTION_ID]: { answer: 0.1 },
						}),
					},
				});
				const calls: GitHubQaCall[] = [];
				const events: Record<string, unknown>[] = [];
				const hosted =
					mode === "tui"
						? await agent.createPiInteractiveRuntime({
								extensionFactories: [
									githubQaTrace("fixture", calls, (event) => {
										events.push(event);
									}),
								],
							})
						: undefined;
				try {
					if (hosted) {
						await hosted.runtime.session.bindExtensions({ uiContext: inertUi([]) });
						expect(hosted.runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain(
							"github-pr-analysis",
						);
					}
					const response = await agent.searchDocuments(
						"分析 https://github.com/example/project/pull/42 的修改和失败 CI",
					);
					expect(response.results.length).toBeGreaterThanOrEqual(2);
					expect(JSON.stringify(response)).toContain("https://github.com/example/project/actions/runs/77/job/88");
					expect(response.results[0]?.source).toBe("https://github.com/example/project/pull/42");
					if (hosted) {
						const session = hosted.runtime.session;
						const restored = new EvidenceLedger();
						restoreConversationState(
							restored,
							new CitationNumbers(),
							new ConversationQueries(),
							session.sessionManager,
						);
						expect(restored.lookup("e6", { allowLocalFiles: false })[0]?.source).toContain("/job/88");
						const business = calls.filter((call) => call.tool.startsWith("mcp__github__"));
						expect(business).toHaveLength(7);
						for (const call of business) {
							expect(
								events.filter((event) => event.toolCallId === call.toolCallId).map((event) => event.status),
							).toEqual(["running", call.status]);
						}
						expect(business.every((call) => call.durationMs !== undefined)).toBe(true);
						expect(business.some((call) => call.status === "error")).toBe(true);
						expect(business.every((call) => !!call.parentToolCallId)).toBe(exposure === "codemode");
						expect(
							session.sessionManager
								.getEntries()
								.some((entry) => entry.type === "custom" && entry.customType === EVIDENCE_ENTRY_TYPE),
						).toBe(true);
						expect(session.getAllTools().filter((tool) => tool.name.startsWith("mcp__github__"))).toHaveLength(5);
						const nested = session.messages.flatMap((message) =>
							message.role === "toolResult" && message.nestedCalls ? [message.nestedCalls] : [],
						);
						expect(nested.length > 0).toBe(exposure === "codemode");
					}
				} finally {
					await hosted?.dispose();
					await agent.indexJobs.close();
					registration.unregister();
					rmSync(root, { recursive: true, force: true });
				}
			});
		}
});
