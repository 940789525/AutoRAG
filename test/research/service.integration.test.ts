import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, it } from "vitest";
import { writeRefreshProgress } from "../../src/agent/refresh-progress.ts";
import { createResearchInbox } from "../../src/agent/research-inbox.ts";
import { ResearchClient } from "../../src/research/client.ts";
import { ResearchDatabase } from "../../src/research/database.ts";
import { createResearchServer } from "../../src/research/server.ts";
import { ResearchService } from "../../src/research/service.ts";
import { TERMINAL_RUNS } from "../../src/research/types.ts";
import { type ResearchWorker, startResearchWorker } from "../../src/research/worker.ts";
import { fixtureRuntime } from "./fixture-runtime.ts";

const url = process.env.AUTORAG_RESEARCH_TEST_DATABASE_URL;
describe.skipIf(!url)("research inbox with real PostgreSQL and DBOS", () => {
	let db: ResearchDatabase;
	let root: string;
	let app: FastifyInstance;
	let service: ResearchService;
	let worker: ResearchWorker;
	let fixture: ReturnType<typeof fixtureRuntime>;
	let libraryId: string;
	let topicId: string;
	const children: ChildProcess[] = [];
	let key = 0;
	async function until<T>(fn: () => Promise<T | undefined | false>, timeout = 60000): Promise<T> {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			const result = await fn();
			if (result) return result;
			await sleep(100);
		}
		throw new Error("Timed out waiting for research state");
	}
	async function post(path: string, body?: object, fixedKey?: string) {
		const response = await app.inject({
			method: "POST",
			url: `/research/v1${path}`,
			headers: { "idempotency-key": fixedKey ?? `qa-${++key}` },
			...(body ? { payload: body } : {}),
		});
		assert(response.statusCode < 300, response.body);
		return response.json();
	}
	async function scan(mode: "seed" | "incremental") {
		const batch = await post(`/libraries/${libraryId}/scans`, { mode });
		await worker.dispatch();
		await until(async () => {
			const row = (await db.pool.query("SELECT * FROM research.batches WHERE id=$1", [batch.id])).rows[0];
			if (row.status === "failed") throw new Error(row.error);
			return row.status === "ready" && row;
		});
		return batch.id as string;
	}
	async function settled() {
		await worker.dispatch();
		return until(async () => {
			const rows = (await db.pool.query("SELECT * FROM research.analysis_runs ORDER BY created_at")).rows;
			return rows.length > 0 && rows.every((row) => TERMINAL_RUNS.includes(row.state)) && rows;
		});
	}
	beforeAll(async () => {
		assert(
			url && /(?:_test|_qa)$/u.test(new URL(url).pathname),
			"Integration tests require a dedicated database ending _test or _qa",
		);
		db = new ResearchDatabase(url);
		await db.pool.query("DROP SCHEMA IF EXISTS research_dbos CASCADE; DROP SCHEMA IF EXISTS research CASCADE");
		await db.migrate();
		await db.migrate();
		root = await mkdtemp(join(tmpdir(), "research-integration-"));
		fixture = fixtureRuntime(root);
		service = new ResearchService(db, fixture.runtime, { root, workspace: `${root}-workspace`, stabilityMs: 1 });
		app = createResearchServer(service);
		worker = await startResearchWorker(service, url);
		await assert.rejects(startResearchWorker(service, url), /Only one research worker/);
	}, 60000);
	afterAll(async () => {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			}
		await app?.close();
		await worker?.stop();
		if (db) {
			await db.pool.query("DROP SCHEMA IF EXISTS research_dbos CASCADE; DROP SCHEMA IF EXISTS research CASCADE");
			await db.close();
		}
		if (root) await rm(root, { recursive: true, force: true });
		if (root) await rm(`${root}-workspace`, { recursive: true, force: true });
	}, 60000);
	it("seeds without LLM calls, freezes batches, deduplicates, cancels late results, retries and records feedback", async () => {
		const created = await post("/libraries", { name: "QA papers" }, "library");
		libraryId = created.id;
		assert.equal((await post("/libraries", { name: "QA papers" }, "library")).id, libraryId);
		assert.equal(
			(
				await app.inject({
					method: "POST",
					url: "/research/v1/libraries",
					headers: { "idempotency-key": "library" },
					payload: { name: "different" },
				})
			).statusCode,
			409,
		);
		assert.equal(
			(await app.inject({ method: "GET", url: "/research/v1/health", headers: { origin: "https://evil.example" } }))
				.statusCode,
			403,
		);
		assert.equal(
			(await app.inject({ method: "GET", url: "/research/v1/health", headers: { host: "evil.example" } }))
				.statusCode,
			403,
		);
		assert.equal(
			(
				await app.inject({
					method: "POST",
					url: "/research/v1/libraries",
					headers: { "idempotency-key": "bad" },
					payload: { name: "bad", root: "/etc" },
				})
			).statusCode,
			400,
		);
		await writeFile(join(root, "2501.12345v1.pdf"), "Seed paper: baseline method, shared dataset.");
		topicId = (
			await post("/topics", {
				libraryId,
				title: "Retrieval",
				question: "How does retrieval change?",
				focus: ["experiments"],
				exclusions: [],
			})
		).id;
		await scan("seed");
		assert.equal(fixture.screens, 0);
		assert.equal(fixture.inputs.length, 0);
		assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM research.analysis_runs")).rows[0].n, 0);
		await writeFile(join(root, "new-a.pdf"), "New A: novel local method on a different dataset.");
		await writeFile(join(root, "new-b.pdf"), "New B: another local method, compare carefully.");
		const batchId = await scan("incremental");
		const batchResponse = (await app.inject({ method: "GET", url: `/research/v1/batches/${batchId}` })).json();
		assert.equal(batchResponse.items.length, 2);
		assert(batchResponse.items.every((item: { path: string }) => item.path.startsWith(root)));
		const runs = await settled();
		assert.equal(runs.length, 2);
		assert(runs.every((row) => row.state === "succeeded"));
		for (const input of fixture.inputs) {
			assert.equal(input.baseline.length, 1);
			assert.match(input.baseline[0].source, /2501\.12345v1/);
			assert(!input.baseline.some((old) => old.id === input.target.id));
		}
		await writeFile(join(root, "copy.pdf"), await readFile(join(root, "new-a.pdf")));
		await scan("incremental");
		await settled();
		assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM research.analysis_runs")).rows[0].n, 2);
		assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM research.file_locations")).rows[0].n, 4);
		await writeFile(join(root, "2501.12345v2.pdf"), "Second version: changed experiments.");
		await scan("incremental");
		await settled();
		const version = fixture.inputs.find((input) => input.target.source.endsWith("2501.12345v2.pdf"))!;
		assert(version);
		assert(!version.baseline.some((old) => old.paperId === version.target.paperId));
		assert.equal(
			(await db.pool.query("SELECT count(*)::int AS n FROM research.papers WHERE arxiv_id='2501.12345'")).rows[0].n,
			1,
		);
		const inbox = (await app.inject({ method: "GET", url: "/research/v1/inbox" })).json();
		assert.equal(inbox.length, 3);
		const overview = (await app.inject({ method: "GET", url: "/research/v1/overview" })).json();
		assert.equal(overview.unread, 3);
		assert.equal(overview.topics.length, 1);
		assert.equal(overview.libraries[0].id, libraryId);
		const client = new ResearchClient("http://127.0.0.1:8765", (async (input, init) => {
			const url = new URL(String(input));
			const response = await app.inject({
				method: (init?.method ?? "GET") as "GET" | "POST",
				url: url.pathname + url.search,
				headers: Object.fromEntries(new Headers(init?.headers)),
				...(init?.body ? { payload: String(init.body) } : {}),
			});
			return new Response(response.body, {
				status: response.statusCode,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch);
		let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		let picks = 0;
		let views = 0;
		const ctx = {
			hasUI: true,
			ui: {
				select: async (_title: string, options: string[]) =>
					picks++ === 0 ? options[0] : picks === 2 ? "标为已读" : "返回",
				custom: async () => {
					views++;
				},
				notify: () => {},
				setStatus: () => {},
			},
		} as unknown as ExtensionContext;
		createResearchInbox({ baseUrl: client.baseUrl, client })({
			on: () => {},
			registerCommand: (_name: string, registration: { handler: typeof command }) => {
				command = registration.handler;
			},
		} as unknown as ExtensionAPI);
		assert(command);
		await command("inbox", ctx);
		assert.equal(views, 1);
		assert.equal(
			(await db.pool.query("SELECT review_state FROM research.inbox_items WHERE id=$1", [inbox[0].id])).rows[0]
				.review_state,
			"read",
		);
		await post(`/inbox/${inbox[0].id}/feedback`, { kind: "reading_state", value: "read" });
		assert.equal(
			(await db.pool.query("SELECT review_state FROM research.inbox_items WHERE id=$1", [inbox[0].id])).rows[0]
				.review_state,
			"read",
		);
		const events = await app.inject({
			method: "GET",
			url: `/research/v1/runs/${runs[0].id}/events`,
			headers: { "last-event-id": "1" },
		});
		assert.match(events.body, /event: succeeded/);
		assert(!events.body.includes("New A"));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fixture.setBlock(() => gate);
		await writeFile(join(root, "cancel.pdf"), "A new paper whose model ignores cancellation.");
		const cancelBatch = await scan("incremental");
		await worker.dispatch();
		const cancelled = await until(
			async () =>
				(
					await db.pool.query("SELECT * FROM research.analysis_runs WHERE batch_id=$1 AND state='reading'", [
						cancelBatch,
					])
				).rows[0],
		);
		await until(async () => fixture.inputs.some((input) => input.target.id === cancelled.asset_id));
		await post(`/runs/${cancelled.id}/cancel`);
		release();
		fixture.setBlock();
		await sleep(300);
		assert.equal(
			(await db.pool.query("SELECT count(*)::int AS n FROM research.inbox_items WHERE run_id=$1", [cancelled.id]))
				.rows[0].n,
			0,
		);
		const retry = await post(`/runs/${cancelled.id}/retry`);
		assert.equal(retry.generation, 1);
		await settled();
		assert.equal(
			(await db.pool.query("SELECT state FROM research.analysis_runs WHERE id=$1", [retry.id])).rows[0].state,
			"succeeded",
		);
		assert.equal(
			(await db.pool.query("SELECT count(*)::int AS n FROM research.inbox_items WHERE run_id=$1", [retry.id]))
				.rows[0].n,
			1,
		);
		// Ordered event IDs and terminal state are committed together.
		const seqs = (
			await db.pool.query("SELECT seq FROM research.run_events WHERE run_id=$1 ORDER BY seq", [retry.id])
		).rows.map((row) => row.seq);
		assert.deepEqual(
			seqs,
			seqs.map((_, index) => index + 1),
		);
		assert.equal(
			(await db.pool.query("SELECT jsonb_array_length(baseline) AS n FROM research.batches WHERE id=$1", [batchId]))
				.rows[0].n,
			1,
		);
	}, 120000);
	it("enforces the automatic reading budget and allows an explicit deferred retry", async () => {
		const before = fixture.inputs.length;
		for (let index = 0; index < 11; index++)
			await writeFile(join(root, `budget-${index}.pdf`), `Budget fixture paper ${index}: independent content.`);
		const batchId = await scan("incremental");
		const runs = (await settled()).filter((row) => row.batch_id === batchId);
		assert.equal(runs.filter((row) => row.state === "succeeded").length, 10);
		const deferred = runs.find((row) => row.state === "deferred");
		assert(deferred);
		assert.equal(fixture.inputs.length - before, 10);
		await post(`/runs/${deferred.id}/retry`);
		await settled();
		assert.equal(fixture.inputs.length - before, 11);
	}, 120000);
	it("reports active indexing progress and excludes progress left by an earlier batch", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refresh = fixture.runtime.refresh;
		fixture.runtime.refresh = async () => {
			await gate;
		};
		try {
			await writeFile(join(root, "progress.pdf"), "Progress fixture paper: independent content.");
			const batch = await post(`/libraries/${libraryId}/scans`, { mode: "incremental" });
			await worker.dispatch();
			await until(
				async () =>
					(await db.pool.query("SELECT status FROM research.batches WHERE id=$1", [batch.id])).rows[0].status ===
					"indexing",
			);
			const progress = {
				version: 1 as const,
				runId: "progress",
				pid: process.pid,
				state: "running" as const,
				phase: "minsync" as const,
				startedAt: "2025-01-01T00:00:00Z",
				updatedAt: new Date().toISOString(),
				indexing: { runId: "index", phase: "embed" as const, state: "start" as const, count: 32, elapsedMs: 1000 },
			};
			writeRefreshProgress(service.options.workspace, progress);
			assert.equal(
				(await app.inject({ method: "GET", url: `/research/v1/batches/${batch.id}` })).json().progress,
				undefined,
			);
			writeRefreshProgress(service.options.workspace, { ...progress, startedAt: new Date().toISOString() });
			const response = (await app.inject({ method: "GET", url: `/research/v1/batches/${batch.id}` })).json();
			assert.equal(response.progress.indexing.phase, "embed");
			assert.equal(response.progress.indexing.count, 32);
			assert.equal(response.progress.ownerAlive, true);
		} finally {
			release();
			fixture.runtime.refresh = refresh;
		}
		await until(
			async () =>
				!(await db.pool.query("SELECT 1 FROM research.batches WHERE status IN ('planned','scanning','indexing')"))
					.rowCount,
		);
		await settled();
	}, 60000);
	it("recovers the real reading workflow after SIGKILL without repeating the completed screening step", async () => {
		await worker.stop();
		await db.pool.query("CREATE TABLE research.qa_calls(phase text NOT NULL)");
		const asset = (
			await db.pool.query("SELECT id FROM research.paper_assets WHERE state='ready' ORDER BY id LIMIT 1")
		).rows[0];
		const run = await db.transaction((client) => service.planAnalysis(client, asset.id, topicId));
		const startChild = (crash: boolean) => {
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", fileURLToPath(new URL("./recovery-child.ts", import.meta.url))],
				{
					env: {
						...process.env,
						AUTORAG_RESEARCH_TEST_DATABASE_URL: url,
						RESEARCH_QA_ROOT: root,
						RESEARCH_QA_CRASH: crash ? "1" : "0",
						AUTORAG_HOME: join(root, ".home"),
						AUTORAG_CONFIG: join(root, ".home", "config.json"),
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout?.on("data", (data) => {
				output += data;
			});
			child.stderr?.on("data", (data) => {
				output += data;
			});
			children.push(child);
			return { child, output: () => output };
		};
		const first = startChild(true);
		await until(async () => {
			if (first.child.exitCode !== null) throw new Error(first.output());
			return (
				(await db.pool.query("SELECT count(*)::int AS n FROM research.qa_calls WHERE phase='read'")).rows[0].n === 1
			);
		});
		first.child.kill("SIGKILL");
		await new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
		const second = startChild(false);
		await until(async () => {
			if (second.child.exitCode !== null) throw new Error(second.output());
			const row = (await db.pool.query("SELECT state,error FROM research.analysis_runs WHERE id=$1", [run.id]))
				.rows[0];
			if (row.state === "failed") throw new Error(row.error);
			return row.state === "succeeded";
		});
		assert.equal(
			(await db.pool.query("SELECT count(*)::int AS n FROM research.qa_calls WHERE phase='screen'")).rows[0].n,
			1,
		);
		assert.equal(
			(await db.pool.query("SELECT count(*)::int AS n FROM research.qa_calls WHERE phase='read'")).rows[0].n,
			2,
		);
		assert.equal(
			(await db.pool.query("SELECT count(*)::int AS n FROM research.inbox_items WHERE run_id=$1", [run.id])).rows[0]
				.n,
			1,
		);
		second.child.kill("SIGTERM");
		await new Promise<void>((resolve) => second.child.once("exit", () => resolve()));
	}, 120000);
});
