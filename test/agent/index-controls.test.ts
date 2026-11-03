import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createIndexControls,
	createIndexTool,
	type IndexOperations,
	indexWriteOperations,
} from "../../src/agent/index-controls.ts";
import { IndexJobs } from "../../src/indexing/jobs.ts";
import type { IndexReport } from "../../src/indexing/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const report: IndexReport = {
	runId: "test",
	backend: "autorag",
	ok: true,
	durationMs: 1,
	timings: {},
	documents: 0,
	unchanged: 0,
	chunks: 0,
	embedded: 0,
	reused: 0,
	deleted: 0,
	failures: [],
	reportPath: "fixture",
};
function operations() {
	const root = mkdtempSync(join(tmpdir(), "autorag-index-controls-"));
	roots.push(root);
	const jobs = new IndexJobs(root);
	return {
		jobs,
		profiles: () => [{ id: "local-qwen3", kind: "local-http", model: "Qwen" }],
		start: vi.fn((request) =>
			jobs.start({ ...request, embeddingProfile: request.embeddingProfile ?? "local-qwen3" }, async () => report),
		),
		canWriteFromModel: () => false,
	} satisfies IndexOperations;
}
describe("TUI indexing commands and native tool", () => {
	it("works without a conversation model and subscribes again after session replacement", async () => {
		vi.useFakeTimers();
		const ops = { ...operations(), onCommand: vi.fn() };
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let command!: (text: string, ctx: ExtensionContext) => Promise<void>;
		const notes = vi.fn();
		const widget = vi.fn();
		const ctx = { hasUI: true, ui: { notify: notes, setWidget: widget } } as unknown as ExtensionContext;
		const pi = {
			on: (name: string, fn: typeof handlers extends Map<string, infer T> ? T : never) => handlers.set(name, fn),
			registerCommand: (_name: string, value: { handler: typeof command }) => {
				command = value.handler;
			},
		} as unknown as ExtensionAPI;
		createIndexControls(ops)(pi);
		for (let i = 0; i < 2; i++) {
			handlers.get("session_start")?.({}, ctx);
			await command("build --embedding local-qwen3", ctx);
			await ops.jobs.close();
			expect(notes).toHaveBeenCalled();
			expect(widget).toHaveBeenCalled();
			await handlers.get("session_shutdown")?.({}, ctx);
			expect(vi.getTimerCount()).toBe(0);
		}
		expect(ops.start).toHaveBeenCalledTimes(2);
		expect(ops.onCommand).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
	it("cannot grant writes through tool parameters or a status-only user request", async () => {
		const ops = operations();
		const tool = createIndexTool(ops);
		const status = await createIndexTool({
			...ops,
			activeIndex: () => ({ embeddingProfile: "old-active", ready: true }),
		}).execute("status", { operation: "status" });
		expect(status.content).toEqual([expect.objectContaining({ text: expect.stringContaining("old-active") })]);
		expect(ops.start).not.toHaveBeenCalled();
		await expect(tool.execute("write", { operation: "build", embeddingProfile: "local-qwen3" })).rejects.toThrow(
			/explicit TUI/,
		);
		expect(indexWriteOperations("查看索引状态").size).toBe(0);
		expect(indexWriteOperations("如何建立索引").size).toBe(0);
		expect([...indexWriteOperations("帮我刷新索引")]).toEqual(["refresh"]);
		expect([...indexWriteOperations("取消索引任务")]).toEqual(["cancel"]);
	});
});
