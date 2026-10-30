import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, it } from "vitest";
import { createResearchInbox, renderResearchBatch, renderResearchCard } from "../../src/agent/research-inbox.ts";
import { type InboxCard, ResearchClient, type ResearchOverview } from "../../src/research/client.ts";
import { note, target } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});
const initial: ResearchOverview = {
	libraries: [{ id: "library", name: "Library", state: "active", root_path: "/papers" }],
	topics: [
		{
			id: "topic",
			library_id: "library",
			title: "Retrieval",
			question: "How is it evaluated?",
			focus: [],
			exclusions: [],
			revision: 1,
			active: true,
		},
	],
	unread: 1,
	runs: [],
	batches: [],
	modelProcessingEnabled: true,
};

function harness(overview: ResearchOverview = structuredClone(initial)) {
	const requests: { path: string; body?: object; key?: string }[] = [];
	const responses = new Map<string, unknown>();
	const card: InboxCard = {
		id: "card",
		title: "Paper",
		payload: note(),
		evidence: [target],
		priority: "optional",
		review_state: "unread",
		validity: "partial",
	};
	responses.set("/inbox?limit=20&offset=0", [card]);
	responses.set("/inbox/card", card);
	const client = new ResearchClient("http://127.0.0.1:8765", (async (input, options) => {
		const path = String(input).split("/research/v1")[1];
		const body = options?.body ? JSON.parse(String(options.body)) : undefined;
		requests.push({ path, body, key: new Headers(options?.headers).get("idempotency-key") ?? undefined });
		if (path === "/overview") return Response.json(overview);
		return Response.json(responses.get(path) ?? { id: "created", status: "planned" });
	}) as typeof fetch);
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const events = new Map<string, (_event: unknown, ctx: ExtensionContext) => void>();
	const picks: ((options: string[]) => string | undefined)[] = [];
	const inputs: (string | undefined)[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const rendered: string[][] = [];
	const selections: { title: string; options: string[] }[] = [];
	let sent = 0;
	const ctx = {
		hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return picks.shift()?.(options);
			},
			input: async () => inputs.shift(),
			notify: (text: string) => notices.push(text),
			setStatus: (_key: string, text?: string) => statuses.push(text),
			custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
				let done = false;
				const component = await factory(
					{ terminal: { rows: 12 }, requestRender: () => {} } as never,
					{} as never,
					{} as never,
					() => {
						done = true;
					},
				);
				rendered.push(component.render(80));
				component.handleInput?.("\u001b[B");
				rendered.push(component.render(80));
				component.handleInput?.("\u001b");
				assert(done, "Esc must close the read-only viewer");
			},
		},
	} as unknown as ExtensionContext;
	createResearchInbox({ baseUrl: client.baseUrl, client })({
		on: (name: string, fn: (_event: unknown, ctx: ExtensionContext) => void) => events.set(name, fn),
		registerCommand: (name: string, registration: { handler: typeof handler }) => {
			if (name === "research") handler = registration.handler;
		},
		sendMessage: () => {
			sent++;
		},
	} as unknown as ExtensionAPI);
	const stop = () => events.get("session_shutdown")?.({}, ctx);
	cleanup.push(stop);
	return {
		requests,
		responses,
		picks,
		inputs,
		notices,
		statuses,
		rendered,
		selections,
		overview,
		ctx,
		stop,
		get sent() {
			return sent;
		},
		async run(args = "") {
			assert(handler);
			await handler(args, ctx);
		},
		start() {
			events.get("session_start")?.({}, ctx);
		},
	};
}

