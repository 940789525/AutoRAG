import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexControls, createIndexTool, type IndexOperations } from "../../src/agent/index-controls.ts";
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
		fileCoverage: vi.fn(async () => ({ files: [], total: 0, registered: 0, complete: true, diagnostics: [] })),
		start: vi.fn((request) =>
			jobs.start({ ...request, embeddingProfile: request.embeddingProfile ?? "local-qwen3" }, async () => report),
		),
		activeIndex: () => ({ ready: true, defaultProfile: "local-qwen3", embeddingProfile: "local-qwen3" }),
		authorizeWrite: () => {
			throw new Error("explicit TUI request required");
		},
	} satisfies IndexOperations;
}
describe("TUI indexing commands and native tool", () => {
	it("works without a conversation model and subscribes again after session replacement", async () => {
		vi.useFakeTimers();
		const ops = { ...operations(), onSessionEnd: vi.fn() };
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
			await command("refresh", ctx);
			const own = ops.jobs.status()!;
			expect(own.mode).toBe("refresh");
			await command(`status --job ${own.jobId}`, ctx);
			await command(`cancel --job ${own.jobId}`, ctx);
			await ops.jobs.close();
			expect(notes).toHaveBeenCalled();
			expect(widget).toHaveBeenCalled();
			await handlers.get("session_shutdown")?.({}, ctx);
			expect(vi.getTimerCount()).toBe(0);
		}
		expect(ops.start).toHaveBeenCalledTimes(4);
		expect(ops.onSessionEnd).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
	it("cannot grant writes through tool parameters or a status-only user request", async () => {
		const ops = operations();
		const tool = createIndexTool(ops);
		const status = await createIndexTool({
			...ops,
			activeIndex: () => ({ embeddingProfile: "old-active", ready: true, defaultProfile: "local-qwen3" }),
		}).execute("status", { operation: "status" });
		expect(status.content).toEqual([expect.objectContaining({ text: expect.stringContaining("old-active") })]);
		expect(ops.fileCoverage).not.toHaveBeenCalled();
		const files = await tool.execute("files", { operation: "status", includeFiles: true, fileOffset: 100 });
		expect(ops.fileCoverage).toHaveBeenCalledWith(100, undefined);
		expect(files.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"coverage"') })]);
		await expect(tool.execute("write", { operation: "refresh", includeFiles: true })).rejects.toThrow(
			"requires operation status",
		);
		expect(ops.start).not.toHaveBeenCalled();
		await expect(tool.execute("write", { operation: "build", embeddingProfile: "local-qwen3" })).rejects.toThrow(
			/explicit TUI/,
		);
	});
	it("ensures from real state and deduplicates a first build even after the index becomes ready", async () => {
		const ops = operations();
		let ready = false;
		const tool = createIndexTool({
			...ops,
			authorizeWrite: () => ({ requestId: "original" }),
			activeIndex: () => ({ ...ops.activeIndex(), ready }),
		});
		await expect(tool.execute("r", { operation: "refresh" })).rejects.toThrow("No ready index");
		const first = await tool.execute("1", { operation: "ensure" });
		await ops.jobs.close();
		ready = true;
		const second = await tool.execute("2", { operation: "ensure" });
		const job = (r: typeof first) => JSON.parse((r.content[0] as { text: string }).text).job;
		expect(job(first).mode).toBe("build");
		expect(job(first).jobId).toBe(job(second).jobId);
		const fresh = createIndexTool({ ...ops, authorizeWrite: () => ({ requestId: "next" }) });
		expect(job(await fresh.execute("3", { operation: "ensure" })).mode).toBe("refresh");
		await ops.jobs.close();
	});
	it("refuses scope expansion, conflicting profiles, remote embedding for local-only and foreign cancellation", async () => {
		const ops = operations();
		const tool = createIndexTool({
			...ops,
			profiles: () => [...ops.profiles(), { id: "online", kind: "api", model: "remote" }],
			authorizeWrite: () => ({ requestId: "one", ownedJobId: "mine" }),
		});
		await expect(tool.execute("s", { operation: "ensure", scope: "one file" })).rejects.toThrow("all configured");
		await expect(tool.execute("r", { operation: "refresh", embeddingProfile: "online" })).rejects.toThrow("rebuild");
		await expect(tool.execute("u", { operation: "build", embeddingProfile: "unknown" })).rejects.toThrow("Unknown");
		await expect(
			tool.execute("p", { operation: "build", embeddingProfile: "online", localOnly: true }),
		).rejects.toThrow("remote API");
		await expect(tool.execute("c", { operation: "cancel", jobId: "other" })).rejects.toThrow("owned");
		expect(ops.start).not.toHaveBeenCalled();
	});
});
