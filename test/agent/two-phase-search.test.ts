import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoRAGAgent, type AutoRAGAgentOptions } from "../../src/agent/agent.ts";
import type { SearchDocumentsStreamEvent } from "../../src/agent/search-documents.ts";
import type {
	DatasourceIndexResult,
	DatasourceSkill,
	PollingMetadata,
	SourceDescription,
} from "../../src/datasource/types.ts";
import type {
	RetrievalMethod,
	RetrievalMethodDescriptor,
	RetrievalOptions,
	RetrievalResult,
} from "../../src/retrieval/types.ts";

let root: string;
let docs: string;
let registrations: FauxProviderRegistration[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "autorag-two-phase-"));
	docs = join(root, "docs");
	registrations = [];
	mkdirSync(docs, { recursive: true });
	writeFileSync(
		join(docs, "refund-policy.txt"),
		[
			"Refund exceptions require director approval before payout.",
			"Finance acknowledged the policy in the July review.",
		].join("\n"),
	);
});

afterEach(() => {
	for (const reg of registrations) reg.unregister();
	rmSync(root, { recursive: true, force: true });
});

function fauxModel(reasoning: boolean, ...responses: FauxResponseStep[]) {
	const reg = registerFauxProvider({
		api: `faux-${randomUUID()}`,
		models: [{ id: "faux-model", reasoning }],
	});
	reg.setResponses(responses);
	registrations.push(reg);
	return reg.getModel();
}

function recordStep(step: FauxResponseStep, log: (string | undefined)[]): FauxResponseStep {
	return (_context, options) => {
		log.push(options?.reasoning);
		return step as AssistantMessage;
	};
}

/** Records the latest user prompt the agent sent, then returns the scripted step. */
function capturePromptStep(step: FauxResponseStep, prompts: string[]): FauxResponseStep {
	return (context) => {
		const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
		const text =
			lastUser === undefined
				? ""
				: typeof lastUser.content === "string"
					? lastUser.content
					: lastUser.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		prompts.push(text);
		return step as AssistantMessage;
	};
}

/** The fast phase now ends in a plain assistant message: no tool call. */
function fastAnswerCall(): FauxResponseStep {
	return fauxAssistantMessage("Fast answer: refund exceptions require director approval before payout.", {
		stopReason: "stop",
	});
}

/** The verification phase ends in a plain assistant message citing the file it opened. */
function finalAnswer(answer: string): FauxResponseStep {
	return fauxAssistantMessage(`${answer} [file:${join(docs, "refund-policy.txt")}]`, { stopReason: "stop" });
}

class StaticMethod implements RetrievalMethod {
	private readonly rows: readonly RetrievalResult[];

	constructor(rows: readonly RetrievalResult[]) {
		this.rows = rows;
	}

	describe(): RetrievalMethodDescriptor {
		return {
			name: "kakao.keyword",
			type: "bm25",
			description: "KakaoTalk test datasource method",
			status: "active",
			capabilities: ["keyword"],
			datasourceId: "kakao",
			tags: ["kakao", "chat"],
		};
	}

	async retrieve(_query: string, options: RetrievalOptions): Promise<RetrievalResult[]> {
		return this.rows.slice(0, options.topK ?? this.rows.length);
	}
}

function makeSkill(rows: readonly RetrievalResult[]): DatasourceSkill {
	const method = new StaticMethod(rows);
	return {
		describe() {
			return {
				name: "kakao",
				type: "chat",
				description: "KakaoTalk chats exported through lazykatok",
				capabilities: ["keyword", "polling"],
				tags: ["kakao", "chat"],
				status: "active",
				datasourceId: "kakao",
				instanceId: "acct-1",
				instances: ["acct-1"],
			};
		},
		polling(): PollingMetadata {
			return { mode: "poll", intervalMs: 60_000 };
		},
		skillManifest() {
			return {
				name: "datasource-kakao",
				description: "Search indexed KakaoTalk chats.",
				content: "# KakaoTalk\nSearch with search_datasource_kakao; scope /kakao/acct-1.",
			};
		},
		async index(): Promise<DatasourceIndexResult> {
			return {
				ok: true,
				instanceId: "acct-1",
				skill: "kakao",
				chunkCount: rows.length,
				indexedAt: 1,
				diagnostics: [],
			};
		},
		retrievalMethods() {
			return [method];
		},
		describeSources(): readonly SourceDescription[] {
			return [
				{
					source: "/kakao/acct-1",
					datasourceId: "kakao",
					skill: "kakao",
					instanceId: "acct-1",
					contentType: "chat",
					metadata: { description: "KakaoTalk chat history for acct-1" },
				},
			];
		},
	};
}

