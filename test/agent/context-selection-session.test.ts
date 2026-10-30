import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import type { ContextSelectionConfig } from "../../src/agent/context-selection.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

const roots: string[] = [];
const registrations: ReturnType<typeof registerFauxProvider>[] = [];
afterEach(() => {
	for (const r of registrations.splice(0)) r.unregister();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const texts = (messages: readonly Message[]) =>
	messages
		.map((m) =>
			typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
		)
		.join("\n");

async function fixture(
	mode: ContextSelectionConfig["mode"],
	answerMode: "single" | "progressive" = "single",
	toolCall = false,
) {
	const root = mkdtempSync(join(tmpdir(), "autorag-selection-session-"));
	roots.push(root);
	const docs = join(root, "docs");
	mkdirSync(docs);
	for (let i = 0; i < 30; i++)
		writeFileSync(
			join(docs, `${i}.txt`),
			`Policy ${i}. The ordinary refund threshold is ${1000 + i} credits. ${"Refund policy information. ".repeat(6)}`,
		);
	const requests: Context[] = [];
	const registration = registerFauxProvider({
		api: `faux-selection-${randomUUID()}`,
		models: [{ id: "selection", contextWindow: 100_000, maxTokens: 4000 }],
	});
	registrations.push(registration);
	const record = (context: Context, call = false) => {
		requests.push(context);
		return call
			? fauxAssistantMessage(fauxToolCall("search_all_documents", { query: "refund threshold" }), {
					stopReason: "toolUse",
				})
			: fauxAssistantMessage("The policy defines an ordinary refund threshold.");
	};
	registration.setResponses([(ctx) => record(ctx, toolCall), (ctx) => record(ctx), (ctx) => record(ctx)]);
	const agent = new AutoRAGAgent({
		...nativeIndexFixture(),
		model: registration.getModel(),
		apiKey: "test",
		searchPaths: [docs],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		piAgentDir: join(root, "pi"),
		jikji: false,
		everything: false,
		fsearch: false,
		webSearch: false,
		jev: false,
		rerank: false,
		dupey: false,
		memoryEmbedder: false,
		permissionMode: "full",
		answerMode,
		contextSelection: { mode, evidenceBudgetTokens: 650 },
	});
	await agent.refresh(false, { methods: ["minsync"] });
	return { root, agent, requests, registration };
}

describe("context selection at the actual provider seam", () => {
	it.each(["off", "observe", "adaptive"] as const)(
		"single baseline in %s preserves API results and projects only provider input",
		async (mode) => {
			const f = await fixture(mode);
			const query = "What is the ordinary refund threshold?";
			const raw = await f.agent.retrieve(query, { topK: 100 });
			expect(raw).toHaveLength(30);
			await f.agent.searchDocuments(query);
			expect(f.requests).toHaveLength(1);
			const input = texts(f.requests[0].messages);
			const count = (input.match(/^\[e\d+\] \/.*\/docs\/\d+\.txt/gmu) ?? []).length;
			if (mode === "adaptive") {
				expect(count).toBeGreaterThan(0);
				expect(count).toBeLessThan(30);
				expect(input).toContain("other text was omitted");
			} else expect(count).toBe(30);
			expect(input).toContain(query);
			expect(await f.agent.retrieve(query, { topK: 100 })).toHaveLength(30);
			const events = readFileSync(join(f.root, "logs/runs.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			if (mode === "observe") expect(events.some((event) => event.report?.hypothetical)).toBe(true);
			if (mode === "adaptive")
				expect(
					events.some(
						(event) =>
							event.report?.stage === "prepared" &&
							event.report.visibleCandidateCount > 0 &&
							event.report.visibleCandidateCount < 30,
					),
				).toBe(true);
		},
	);
	it("reapplies one shared budget after the model calls the exhaustive retrieval tool", async () => {
		const f = await fixture("adaptive", "single", true);
		await f.agent.searchDocuments("What is the ordinary refund threshold?");
		expect(f.requests).toHaveLength(2);
		const second = texts(f.requests[1].messages);
		expect((second.match(/^\[e\d+\] \/.*\/docs\/\d+\.txt/gmu) ?? []).length).toBeLessThan(30);
		expect(second).toContain("Merged results");
		expect(await f.agent.retrieve("refund threshold", { topK: 100 })).toHaveLength(30);
	});
	it("applies the same projection to progressive requests", async () => {
		const f = await fixture("adaptive", "progressive");
		await f.agent.searchDocuments("What is the ordinary refund threshold?");
		expect(f.requests.length).toBeGreaterThanOrEqual(2);
		for (const request of f.requests)
			expect((texts(request.messages).match(/^\[e\d+\] \/.*\/docs\/\d+\.txt/gmu) ?? []).length).toBeLessThan(30);
	});
	it("keeps exhaustive questions on the original conservative path", async () => {
		const f = await fixture("adaptive");
		await f.agent.searchDocuments("List all refund policies and compare every threshold.");
		expect((texts(f.requests[0].messages).match(/^\[e\d+\] \/.*\/docs\/\d+\.txt/gmu) ?? []).length).toBe(30);
	});
	it("does not schedule another model request when an adaptive search is cancelled", async () => {
		const f = await fixture("adaptive");
		let entered = () => {};
		let release = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.registration.setResponses([
			async (context) => {
				f.requests.push(context);
				entered();
				await gate;
				return fauxAssistantMessage("Cancelled answer");
			},
			fauxAssistantMessage("Must not run"),
		]);
		const events: unknown[] = [];
		const run = (async () => {
			for await (const event of f.agent.searchDocumentsStream("What is the ordinary refund threshold?"))
				events.push(event);
		})();
		await started;
		f.agent.abort();
		release();
		await run;
		expect(f.registration.state.callCount).toBe(1);
		expect(JSON.stringify(events)).not.toContain("Must not run");
	});
	it("uses the same policy in the bound interactive runtime and recomputes subsequent turns", async () => {
		const f = await fixture("adaptive");
		const runtime = await f.agent.createPiInteractiveRuntime();
		try {
			await f.agent.searchDocuments("What is the ordinary refund threshold?");
			await f.agent.searchDocuments("Who is responsible for this policy?");
			expect(f.requests).toHaveLength(2);
			for (const request of f.requests)
				expect((texts(request.messages).match(/^\[e\d+\] \/.*\/docs\/\d+\.txt/gmu) ?? []).length).toBeLessThan(30);
			const original = texts(runtime.runtime.session.messages as Message[]);
			expect((original.match(/^\[e\d+\] \/.*\/docs\/\d+\.txt/gmu) ?? []).length).toBe(30);
		} finally {
			await runtime.dispose();
		}
	});
	it("keeps actual provider prefixes stable and references the original bodies across three conversation turns", async () => {
		const f = await fixture("adaptive");
		const runtime = await f.agent.createPiInteractiveRuntime();
		const record = (context: Context, call = false) => {
			f.requests.push(structuredClone(context));
			return call
				? fauxAssistantMessage(fauxToolCall("search_all_documents", { query: "refund threshold" }), {
						stopReason: "toolUse",
					})
				: fauxAssistantMessage("The policy defines the threshold.");
		};
		f.registration.setResponses([
			(ctx) => record(ctx),
			(ctx) => record(ctx, true),
			(ctx) => record(ctx),
			(ctx) => record(ctx, true),
			(ctx) => record(ctx),
		]);
		try {
			await f.agent.searchDocuments("List all refund policies.");
			await f.agent.searchDocuments("Search all refund policies again.");
			await f.agent.searchDocuments("Search all refund policies one more time.");
			expect(f.requests).toHaveLength(5);
			for (let i = 1; i < f.requests.length; i++) {
				const before = f.requests[i - 1].messages;
				expect(f.requests[i].messages.slice(0, before.length)).toEqual(before);
			}
			const final = texts(f.requests[4].messages);
			expect(final).toContain("AutoRAG evidence reference");
			expect((final.match(/Policy \d+\./gu) ?? []).length).toBe(30);
			const original = texts(runtime.runtime.session.messages as Message[]);
			expect((original.match(/Policy \d+\./gu) ?? []).length).toBeGreaterThan(30);
		} finally {
			await runtime.dispose();
		}
	});

	it("coordinates manual Pi compaction and accounts for its separate model call", async () => {
		const f = await fixture("adaptive");
		const runtime = await f.agent.createPiInteractiveRuntime();
		try {
			f.registration.setResponses([
				fauxAssistantMessage("First policy answer"),
				fauxAssistantMessage("Follow-up answer"),
			]);
			await f.agent.searchDocuments("List all refund policies.");
			await f.agent.searchDocuments("Explain the policies.");
			runtime.runtime.session.settingsManager.applyOverrides({
				compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
			});
			f.registration.setResponses([
				fauxAssistantMessage(
					"## Goal\nAnswer refund policy questions.\n## Progress\nEarlier results can be retrieved again.",
				),
				fauxAssistantMessage("Latest turn concerned refund policy questions."),
			]);
			await runtime.runtime.session.compact();
			f.registration.setResponses([
				fauxAssistantMessage(fauxToolCall("search_all_documents", { query: "refund threshold" }), {
					stopReason: "toolUse",
				}),
				(ctx) => {
					f.requests.push(structuredClone(ctx));
					return fauxAssistantMessage("Retrieved policy again");
				},
			]);
			await f.agent.searchDocuments("Search the refund policy documents again.");
			expect(texts(f.requests.at(-1)!.messages)).toContain("Policy 0.");
			const events = readFileSync(join(f.root, "logs/runs.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(events.some((e) => e.event === "model_usage" && e.scope === "pi_compaction")).toBe(true);
			expect(events.some((e) => e.report?.prefixChangeReason === "pi_compaction_manual")).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});
	it.each(["off", "observe", "adaptive"] as const)(
		"ER-I06 restores a complete local chunk after actual Pi compaction in %s",
		async (mode) => {
			const f = await fixture(mode);
			const runtime = await f.agent.createPiInteractiveRuntime();
			try {
				await f.agent.searchDocuments("List all refund policies.");
				runtime.runtime.session.settingsManager.applyOverrides({
					compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
				});
				f.registration.setResponses([
					fauxAssistantMessage("## Goal\nAnswer refund policies.\n## Progress\nEvidence e1 was retrieved."),
					fauxAssistantMessage("Policies were retrieved."),
				]);
				await runtime.runtime.session.compact();
				f.registration.setResponses([
					fauxAssistantMessage(fauxToolCall("read_local_evidence", { evidenceId: "e1" }), {
						stopReason: "toolUse",
					}),
					(context) => {
						f.requests.push(structuredClone(context));
						return fauxAssistantMessage("Read the original complete policy.");
					},
				]);
				await f.agent.searchDocuments("Restore the complete text of evidence e1.");
				const messages = f.requests.at(-1)!.messages;
				const read = messages.find(
					(message) => message.role === "toolResult" && message.toolName === "read_local_evidence",
				);
				expect(read).toBeDefined();
				const payload = texts([read!]);
				expect(payload).toContain("AutoRAG complete local evidence:");
				expect(payload).toContain('"complete":true');
				expect(payload).toMatch(/Policy \d+\./);
				expect(payload).not.toContain("AutoRAG evidence reference");
			} finally {
				await runtime.dispose();
			}
		},
	);
	it.each(["single", "progressive"] as const)(
		"ER-I01 reads complete evidence through the %s standalone provider seam",
		async (answerMode) => {
			const f = await fixture("adaptive", answerMode);
			f.registration.setResponses([
				fauxAssistantMessage(fauxToolCall("read_local_evidence", { evidenceId: "e1" }), { stopReason: "toolUse" }),
				(context) => {
					f.requests.push(structuredClone(context));
					return fauxAssistantMessage("The complete evidence was restored.");
				},
				(context) => {
					f.requests.push(structuredClone(context));
					return fauxAssistantMessage("The policy was verified.");
				},
			]);
			await f.agent.searchDocuments("Restore the complete original evidence e1.");
			const payload = f.requests
				.flatMap((context) => context.messages)
				.filter((message) => message.role === "toolResult" && message.toolName === "read_local_evidence");
			expect(payload.length).toBeGreaterThan(0);
			expect(texts(payload)).toContain('"complete":true');
			expect(payload.every((message) => message.role === "toolResult" && !message.isError)).toBe(true);
		},
	);
	it("keeps the committed prefix and anchors when Pi compaction fails", async () => {
		const f = await fixture("adaptive");
		const runtime = await f.agent.createPiInteractiveRuntime();
		try {
			await f.agent.searchDocuments("List all refund policies.");
			await f.agent.searchDocuments("Explain the policies.");
			runtime.runtime.session.settingsManager.applyOverrides({
				compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
			});
			f.registration.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "QA compaction failure" }),
			]);
			await expect(runtime.runtime.session.compact()).rejects.toThrow("QA compaction failure");
			f.registration.setResponses([
				fauxAssistantMessage(fauxToolCall("search_all_documents", { query: "refund threshold" }), {
					stopReason: "toolUse",
				}),
				(ctx) => {
					f.requests.push(structuredClone(ctx));
					return fauxAssistantMessage("Policy checked again");
				},
			]);
			await f.agent.searchDocuments("Search all refund policy documents again.");
			const final = texts(f.requests.at(-1)!.messages);
			expect(final).toContain("AutoRAG evidence reference");
			expect((final.match(/Policy \d+\./gu) ?? []).length).toBe(30);
		} finally {
			await runtime.dispose();
		}
	});
	it("ER-U15 clears read locators when a bound Pi runtime is disposed", async () => {
		const f = await fixture("adaptive");
		const runtime = await f.agent.createPiInteractiveRuntime();
		await f.agent.searchDocuments("List all refund policies.");
		const tool = (f.agent as unknown as { tools: readonly AgentTool[] }).tools.find(
			(tool) => tool.name === "read_local_evidence",
		)!;
		expect((await tool.execute("before", { evidenceId: "e1" })).details).toMatchObject({ complete: true });
		await runtime.dispose();
		await expect(tool.execute("after", { evidenceId: "e1" })).rejects.toThrow(/no verified/);
	});
	it("ER-U17 off and observe deliver the same normalized complete-read payload", async () => {
		const payloads: string[] = [];
		for (const mode of ["off", "observe"] as const) {
			const f = await fixture(mode);
			f.registration.setResponses([
				fauxAssistantMessage(fauxToolCall("read_local_evidence", { evidenceId: "e1" }), { stopReason: "toolUse" }),
				(context) => {
					f.requests.push(structuredClone(context));
					return fauxAssistantMessage("Read the complete policy.");
				},
			]);
			await f.agent.searchDocuments("Restore the complete original evidence e1.");
			const read = f.requests
				.at(-1)!
				.messages.filter((message) => message.role === "toolResult" && message.toolName === "read_local_evidence");
			expect(read).toHaveLength(1);
			expect(texts(read)).toContain('"complete":true');
			payloads.push(texts(read).replaceAll(f.root, "<ROOT>"));
		}
		expect(payloads[0]).toBe(payloads[1]);
	});
});