describe("TUI paper reading inbox", () => {
	it("creates the initial inventory without requesting a model analysis", async () => {
		const ui = harness({ ...structuredClone(initial), libraries: [], topics: [] });
		ui.responses.set("/libraries", { id: "library", state: "seeding" });
		await ui.run("seed");
		assert.deepEqual(
			ui.requests.filter((request) => request.body).map(({ path, body }) => ({ path, body })),
			[
				{ path: "/libraries", body: { name: "我的论文库" } },
				{ path: "/libraries/library/scans", body: { mode: "seed" } },
			],
		);
		assert(ui.requests.filter((request) => request.body).every((request) => request.key));
		assert(!ui.requests.some((request) => request.path.includes("analyses")));
	});
	it("submits the user's topic question and dimensions", async () => {
		const ui = harness();
		ui.picks.push(() => "新增主题");
		ui.inputs.push("Memory", "How is memory evaluated?", "retrieval，evaluation", "");
		await ui.run("topics");
		assert.deepEqual(ui.requests.find((request) => request.path === "/topics")?.body, {
			libraryId: "library",
			title: "Memory",
			question: "How is memory evaluated?",
			focus: ["retrieval", "evaluation"],
			exclusions: [],
		});
	});
	it("reads evidence without sending chat messages and saves feedback", async () => {
		const ui = harness();
		ui.picks.push(
			(options) => options[0],
			() => "标为已读",
			() => "有用",
			() => "返回",
		);
		await ui.run("inbox");
		assert(ui.rendered.flat().join("\n").includes("Paper"));
		assert.equal(ui.sent, 0);
		assert.deepEqual(
			ui.requests.filter((request) => request.path.endsWith("feedback")).map((request) => request.body),
			[
				{ kind: "reading_state", value: "read" },
				{ kind: "usefulness", value: "useful" },
			],
		);
		assert(renderResearchCard(ui.responses.get("/inbox/card") as InboxCard).includes(target.source));
	});
	it("submits a selected ready version and topic for manual reading", async () => {
		const ui = harness();
		ui.responses.set("/papers?limit=20&offset=0", [
			{ id: "paper", title: "Paper", assets: [{ id: "asset", state: "ready", source_path: "/papers/a.pdf" }] },
		]);
		ui.picks.push(
			(options) => options[0],
			(options) => options[0],
			(options) => options[0],
		);
		await ui.run("papers");
		assert.deepEqual(ui.requests.find((request) => request.path.endsWith("analyses"))?.body, {
			assetId: "asset",
			topicId: "topic",
		});
		assert(ui.selections.some((selection) => selection.title.includes("已提交")));
	});
	it("keeps an explicit not-ready explanation visible instead of silently returning to the inbox", async () => {
		const ui = harness();
		ui.responses.set("/papers?limit=20&offset=0", [
			{ id: "paper", title: "TempMe", assets: [{ id: "asset", state: "identified" }] },
		]);
		ui.picks.push(
			(options) => options[0],
			() => "返回收件箱",
		);
		await ui.run("papers");
		assert(ui.selections[0].options[0].includes("索引未就绪"));
		assert(ui.selections[1].title.includes("本次未创建研读任务"));
		assert(ui.selections[1].options.includes("查看导入进度"));
		assert(!ui.requests.some((request) => request.path.endsWith("analyses")));
	});
	it("shows indexing phase and batch timing without inventing a completion percentage", () => {
		const text = renderResearchBatch(
			{
				id: "batch",
				kind: "seed",
				status: "indexing",
				counts: { added: 3 },
				progress: {
					phase: "minsync",
					startedAt: "2026-10-28T08:11:00Z",
					updatedAt: "2026-10-28T08:16:00Z",
					ownerAlive: true,
					sourceFiles: { total: 5 },
					parsedCounts: { scanned: 5 },
					indexing: { phase: "embed", state: "start", count: 32, elapsedMs: 300000 },
				},
			},
			Date.parse("2026-10-28T08:16:30Z"),
		);
		assert(text.includes("当前阶段：向量化"));
		assert(text.includes("已解析资料：5/5"));
		assert(text.includes("正在处理：32 个文本块"));
		assert(text.includes("最近进展：30 秒前"));
		assert(!text.includes("%"));
	});
	it("cancels running work and explicitly retries deferred work", async () => {
		const ui = harness();
		const run = { id: "run", state: "reading", asset_id: "asset", topic_snapshot: initial.topics[0] };
		ui.overview.runs = [run];
		ui.responses.set("/runs/run", run);
		ui.picks.push(
			(options) => options[0],
			() => "取消任务",
			() => "返回",
		);
		await ui.run("runs");
		assert(ui.requests.some((request) => request.path === "/runs/run/cancel"));
		run.state = "deferred";
		ui.picks.push(
			(options) => options[0],
			() => "重新研读",
		);
		await ui.run("runs");
		assert(ui.requests.some((request) => request.path === "/runs/run/retry"));
	});
	it("does not update a replaced session after a late overview response", async () => {
		let resolve!: (value: Response) => void;
		const response = new Promise<Response>((done) => {
			resolve = done;
		});
		const client = new ResearchClient("http://127.0.0.1:8765", (async () => response) as typeof fetch);
		const events = new Map<string, (_event: unknown, ctx: ExtensionContext) => void>();
		let writes = 0;
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: () => {
					writes++;
				},
			},
		} as unknown as ExtensionContext;
		createResearchInbox({ baseUrl: client.baseUrl, client })({
			on: (name: string, fn: (_event: unknown, ctx: ExtensionContext) => void) => events.set(name, fn),
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		events.get("session_start")?.({}, ctx);
		events.get("session_shutdown")?.({}, ctx);
		resolve(Response.json(initial));
		await new Promise((done) => setTimeout(done, 10));
		assert.equal(writes, 0);
	});
	it("reports original API failures and never submits work when reading is disabled", async () => {
		const ui = harness({ ...structuredClone(initial), modelProcessingEnabled: false });
		await ui.run("papers");
		assert(ui.notices.some((text) => text.includes("未启用")));
		assert(!ui.requests.some((request) => request.body));
		ui.responses.set("/inbox?limit=20&offset=0", []);
		await ui.run("inbox");
	});
	it("restricts clients to loopback and preserves server errors", async () => {
		for (const url of [
			"https://example.com",
			"http://example.com",
			"http://user:secret@localhost",
			"http://localhost/other",
		])
			assert.throws(() => new ResearchClient(url), /loopback/);
		let redirect: string | undefined;
		const client = new ResearchClient("http://localhost:8765", (async (_url, options) => {
			redirect = options?.redirect;
			return Response.json({ error: "database unavailable: /specific/path" }, { status: 503 });
		}) as typeof fetch);
		await assert.rejects(client.overview(), /Research HTTP 503: database unavailable: \/specific\/path/);
		assert.equal(redirect, "error");
	});
});