function agentOptions(model: ReturnType<typeof fauxModel>): AutoRAGAgentOptions {
	return {
		answerMode: "progressive",
		model,
		searchPaths: [docs],
		memoryPath: join(root, "memory.json"),
		workspacePath: root,
		minSync: { autoInstall: false },
		jikji: false,
	};
}

async function collectEvents(agent: AutoRAGAgent, query: string): Promise<SearchDocumentsStreamEvent[]> {
	const events: SearchDocumentsStreamEvent[] = [];
	for await (const event of agent.searchDocumentsStream(query)) events.push(event);
	return events;
}

describe("single-answer delivery by default", () => {
	function defaults(model: ReturnType<typeof fauxModel>): AutoRAGAgentOptions {
		const { answerMode: _legacy, ...options } = agentOptions(model);
		return options;
	}

	it("makes one answer turn with final thinking, no draft event, and no automatic verification", async () => {
		const prompts: string[] = [];
		const reasoning: (string | undefined)[] = [];
		let requests = 0;
		const model = fauxModel(true, (context, options) => {
			requests++;
			reasoning.push(options?.reasoning);
			const last = context.messages.filter((message) => message.role === "user").at(-1);
			prompts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
			return finalAnswer("Complete answer: director approval is required.") as AssistantMessage;
		});
		const events = await collectEvents(new AutoRAGAgent(defaults(model)), "refund approval?");
		expect(requests).toBe(1);
		expect(reasoning).toEqual(["high"]);
		expect(events.filter((event) => event.type === "preliminary")).toHaveLength(0);
		const complete = events.filter((event) => event.type === "complete");
		expect(complete).toHaveLength(1);
		expect(complete[0]?.type === "complete" && complete[0].response.answer).toContain("Complete answer");
		expect(prompts[0]).toContain("Baseline retrieval has completed");
		expect(prompts[0]).toContain("one complete, self-contained final answer");
		expect(prompts[0]).not.toContain("DELTA ONLY");
		expect(prompts[0]).not.toContain("until its next message arrives");
	});

	it.each(["legacy", "on-demand"] as const)(
		"%s searches with tools before delivering a cited complete answer",
		async (retrievalPolicy) => {
			const rows: RetrievalResult[] = [
				{
					id: "msg-1",
					source: "/kakao/acct-1/chunks/msg-1",
					content: "Director approval is required.",
					score: 1,
					metadata: {},
				},
			];
			const model = fauxModel(
				true,
				fauxAssistantMessage([fauxToolCall("search_datasource_kakao", { query: "refund approval", topK: 5 })], {
					stopReason: "toolUse",
				}),
				(context) => {
					const transcript = JSON.stringify(context.messages);
					const id = transcript.match(/\[(e\d+)\] \/kakao\/acct-1\/chunks\/msg-1/)?.[1];
					if (id === undefined) throw new Error("search returned no citable evidence");
					return fauxAssistantMessage(`Director approval is required [${id}].`, { stopReason: "stop" });
				},
			);
			const events = await collectEvents(
				new AutoRAGAgent({ ...defaults(model), retrievalPolicy, datasourceSkills: [makeSkill(rows)] }),
				"refund approval?",
			);
			expect(events.some((event) => event.type === "preliminary")).toBe(false);
			const complete = events.find((event) => event.type === "complete");
			expect(complete?.type === "complete" && complete.response.answer).toContain(
				"Director approval is required [1]",
			);
			expect(complete?.type === "complete" && complete.response.results[0]?.source).toBe(rows[0]?.source);
		},
	);

	it("preserves source failures instead of claiming the answer was verified", async () => {
		const model = fauxModel(
			true,
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }),
		);
		const result = await new AutoRAGAgent(defaults(model)).searchDocuments("refund approval?");
		expect(result.diagnostics?.some((entry) => entry.code === "model-request-failed")).toBe(true);
		expect(result.answer).not.toContain("confirmed as-is");
	});

	it("rejects an invalid library answer mode instead of silently enabling a pipeline", () => {
		const model = fauxModel(true, finalAnswer("answer"));
		expect(() => new AutoRAGAgent({ ...defaults(model), answerMode: "invalid" as "single" })).toThrow(/answerMode/);
	});
});

