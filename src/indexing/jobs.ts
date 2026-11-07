import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../mirror/atomic-write.ts";
import { acquireIndexLease } from "./lease.ts";
import { ownerAlive, processBirth } from "./process-owner.ts";
import type { IndexEvent, IndexReport } from "./types.ts";

export interface IndexJobRequest {
	mode: "build" | "refresh" | "remove" | "restore";
	sourceId?: string;
	embeddingProfile?: string;
	scopeIds?: readonly string[];
	requestId?: string;
	configurationFingerprint?: string;
}
export interface IndexJob {
	version: 1;
	jobId: string;
	requestId: string;
	configurationFingerprint?: string;
	scopeIds?: readonly string[];
	owner: string;
	pid: number;
	birth?: string;
	mode: "build" | "refresh" | "remove" | "restore";
	sourceId?: string;
	embeddingProfile: string;
	state: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
	startedAt: string;
	updatedAt: string;
	phase?: string;
	event?: IndexEvent;
	report?: IndexReport;
	error?: string;
	partial?: boolean;
	sourceStage?: string;
}

const terminal = (job: IndexJob) => ["succeeded", "failed", "cancelled", "interrupted"].includes(job.state);
const activeOwners = new Set<string>();

/** Local TUI jobs, not a background queue or network service. */
export class IndexJobs {
	private readonly directory: string;
	private readonly owner = randomUUID();
	private current?: { job: IndexJob; controller: AbortController; done: Promise<void> };
	private readonly listeners = new Set<(job: IndexJob) => void>();
	constructor(root: string) {
		this.directory = join(root, ".autorag", "index-jobs");
	}
	subscribe(listener: (job: IndexJob) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private write(job: IndexJob): void {
		mkdirSync(this.directory, { recursive: true });
		job.updatedAt = new Date().toISOString();
		writeFileAtomic(join(this.directory, `${job.jobId}.json`), JSON.stringify(job, null, 2));
		writeFileAtomic(join(this.directory, "latest.json"), JSON.stringify(job, null, 2));
		for (const listener of this.listeners) {
			try {
				listener({ ...job });
			} catch {
				/* Observers cannot fail indexing. */
			}
		}
	}
	status(id?: string): IndexJob | undefined {
		if (id && !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid index job id");
		if (this.current && ((id && this.current.job.jobId === id) || (!id && !terminal(this.current.job))))
			return { ...this.current.job };
		const path = join(this.directory, id ? `${id}.json` : "latest.json");
		if (!existsSync(path)) return undefined;
		const job = JSON.parse(readFileSync(path, "utf8")) as IndexJob;
		if (!terminal(job)) {
			const alive = ownerAlive(job.pid, job.birth);
			if (!alive || (job.pid === process.pid && !activeOwners.has(job.owner)))
				return {
					...job,
					state: "interrupted",
					error: "Index task owner is no longer active; refresh explicitly to recover",
				};
		}
		return job;
	}
	private requestPath(id: string): string {
		return join(this.directory, `request-${createHash("sha256").update(id).digest("hex")}.json`);
	}
	forRequest(id: string): IndexJob | undefined {
		const file = this.requestPath(id);
		return existsSync(file) ? this.status(JSON.parse(readFileSync(file, "utf8")).jobId) : undefined;
	}
	start(
		request: IndexJobRequest & { embeddingProfile: string },
		execute: (signal: AbortSignal, event: (event: IndexEvent) => void) => Promise<IndexReport>,
	): IndexJob {
		const release = acquireIndexLease(join(this.directory, "submission"));
		try {
			const previous = this.status();
			const requestPath = request.requestId ? this.requestPath(request.requestId) : undefined;
			const repeated = request.requestId ? this.forRequest(request.requestId) : undefined;
			if (repeated) {
				if (
					repeated.configurationFingerprint !== request.configurationFingerprint ||
					repeated.mode !== request.mode ||
					repeated.sourceId !== request.sourceId ||
					repeated.embeddingProfile !== request.embeddingProfile ||
					JSON.stringify(repeated.scopeIds ?? []) !== JSON.stringify(request.scopeIds ?? [])
				)
					throw new Error("Index requestId conflicts with a different request");
				return repeated;
			}
			if (previous && !terminal(previous))
				throw new Error(`Index writer is busy: job ${previous.jobId}, pid ${previous.pid}`);
			const job: IndexJob = {
				version: 1,
				jobId: randomUUID(),
				requestId: request.requestId ?? randomUUID(),
				configurationFingerprint: request.configurationFingerprint,
				owner: this.owner,
				pid: process.pid,
				birth: processBirth(),
				scopeIds: request.scopeIds ? [...request.scopeIds] : undefined,
				mode: request.mode,
				sourceId: request.sourceId,
				embeddingProfile: request.embeddingProfile,
				state: "queued",
				startedAt: new Date().toISOString(),
				updatedAt: "",
			};
			const controller = new AbortController();
			this.write(job);
			if (requestPath) writeFileAtomic(requestPath, JSON.stringify({ jobId: job.jobId }));
			activeOwners.add(this.owner);
			const done = Promise.resolve().then(async () => {
				try {
					controller.signal.throwIfAborted();
					job.state = "running";
					this.write(job);
					let lastWrite = 0;
					job.report = await execute(controller.signal, (event) => {
						if (event.runId === "source") job.sourceStage = event.detail;
						const changed = job.phase !== event.phase;
						job.phase = event.phase;
						job.event = event;
						if (changed || Date.now() - lastWrite > 500 || event.state === "error" || event.phase === "done") {
							this.write(job);
							lastWrite = Date.now();
						}
					});
					job.state = controller.signal.aborted ? "cancelled" : job.report.ok ? "succeeded" : "failed";
					job.partial = !job.report.ok;
					if (!job.report.ok) job.error = job.report.failures.map((f) => `${f.path}: ${f.error}`).join("\n");
				} catch (error) {
					job.state = controller.signal.aborted ? "cancelled" : "failed";
					job.error = error instanceof Error ? error.message : String(error);
					job.partial = true;
				} finally {
					activeOwners.delete(this.owner);
					this.write(job);
				}
			});
			this.current = { job, controller, done };
			return { ...job };
		} finally {
			release();
		}
	}
	async wait(id: string): Promise<IndexJob> {
		if (this.current?.job.jobId === id) await this.current.done;
		return this.status(id)!;
	}
	cancel(id: string): IndexJob {
		const job = this.status(id);
		if (!job) throw new Error(`Index job not found: ${id}`);
		if (terminal(job)) return job;
		if (!this.current || this.current.job.jobId !== id)
			throw new Error(`Index job ${id} belongs to another process (${job.pid}); no cancellation was sent`);
		this.current.job.state = "cancelling";
		this.current.controller.abort(new Error("Index task cancelled by user"));
		this.write(this.current.job);
		return { ...this.current.job };
	}
	async close(): Promise<void> {
		if (this.current && !terminal(this.current.job)) this.cancel(this.current.job.jobId);
		await this.current?.done;
	}
}
