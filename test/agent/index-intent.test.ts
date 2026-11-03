import { describe, expect, it, vi } from "vitest";
import {
	classifyIndexInput,
	type IndexIntent,
	IndexIntentRouter,
	type IndexSnapshot,
	parseIndexDecision,
	planIndexIntent,
} from "../../src/agent/index-intent.ts";

const snapshot: IndexSnapshot = {
	profiles: [
		{ id: "local-qwen3", kind: "local-http", model: "Qwen" },
		{ id: "online", kind: "api", model: "remote" },
	],
	activeProfile: "local-qwen3",
	defaultProfile: "online",
	ready: true,
	localJobId: "owned-job",
};
const request = (intent: IndexIntent["intent"], extra: Partial<IndexIntent> = {}): IndexIntent => ({
	intent,
	constraints: [],
	...extra,
});
const output = (r: IndexIntent) => JSON.stringify({ kind: "operation", request: r });
function router(complete = vi.fn(async () => output(request("ensure_index")))) {
	const execute = vi.fn();
	const notify = vi.fn();
	return {
		execute,
		notify,
		complete,
		route: new IndexIntentRouter({ snapshot: () => snapshot, complete, execute, notify }),
	};
}

describe("index intent gate", () => {
	it.each([
		"如何建立索引",
		"请告诉我如何建立索引",
		"查找包含建立索引说明的文档",
		"不要建立索引，只解释步骤",
		"不要停止索引任务",
		"文档中写着重建索引是什么意思",
		"帮我写一句请重建索引",
		"create a summary of this document",
		"总结刚添加的资料",
		"How do I rebuild the current index?",
		"Who approves refunds?",
		"好的",
	])("keeps %s ordinary", (text) => {
		expect(classifyIndexInput(text).kind).toBe("ordinary");
	});
	it.each([
		"请重建当前索引",
		"建立索引",
		"建索引",
		"帮我刷新索引",
		"更新所有已配置本地目录",
		"查看索引进度",
		"取消刚才的索引任务",
		"Please rebuild the current index",
	])("parses whole command %s", (text) => {
		expect(classifyIndexInput(text).kind).toBe("operation");
	});
	it.each([
		"用本地 Qwen 模型给已配置的文档目录建索引",
		"不要重建，只更新当前索引",
		"新资料怎么搜不到",
		"让刚添加的资料也能搜到",
		"只更新目录 A 的索引",
		"处理一下这些资料",
	])("interprets candidate %s without authorizing it", (text) => {
		expect(classifyIndexInput(text).kind).toBe("candidate");
	});
	it("recognizes parameter replies only while clarification is pending", () => {
		expect(classifyIndexInput("online").kind).toBe("ordinary");
		expect(classifyIndexInput("online", true).kind).toBe("candidate");
		expect(classifyIndexInput("取消", true)).toMatchObject({
			kind: "operation",
			request: { intent: "abandon_request" },
		});
	});
});

describe("index decision contract and state plan", () => {
	it.each([
		"null",
		"[]",
		"{}",
		'{"kind":"operation","request":{"intent":"rebuild"}}',
		'{"kind":"operation","request":{"intent":"rebuild","constraints":[],"authorized":true}}',
		'{"kind":"ordinary","authorized":true}',
	])("rejects malformed or invented parameters %s", (s) => expect(() => parseIndexDecision(s)).toThrow());
	it("accepts the one structured response", () =>
		expect(parseIndexDecision(output(request("refresh")))).toMatchObject({ request: { intent: "refresh" } }));
	it("uses refresh for ensure, build for explicit rebuild, and active rather than default profile", () => {
		expect(planIndexIntent(request("ensure_index"), snapshot)).toEqual({
			operation: "refresh",
			embeddingProfile: "local-qwen3",
		});
		expect(planIndexIntent(request("rebuild"), snapshot)).toEqual({
			operation: "build",
			embeddingProfile: "local-qwen3",
		});
	});
	it("builds first index but does not expand a refresh request", () => {
		expect(planIndexIntent(request("ensure_index"), { ...snapshot, ready: false })).toMatchObject({
			operation: "build",
		});
		expect(planIndexIntent(request("refresh"), { ...snapshot, ready: false }).operation).toBe("clarify");
	});
	it("builds a profile switch; refresh requires clarification", () => {
		expect(planIndexIntent(request("ensure_index", { profileRef: "online" }), snapshot)).toEqual({
			operation: "build",
			embeddingProfile: "online",
		});
		expect(planIndexIntent(request("refresh", { profileRef: "online" }), snapshot).operation).toBe("clarify");
	});
	it("never widens a partial scope, ignores constraints or invents a profile", () => {
		for (const extra of [{ scopeRef: "/tmp/docs" }, { constraints: ["no embedding"] }, { profileRef: "invented" }])
			expect(planIndexIntent(request("rebuild", extra), snapshot).operation).toBe("clarify");
	});
	it("resolves local constraints and ambiguous profiles", () => {
		expect(planIndexIntent(request("rebuild", { constraints: ["local"] }), snapshot)).toMatchObject({
			embeddingProfile: "local-qwen3",
		});
		expect(
			planIndexIntent(request("rebuild", { profileRef: "api" }), {
				...snapshot,
				profiles: [...snapshot.profiles, { id: "online2", kind: "api", model: "remote2" }],
			}).operation,
		).toBe("clarify");
	});
	it("cancels only the exact session-owned job", () => {
		expect(planIndexIntent(request("cancel_job"), snapshot)).toEqual({ operation: "cancel", jobId: "owned-job" });
		expect(planIndexIntent(request("cancel_job", { jobRef: "foreign" }), snapshot).operation).toBe("clarify");
		expect(planIndexIntent(request("cancel_job"), { ...snapshot, localJobId: undefined }).operation).toBe("clarify");
	});
});