describe("on-demand first question", () => {
	it.each(["今天合肥天气怎么样？", "吉利目前校招有后端岗位吗？", "厦门银行目前校招有计算机岗位吗？"])(
		"supports a public tool call without touching local retrieval: %s",
		async (query) => {
			const model = fauxModel(
				false,
				fauxAssistantMessage([fauxToolCall("web_search", { query })], { stopReason: "toolUse" }),
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("PUBLIC_FIXTURE");
					return fauxAssistantMessage("Public fixture checked.");
				},
			);
			const agent = new AutoRAGAgent({ ...agentOptions(model), retrievalPolicy: "on-demand" });
			const retrieve = vi.fn(async () => []);
			Object.assign(agent, { minSyncMethod: { retrieve } });
			const web = (agent as unknown as { tools: AgentTool[] }).tools.find((tool) => tool.name === "web_search")!;
			const search = vi
				.spyOn(web, "execute")
				.mockResolvedValue({ content: [{ type: "text", text: "PUBLIC_FIXTURE" }], details: {} });
			const result = await agent.searchDocuments(query);
			expect(search).toHaveBeenCalledTimes(1);
			expect(retrieve).not.toHaveBeenCalled();
			expect(result.answer).toBe("Public fixture checked.");
		},
	);
	it("rejects a tool attempt to widen an API-scoped search before calling the index", async () => {
		const model = fauxModel(
			false,
			fauxAssistantMessage([fauxToolCall("semantic_search_local_docs", { query: "refund", scope: "/docs" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("outside or cannot be proven");
				return fauxAssistantMessage("No evidence in the requested scope.");
			},
		);
		const agent = new AutoRAGAgent({ ...agentOptions(model), retrievalPolicy: "on-demand" });
		const retrieve = vi.fn(async () => []);
		Object.assign(agent, { minSyncMethod: { retrieve } });
		const result = await agent.searchDocuments("Find my local policy", { scope: "/docs/refund-policy.txt" });
		expect(retrieve).not.toHaveBeenCalled();
		expect(result.answer).toBe("No evidence in the requested scope.");
	});
	it.each(["single", "progressive"] as const)(
		"uses a single tool-enabled answer loop in %s mode",
		async (answerMode) => {
			const prompts: string[] = [];
			const tools: string[] = [];
			const model = fauxModel(false, (context) => {
				for (const message of context.messages)
					if (message.role === "system") tools.push(...(message.toolsAdded ?? []).map((t) => t.name));
				prompts.push(JSON.stringify(context.messages.filter((m) => m.role !== "system")));
				return fauxAssistantMessage("I would need a current public weather source.");
			});
			const agent = new AutoRAGAgent({
				...agentOptions(model),
				retrievalPolicy: "on-demand",
				answerMode,
				jev: false,
			});
			const retrieve = vi.fn(async () => []);
			const memory = vi.fn(async () => ({ empty: false, text: "UNRELATED_MEMORY_CANARY" }));
			Object.assign(agent, { minSyncMethod: { retrieve }, loadMemoryContextFor: memory });
			const events = await collectEvents(agent, "今天合肥天气怎么样？");
			expect(retrieve).not.toHaveBeenCalled();
			expect(memory).not.toHaveBeenCalled();
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("今天合肥天气怎么样？");
			expect(prompts[0]).not.toMatch(/Baseline retrieval|UNRELATED_MEMORY_CANARY/u);
			expect(tools).toContain("semantic_search_local_docs");
			expect(tools).toContain("check_memory");
			expect(events.filter((e) => e.type === "complete")).toHaveLength(1);
			expect(events.some((e) => e.type === "preliminary")).toBe(false);
		},
	);

	it("searches only after a tool call and carries the API scope through a tool that omits it", async () => {
		const retrieve = vi.fn(async (_q: string, _o: RetrievalOptions) => [
			{
				id: "local-policy",
				content: "LOCAL_POLICY_CANARY",
				source: join(docs, "refund-policy.txt"),
				score: 0.8,
				metadata: {},
			},
		]);
		const prompts: string[] = [];
		const model = fauxModel(
			false,
			(context) => {
				prompts.push(JSON.stringify(context.messages));
				expect(retrieve).not.toHaveBeenCalled();
				return fauxAssistantMessage([fauxToolCall("semantic_search_local_docs", { query: "refund" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				prompts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Director approval [e1].");
			},
		);
		const agent = new AutoRAGAgent({ ...agentOptions(model), retrievalPolicy: "on-demand" });
		Object.assign(agent, { minSyncMethod: { retrieve } });
		const details: unknown[] = [];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end") details.push(event.result.details);
		});
		const answer = await agent.searchDocuments("Find the local refund policy", {
			scope: "/docs/refund-policy.txt",
			topK: 3,
		});
		expect(retrieve).toHaveBeenCalledTimes(1);
		expect(retrieve.mock.calls[0]?.[1]).toMatchObject({ scope: "/docs/refund-policy.txt", topK: 3 });
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).not.toContain("LOCAL_POLICY_CANARY");
		expect(prompts[1]).toContain("LOCAL_POLICY_CANARY");
		expect(answer.answer).toContain("[1]");
		expect(details).toEqual([expect.objectContaining({ resultCount: 1 })]);
	});
});

describe("explicit two-phase progressive answers (minimal-thinking fast → high-thinking final)", () => {
	it("yields the fast preliminary answer before the verified complete response", async () => {
		const model = fauxModel(
			true,
			fastAnswerCall(),
			finalAnswer("Final answer: refund exceptions require director approval before payout."),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		const events = await collectEvents(agent, "what approval do refund exceptions need?");

		const types = events.map((event) => event.type);
		const preliminaryIndex = types.indexOf("preliminary");
		const completeIndex = types.indexOf("complete");
		expect(preliminaryIndex).toBeGreaterThanOrEqual(0);
		expect(completeIndex).toBeGreaterThan(preliminaryIndex);

		const preliminary = events[preliminaryIndex];
		if (preliminary.type !== "preliminary") throw new Error("unreachable");
		expect(preliminary.response.answer).toContain("Fast answer");
		expect(preliminary.response.answer).toContain("director approval");
		// The fast phase cited nothing, so it derives no results.
		expect(preliminary.response.results).toEqual([]);

		const complete = events[completeIndex];
		if (complete.type !== "complete") throw new Error("unreachable");
		expect(complete.response.answer).toContain("Final answer");
		// The model's `[file:<path>]` marker became a numbered citation backed by a result.
		expect(complete.response.answer).toContain("[1]");
		expect(complete.response.answer).not.toContain("[file:");
		expect(complete.response.results[0]?.source).toBe(join(docs, "refund-policy.txt"));
	});

	it("publishes the preliminary answer exactly once", async () => {
		const model = fauxModel(true, fastAnswerCall(), finalAnswer("Verified final answer."));
		const agent = new AutoRAGAgent(agentOptions(model));

		const events = await collectEvents(agent, "refund approval?");

		expect(events.filter((event) => event.type === "preliminary")).toHaveLength(1);
	});

	it("never reports an answer message as progress, only the text written before a tool call", async () => {
		const model = fauxModel(
			true,
			fastAnswerCall(),
			fauxAssistantMessage(
				[
					{ type: "text", text: "Checking the datasource for the July review." },
					fauxToolCall("search_datasource_kakao", { query: "refund approval", topK: 5 }),
				],
				{ stopReason: "toolUse" },
			),
			finalAnswer("Final answer."),
		);
		const agent = new AutoRAGAgent({ ...agentOptions(model), datasourceSkills: [makeSkill([])] });

		const events = await collectEvents(agent, "refund approval?");

		const progress = events.flatMap((event) => (event.type === "progress" ? [event.text] : []));
		expect(progress).toContain("Checking the datasource for the July review.");
		expect(progress.some((text) => text.includes("Fast answer"))).toBe(false);
		expect(progress.some((text) => text.includes("Final answer"))).toBe(false);
	});

	it("returns a degraded fallback with reason and retrieval trace when the model request fails", async () => {
		const rows: RetrievalResult[] = [
			{
				id: "msg-1",
				source: "/kakao/acct-1/chunks/msg-1",
				content: "Director approval is required before payout.",
				score: 1,
				metadata: {},
			},
		];
		const model = fauxModel(
			true,
			fastAnswerCall(),
			fauxAssistantMessage(
				[
					{ type: "text", text: "Searching the kakao datasource." },
					fauxToolCall("search_datasource_kakao", { query: "refund approval", topK: 5 }),
				],
				{ stopReason: "toolUse" },
			),
			// The faux provider reports a drained script as a failed model request.
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider request failed" }),
		);
		const agent = new AutoRAGAgent({
			...agentOptions(model),
			datasourceSkills: [makeSkill(rows)],
		});

		const response = await agent.searchDocuments("refund approval");

		expect(response.results).toEqual([]);
		expect(
			response.diagnostics?.some(
				(diagnostic) => diagnostic.code === "no-final-answer" && diagnostic.severity === "warning",
			),
		).toBe(true);
		expect(response.diagnostics?.some((diagnostic) => diagnostic.code === "model-request-failed")).toBe(true);
		expect(response.answer).toContain("The model request failed");
		expect(response.answer).toContain("fix the model provider error");
		expect(response.searched).toBe(1);
		expect(response.retrievalTrace).toHaveLength(1);
		const entry = response.retrievalTrace?.[0];
		expect(entry?.tool).toBe("search_datasource_kakao");
		expect(entry?.resultCount).toBe(1);
		expect(entry?.results[0]?.source).toBe("/kakao/acct-1/chunks/msg-1");
		expect(entry?.results[0]?.excerpt).toContain("Director approval");
	});

	it("takes a prose answer as the final answer instead of asking the model to emit it", async () => {
		const prompts: string[] = [];
		const model = fauxModel(
			true,
			fastAnswerCall(),
			capturePromptStep(
				fauxAssistantMessage("- Refund exceptions require director approval before payout.", {
					stopReason: "stop",
				}),
				prompts,
			),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		const response = await agent.searchDocuments("refund approval");

		expect(prompts).toHaveLength(1);
		expect(response.answer).toBe("- Refund exceptions require director approval before payout.");
		expect(response.diagnostics?.some((diagnostic) => diagnostic.code === "no-final-answer")).toBe(false);
	});

	it("ends the run without a preliminary event when the first reply is already the final answer", async () => {
		const model = fauxModel(true, finalAnswer("Immediate final answer."));
		const agent = new AutoRAGAgent(agentOptions(model));

		const events = await collectEvents(agent, "refund approval?");

		const complete = events.find((event) => event.type === "complete");
		expect(complete?.type === "complete" && complete.response.answer).toContain("Immediate final answer");
	});

	it("runs the fast phase with minimal thinking and the verification phase with high thinking by default", async () => {
		const reasoningLog: (string | undefined)[] = [];
		const model = fauxModel(
			true,
			recordStep(fastAnswerCall(), reasoningLog),
			recordStep(finalAnswer("Final answer."), reasoningLog),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		const response = await agent.searchDocuments("refund approval?");

		expect(response.answer).toContain("Final answer");
		expect(reasoningLog).toEqual(["minimal", "high"]);
	});

	it("honours explicit thinking-level overrides for both phases", async () => {
		const reasoningLog: (string | undefined)[] = [];
		const model = fauxModel(
			true,
			recordStep(fastAnswerCall(), reasoningLog),
			recordStep(finalAnswer("Final answer."), reasoningLog),
		);
		const agent = new AutoRAGAgent({
			...agentOptions(model),
			thinking: { fast: "low", final: "medium" },
		});

		await agent.searchDocuments("refund approval?");

		expect(reasoningLog).toEqual(["low", "medium"]);
	});

	it("clamps thinking levels to off for models without reasoning support", async () => {
		const reasoningLog: (string | undefined)[] = [];
		const model = fauxModel(
			false,
			recordStep(fastAnswerCall(), reasoningLog),
			recordStep(finalAnswer("Final answer."), reasoningLog),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		await agent.searchDocuments("refund approval?");

		expect(reasoningLog).toEqual([undefined, undefined]);
	});

	it("drops a citation id no tool returned instead of attaching a source to it", async () => {
		const model = fauxModel(
			true,
			fastAnswerCall(),
			fauxAssistantMessage("Refund exceptions need director approval [e99].", { stopReason: "stop" }),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		const response = await agent.searchDocuments("refund approval?");

		expect(response.answer).toBe("Refund exceptions need director approval.");
		expect(response.results).toEqual([]);
		expect(
			response.diagnostics?.find((diagnostic) => diagnostic.code === "citation-without-result")?.message,
		).toContain("e99");
	});

	it("asks for a delta-only final answer when the fast answer was already delivered", () => {
		const model = fauxModel(true, fauxAssistantMessage("noop", { stopReason: "stop" }));
		const agent = new AutoRAGAgent(agentOptions(model));

		const delta = agent.buildRefinementPrompt(
			"what approval do refund exceptions need?",
			{},
			"Fast: refund exceptions need director approval before payout [e1].",
			true,
		);
		// The model must be able to see the exact first answer it is diffing against.
		expect(delta).toContain("Fast: refund exceptions need director approval before payout [e1].");
		expect(delta).toMatch(/MUST contain only/i);
		expect(delta).toMatch(/never restate/i);

		const complete = agent.buildRefinementPrompt("what approval do refund exceptions need?", {}, undefined, false);
		expect(complete).toContain("the fast phase produced no answer");
		expect(complete).not.toMatch(/MUST contain only/i);
	});

	it("walks the verification phase through the already-delivered fast answer as a delta task", async () => {
		const prompts: string[] = [];
		const model = fauxModel(
			true,
			capturePromptStep(fastAnswerCall(), prompts),
			capturePromptStep(finalAnswer("Correction: exceptions also need finance sign-off."), prompts),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		const events = await collectEvents(agent, "what approval do refund exceptions need?");

		const finalPrompt = prompts.at(-1) ?? "";
		expect(finalPrompt).toContain("Fast answer: refund exceptions require director approval before payout.");
		expect(finalPrompt).toMatch(/MUST contain only/i);
		const complete = events.find((event) => event.type === "complete");
		expect(complete?.type === "complete" && complete.response.answer).toContain("Correction:");
	});

	it("shows the model its own first answer with the original [eN] ids while the caller sees [n]", async () => {
		const prompts: string[] = [];
		// The fast model cites the id the baseline context printed, read back from its own prompt.
		const citeBaselineId: FauxResponseStep = (context) => {
			const text = context.messages
				.flatMap((message) => (message.role === "user" && Array.isArray(message.content) ? message.content : []))
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n");
			const id = text.match(/\[(e\d+)\] \/docs\/policy\.md/)?.[1];
			if (id === undefined) throw new Error("baseline context printed no evidence id");
			return fauxAssistantMessage(`Refund exceptions need director approval [${id}].`, { stopReason: "stop" });
		};
		const model = fauxModel(
			true,
			citeBaselineId,
			capturePromptStep(fauxAssistantMessage("Nothing to add.", { stopReason: "stop" }), prompts),
		);
		const agent = new AutoRAGAgent(agentOptions(model));
		// The MinSync retrieval method is private; the suite replaces it the same way to feed the baseline.
		const internals = agent as unknown as { minSyncMethod: unknown };
		internals.minSyncMethod = {
			isReady: () => true,
			isBinaryMissing: () => false,
			retrieve: async (): Promise<RetrievalResult[]> => [
				{
					id: "1",
					source: "/docs/policy.md",
					content: "Refund exceptions require director approval.",
					score: 1,
					metadata: {},
				},
			],
		};

		const events = await collectEvents(agent, "what approval do refund exceptions need?");

		const preliminary = events.find((event) => event.type === "preliminary");
		expect(preliminary?.type === "preliminary" && preliminary.response.answer).toContain("director approval [1]");
		const refinementPrompt = prompts.at(-1) ?? "";
		expect(refinementPrompt).toMatch(/director approval \[e\d+\]/);
		expect(refinementPrompt).not.toContain("director approval [1]");
	});

	it("keeps a complete-answer instruction when no preliminary reaches a caller", async () => {
		const prompts: string[] = [];
		const model = fauxModel(
			true,
			capturePromptStep(fastAnswerCall(), prompts),
			capturePromptStep(finalAnswer("Complete verified answer."), prompts),
		);
		const agent = new AutoRAGAgent(agentOptions(model));

		const response = await agent.searchDocuments("what approval do refund exceptions need?");

		const finalPrompt = prompts.at(-1) ?? "";
		expect(finalPrompt).not.toMatch(/MUST contain only/i);
		expect(response.answer).toContain("Complete verified answer");
	});
});
