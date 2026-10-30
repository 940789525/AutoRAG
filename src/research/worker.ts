import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ResearchService } from "./service.ts";
import { errorText } from "./types.ts";

let service: ResearchService;
let activeWorker = false;

const scanWorkflow = DBOS.registerWorkflow(
	async (batchId: string) => {
		try {
			await DBOS.runStep(() => service.observeBatch(batchId), {
				name: "observe",
				retriesAllowed: true,
				maxAttempts: 3,
				intervalSeconds: 2,
			});
			await DBOS.runStep(() => service.indexBatch(batchId), {
				name: "index-and-plan",
				retriesAllowed: true,
				maxAttempts: 3,
				intervalSeconds: 2,
			});
		} catch (error) {
			await DBOS.runStep(async () => {
				await service.db.pool.query(
					"UPDATE research.batches SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status<>'ready'",
					[batchId, errorText(error)],
				);
			});
		}
	},
	{ name: "research.scan.v1" },
);

const readingWorkflow = DBOS.registerWorkflow(
	async (runId: string) => {
		try {
			const input = await DBOS.runStep(() => service.loadReading(runId), { name: "load-frozen-input" });
			if (!input) return;
			const selected = await DBOS.runStep(() => service.screening(runId, input), {
				name: "screen",
				retriesAllowed: false,
			});
			if (!selected) return;
			const result = await DBOS.runStep(() => service.read(runId, input), { name: "read", retriesAllowed: false });
			if (result)
				await DBOS.runStep(() => service.commitNote(runId, result), {
					name: "validate-and-commit",
					retriesAllowed: false,
				});
		} catch (error) {
			await DBOS.runStep(() => service.failRun(runId, error), { name: "record-failure" });
		}
	},
	{ name: "research.read.v1" },
);

export interface ResearchWorker {
	dispatch(): Promise<void>;
	stop(): Promise<void>;
}

export async function startResearchWorker(current: ResearchService, databaseUrl: string): Promise<ResearchWorker> {
	if (activeWorker) throw new Error("Only one research worker may run in this process");
	const lease = await current.db.pool.connect();
	const acquired = (await lease.query("SELECT pg_try_advisory_lock(77261028) AS acquired")).rows[0].acquired;
	if (!acquired) {
		lease.release();
		throw new Error("Another research worker already owns this database");
	}
	activeWorker = true;
	service = current;
	try {
		DBOS.setConfig({
			name: "autorag-research",
			applicationVersion: "research-v1",
			systemDatabaseUrl: databaseUrl,
			systemDatabaseSchemaName: "research_dbos",
			enableOTLP: false,
		});
		await DBOS.launch();
		await DBOS.registerQueue("research", { globalConcurrency: 1, workerConcurrency: 1 });
		let busy = false;
		let stopped = false;
		let lastMaintenance = 0;
		const dispatch = async () => {
			if (busy || stopped) return;
			busy = true;
			try {
				if (Date.now() - lastMaintenance > 3600000) {
					await service.db.pool.query(
						"DELETE FROM research.api_requests WHERE created_at<now()-interval '7 days'",
					);
					await service.db.pool.query(
						"DELETE FROM research.run_events WHERE created_at<now()-interval '7 days' AND type IN ('planned','screening','reading','validating')",
					);
					lastMaintenance = Date.now();
				}
				const batches = await service.db.pool.query(
					"SELECT id FROM research.batches WHERE dispatch_state='pending' AND status='planned' ORDER BY created_at LIMIT 50",
				);
				for (const batch of batches.rows) {
					await DBOS.startWorkflow(scanWorkflow, {
						workflowID: `research:scan:${batch.id}`,
						queueName: "research",
					})(batch.id);
					await service.db.pool.query("UPDATE research.batches SET dispatch_state='submitted' WHERE id=$1", [
						batch.id,
					]);
				}
				const runs = await service.db.pool.query(
					"SELECT id,workflow_id FROM research.analysis_runs WHERE dispatch_state='pending' AND state='planned' ORDER BY created_at,id LIMIT 100",
				);
				for (const run of runs.rows) {
					await DBOS.startWorkflow(readingWorkflow, { workflowID: run.workflow_id, queueName: "research" })(
						run.id,
					);
					await service.db.pool.query("UPDATE research.analysis_runs SET dispatch_state='submitted' WHERE id=$1", [
						run.id,
					]);
				}
			} finally {
				busy = false;
			}
		};
		await dispatch();
		const timer = setInterval(() => {
			void dispatch().catch((error) => console.error(errorText(error)));
		}, 2000);
		timer.unref();
		return {
			dispatch,
			async stop() {
				if (stopped) return;
				stopped = true;
				clearInterval(timer);
				service.stop();
				try {
					await DBOS.shutdown();
				} finally {
					await lease.query("SELECT pg_advisory_unlock(77261028)");
					lease.release();
					activeWorker = false;
				}
			},
		};
	} catch (error) {
		await DBOS.shutdown();
		await lease.query("SELECT pg_advisory_unlock(77261028)");
		lease.release();
		activeWorker = false;
		throw error;
	}
}
