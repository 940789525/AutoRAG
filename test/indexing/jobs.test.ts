import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexJobs } from "../../src/indexing/jobs.ts";
import type { IndexReport } from "../../src/indexing/types.ts";

const roots: string[] = [];
const root = () => {
	const p = mkdtempSync(join(tmpdir(), "autorag-index-jobs-"));
	roots.push(p);
	return p;
};
afterEach(() => {
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const report: IndexReport = {
	runId: "test",
	backend: "autorag",
	ok: true,
	durationMs: 1,
	timings: {},
	documents: 1,
	unchanged: 0,
	chunks: 1,
	embedded: 1,
	reused: 0,
	deleted: 0,
	failures: [],
	reportPath: "fixture-report",
};
async function done(jobs: IndexJobs, id: string) {
	for (let i = 0; i < 100; i++) {
		const j = jobs.status(id)!;
		if (["succeeded", "failed", "cancelled", "interrupted"].includes(j.state)) return j;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("job timeout");
}
describe("local index task lifecycle", () => {
	it("returns a job immediately, records progress and persists its result", async () => {
		const p = root();
		const jobs = new IndexJobs(p);
		const j = jobs.start({ mode: "build", embeddingProfile: "local-qwen3" }, async (_signal, event) => {
			event({ runId: "test", phase: "embed", state: "start", elapsedMs: 0, count: 1 });
			return report;
		});
		expect(j.state).toBe("queued");
		expect((await done(jobs, j.jobId)).report).toEqual(report);
		expect(new IndexJobs(p).status(j.jobId)?.state).toBe("succeeded");
	});
	it("deduplicates retries, rejects conflicts and refuses another writer", async () => {
		const jobs = new IndexJobs(root());
		let finish!: (r: IndexReport) => void;
		const execute = () =>
			new Promise<IndexReport>((r) => {
				finish = r;
			});
		const request = { mode: "build" as const, embeddingProfile: "a", requestId: "same" };
		const j = jobs.start(request, execute);
		expect(jobs.start(request, execute).jobId).toBe(j.jobId);
		expect(() => jobs.start({ ...request, embeddingProfile: "b" }, execute)).toThrow(/conflicts/);
		expect(() => jobs.start({ ...request, requestId: "other" }, execute)).toThrow(/busy/);
		await Promise.resolve();
		finish(report);
		await done(jobs, j.jobId);
	});
	it("cancels only the owner task, and cancel is safe after completion", async () => {
		const p = root();
		const jobs = new IndexJobs(p);
		const j = jobs.start(
			{ mode: "refresh", embeddingProfile: "a" },
			async (signal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		await Promise.resolve();
		expect(() => new IndexJobs(p).cancel(j.jobId)).toThrow(/another process/);
		expect(jobs.cancel(j.jobId).state).toBe("cancelling");
		expect((await done(jobs, j.jobId)).state).toBe("cancelled");
		expect(jobs.cancel(j.jobId).state).toBe("cancelled");
	});
	it("keeps the original error and marks partial document failure as failed", async () => {
		const jobs = new IndexJobs(root());
		const j = jobs.start({ mode: "build", embeddingProfile: "a" }, async () => ({
			...report,
			ok: false,
			failures: [{ path: "/fixture/a", stage: "embed", error: "HTTP 503: fixture provider failed" }],
		}));
		const r = await done(jobs, j.jobId);
		expect(r.state).toBe("failed");
		expect(r.error).toContain("HTTP 503: fixture provider failed");
		expect(r.partial).toBe(true);
	});
	it("rejects path traversal in job ids", () => {
		expect(() => new IndexJobs(root()).status("../private")).toThrow(/Invalid/);
	});
	it("deduplicates an older request after another task completes", async () => {
		const jobs = new IndexJobs(root());
		const request = { mode: "build" as const, embeddingProfile: "a", requestId: "first" };
		const first = jobs.start(request, async () => report);
		await done(jobs, first.jobId);
		const second = jobs.start({ ...request, requestId: "second" }, async () => report);
		await done(jobs, second.jobId);
		expect(
			jobs.start(request, async () => {
				throw new Error("must not run");
			}).jobId,
		).toBe(first.jobId);
	});
	it("marks a persisted unknown owner as interrupted", () => {
		const p = root();
		const jobs = new IndexJobs(p);
		const fake = {
			jobId: "orphan",
			owner: "not-active",
			pid: process.pid,
			state: "running",
			mode: "build",
			embeddingProfile: "a",
			requestId: "orphan",
		};
		const directory = join(p, ".autorag", "index-jobs");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "orphan.json"), JSON.stringify(fake));
		expect(jobs.status("orphan")?.state).toBe("interrupted");
	});
});