describe("index intent conversation", () => {
	it("ordinary inputs and complete commands make no interpretation calls", async () => {
		const r = router();
		expect(await r.route.handle("总结刚添加的资料")).toBe(false);
		await r.route.handle("请重建当前索引");
		expect(r.complete).not.toHaveBeenCalled();
		expect(r.execute).toHaveBeenCalledExactlyOnceWith(
			{ operation: "build", embeddingProfile: "local-qwen3" },
			expect.any(String),
		);
	});
	it("interprets and dispatches candidates once, without another tool selection turn", async () => {
		const r = router();
		await r.route.handle("用本地 Qwen 模型给已配置的文档目录建索引");
		expect(r.complete).toHaveBeenCalledTimes(1);
		expect(r.execute).toHaveBeenCalledTimes(1);
	});
	it("returns a semantic ordinary result to the original question pipeline", async () => {
		const r = router(vi.fn(async () => '{"kind":"ordinary"}'));
		expect(await r.route.handle("新资料怎么搜不到")).toBe(false);
		expect(r.execute).not.toHaveBeenCalled();
	});
	it("clarifies missing parameters and resolves a contextual reply", async () => {
		const complete = vi
			.fn()
			.mockResolvedValueOnce(
				JSON.stringify({ kind: "clarify", question: "哪个 profile？", partial: request("rebuild") }),
			)
			.mockResolvedValueOnce(output(request("rebuild", { profileRef: "local-qwen3" })));
		const r = router(complete);
		await r.route.handle("用 API 或本地建立索引");
		expect(r.execute).not.toHaveBeenCalled();
		await r.route.handle("本地");
		expect(complete.mock.calls[1][0]).toContain("哪个 profile");
		expect(r.execute).toHaveBeenCalledTimes(1);
	});
	it("abandons clarification without cancelling a running job", async () => {
		const r = router(vi.fn(async () => JSON.stringify({ kind: "clarify", question: "哪个 profile？" })));
		await r.route.handle("建立 API 索引");
		await r.route.handle("取消");
		expect(r.execute).not.toHaveBeenCalled();
		expect(r.route.gate("好的").kind).toBe("ordinary");
	});
	it("a new ordinary question discards previous permission", async () => {
		const r = router(vi.fn(async () => JSON.stringify({ kind: "clarify", question: "哪个 profile？" })));
		await r.route.handle("建立 API 索引");
		await r.route.handle("总结新资料");
		expect(r.route.gate("好的").kind).toBe("ordinary");
	});
	it("fails closed on malformed output and missing credentials", async () => {
		for (const complete of [
			vi.fn(async () => "not json"),
			vi.fn(async () => {
				throw new Error("missing credentials");
			}),
		]) {
			const r = router(complete);
			await r.route.handle("给新资料建索引");
			expect(r.execute).not.toHaveBeenCalled();
			expect(r.notify).toHaveBeenCalled();
		}
	});
	it("ignores a late model response after cancellation even if transport ignores abort", async () => {
		let finish!: (s: string) => void;
		const r = router(
			vi.fn(
				() =>
					new Promise<string>((resolve) => {
						finish = resolve;
					}),
			),
		);
		const work = r.route.handle("给新资料建索引");
		r.route.reset();
		finish(output(request("rebuild")));
		await work;
		expect(r.execute).not.toHaveBeenCalled();
	});
	it("newer input invalidates an older candidate", async () => {
		let finish!: (s: string) => void;
		const r = router(
			vi.fn(
				() =>
					new Promise<string>((resolve) => {
						finish = resolve;
					}),
			),
		);
		const old = r.route.handle("给新资料建索引");
		await r.route.handle("查看当前索引进度");
		finish(output(request("rebuild")));
		await old;
		expect(r.execute).toHaveBeenCalledTimes(1);
		expect(r.execute.mock.calls[0][0].operation).toBe("status");
	});
	it("times out without waiting for an uncooperative provider", async () => {
		vi.useFakeTimers();
		try {
			const r = router(vi.fn(() => new Promise<string>(() => {})));
			const work = r.route.handle("给新资料建索引");
			await vi.advanceTimersByTimeAsync(12_001);
			await work;
			expect(r.execute).not.toHaveBeenCalled();
			expect(r.notify.mock.calls[0][0]).toContain("timed out");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("index intent execution boundaries", () => {
	it("splits compound instructions without executing a subset", async () => {
		const r = router();
		await r.route.handle("先更新索引，再总结新资料");
		expect(r.notify.mock.calls[0][0]).toContain("分开执行");
		expect(r.execute).not.toHaveBeenCalled();
		expect(r.complete).not.toHaveBeenCalled();
	});
	it("does not parse a question mark as an imperative command", () => {
		expect(classifyIndexInput("请重建当前索引？").kind).toBe("candidate");
	});
	it("keeps an unresolved restriction across a generic yes", async () => {
		const complete = vi
			.fn()
			.mockResolvedValueOnce(output(request("rebuild", { constraints: ["不要重新向量化"] })))
			.mockResolvedValueOnce(output(request("rebuild")));
		const r = router(complete);
		await r.route.handle("重建索引但不要重新向量化");
		await r.route.handle("好的");
		expect(r.execute).not.toHaveBeenCalled();
	});
	it("chooses the configured default only for an initial index", () => {
		expect(planIndexIntent(request("ensure_index"), { ...snapshot, ready: false })).toEqual({
			operation: "build",
			embeddingProfile: "online",
		});
	});
});
