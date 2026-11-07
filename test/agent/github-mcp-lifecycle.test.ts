import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { MockBackend } from "jev-use";
import { expect, it } from "vitest";
import { waitForGitHubTools } from "../../scripts/manual-qa/github-mcp-acceptance.ts";
import { type GitHubQaCall, githubQaTrace } from "../../scripts/manual-qa/github-mcp-trace.ts";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { DECOMPOSE_QUESTION_ID, QUERY_ROUTE_QUESTION_ID } from "../../src/agent/query-routing.ts";
import { inertUi } from "../helpers/inert-ui.ts";

const server = fileURLToPath(new URL("../helpers/github-mcp-server.ts", import.meta.url));
const pr = (pullNumber: number) => ({ owner: "example", repo: "project", method: "get", pullNumber });
const answer = (context: Context) => {
	const ids = [...JSON.stringify(context.messages).matchAll(/\[(e\d+)\]/gu)];
	return fauxAssistantMessage(`PR evidence [${ids.at(-1)?.[1]}]`, { stopReason: "stop" });
};
const read = (pullNumber: number, exposure: string) =>
	fauxAssistantMessage(
		[
			exposure === "direct"
				? fauxToolCall("mcp__github__pull_request_read", pr(pullNumber))
				: fauxToolCall("codemode", {
						code: `return await tools.mcp__github__pull_request_read(${JSON.stringify(pr(pullNumber))});`,
					}),
		],
		{ stopReason: "toolUse" },
	);

async function fixture(exposure: string, steps: FauxResponseStep[]) {
	const root = mkdtempSync(join(tmpdir(), "autorag-github-lifecycle-"));
	const agentDir = join(root, "pi");
	const events = join(root, "requests.jsonl");
	const release = () => writeFileSync(join(root, "release"), "");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				github: {
					command: process.execPath,
					args: [server],
					exposure,
					env: { GITHUB_FIXTURE_EVENTS: events, GITHUB_FIXTURE_RELEASE: join(root, "release") },
				},
			},
		}),
	);
	const model = registerFauxProvider({ api: `faux-github-lifecycle-${randomUUID()}`, models: [{ id: "test" }] });
	model.setResponses(steps);
	const agent = new AutoRAGAgent({
		model: model.getModel(),
		apiKey: "fixture",
		searchPaths: [root],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		piAgentDir: agentDir,
		piSessionDir: join(root, "sessions"),
		minSync: { autoInstall: false },
		jikji: false,
		jev: {
			backend: new MockBackend({
				[QUERY_ROUTE_QUESTION_ID]: { answer: "local", confidence: 1 },
				[DECOMPOSE_QUESTION_ID]: { answer: 0.1 },
			}),
		},
	});
	const calls: GitHubQaCall[] = [];
	const hosted = await agent.createPiInteractiveRuntime({ extensionFactories: [githubQaTrace("lifecycle", calls)] });
	const notices: string[] = [];
	await hosted.runtime.session.bindExtensions({ uiContext: inertUi(notices) });
	await waitForGitHubTools(hosted.runtime.session, notices);
	return {
		agent,
		hosted,
		model,
		calls,
		release,
		events: () =>
			existsSync(events)
				? readFileSync(events, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
		close: async () => {
			release();
			try {
				await hosted.dispose();
			} finally {
				await agent.indexJobs.close();
				model.unregister();
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

for (const exposure of ["direct", "codemode"]) {
	it(`${exposure}: abort reaches a real MCP request, stops dependent reads and isolates the next turn/session`, async () => {
		const dependent =
			exposure === "codemode"
				? fauxAssistantMessage(
						[
							fauxToolCall("codemode", {
								code: `await tools.mcp__github__pull_request_read(${JSON.stringify(pr(44))}); return await tools.mcp__github__issue_read({owner:"example",repo:"project",method:"get",issue_number:41});`,
							}),
						],
						{ stopReason: "toolUse" },
					)
				: read(44, exposure);
		const followUp = fauxAssistantMessage(
			[
				fauxToolCall("mcp__github__issue_read", {
					owner: "example",
					repo: "project",
					method: "get",
					issue_number: 41,
				}),
			],
			{ stopReason: "toolUse" },
		);
		const host = await fixture(exposure, exposure === "direct" ? [dependent, followUp, answer] : [dependent, answer]);
		try {
			const pending = host.agent.searchDocuments("Read PR 44 and then its issue");
			await expect
				.poll(() => host.events().some((e) => e.event === "request" && e.input.pullNumber === 44))
				.toBe(true);
			host.agent.abort();
			const stopped = await pending;
			expect(stopped.results).toEqual([]);
			host.model.setResponses([read(42, exposure), answer]);
			const nextSearch = host.agent.searchDocuments("Read PR 42");
			host.release();
			const next = await nextSearch;
			await expect.poll(() => host.events().some((e) => e.event === "late-response")).toBe(true);
			expect(host.events().some((e) => e.event === "cancelled")).toBe(true);
			expect(host.events().some((e) => e.input.issue_number !== undefined)).toBe(false);
			expect(next.results.map((r) => r.source)).toEqual(["https://github.com/example/project/pull/42"]);
			const saved = JSON.stringify(host.hosted.runtime.session.sessionManager.getEntries());
			expect(saved).not.toContain('"source":"https://github.com/example/project/pull/44"');
			await host.hosted.runtime.newSession();
			await host.hosted.runtime.session.bindExtensions({ uiContext: inertUi([]) });
			await waitForGitHubTools(host.hosted.runtime.session, []);
			host.model.setResponses([read(42, exposure), answer]);
			const fresh = await host.agent.searchDocuments("Read PR 42 in the new session");
			expect(fresh.results.map((r) => r.source)).toEqual(["https://github.com/example/project/pull/42"]);
		} finally {
			await host.close();
		}
	});

	it(`${exposure}: a real server disconnect retains earlier evidence and the transport error`, async () => {
		const host = await fixture(exposure, [
			read(42, exposure),
			read(45, exposure),
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text).toMatch(/closed|disconnect|exited/iu);
				return answer(context);
			},
		]);
		try {
			const result = await host.agent.searchDocuments("Read PR 42 and PR 45; report partial failure");
			expect(result.results.map((r) => r.source)).toEqual(["https://github.com/example/project/pull/42"]);
			const failed = host.calls.find(
				(c) => c.tool === "mcp__github__pull_request_read" && c.parameters.pullNumber === 45,
			);
			expect(failed?.status).toBe("error");
			expect(JSON.stringify(failed?.result)).toMatch(/closed|disconnect|exited/iu);
		} finally {
			await host.close();
		}
	});
}
