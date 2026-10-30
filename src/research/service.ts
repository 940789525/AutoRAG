import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { PoolClient } from "pg";
import { digest, type ResearchDatabase } from "./database.ts";
import { normalizeIdentity, stablePdfs } from "./discovery.ts";
import { validateNote } from "./reader.ts";
import type { ResearchRuntime } from "./runtime.ts";
import {
	type AssetRevision,
	errorText,
	type ReadingInput,
	type ReadingResult,
	ResearchError,
	TERMINAL_RUNS,
	type Topic,
} from "./types.ts";

export interface ServiceOptions {
	allowModelProcessing?: boolean;
	root: string;
	workspace: string;
	stabilityMs?: number;
}

export class ResearchService {
	readonly db: ResearchDatabase;
	readonly runtime: ResearchRuntime;
	readonly options: ServiceOptions;
	private readonly controllers = new Map<string, AbortController>();
	constructor(db: ResearchDatabase, runtime: ResearchRuntime, options: ServiceOptions) {
		this.db = db;
		this.runtime = runtime;
		this.options = options;
	}
	async createLibrary(client: PoolClient, name: string) {
		const existing = await client.query("SELECT * FROM research.libraries");
		if (existing.rows[0]) {
			if (
				existing.rows[0].root_path !== this.options.root ||
				existing.rows[0].workspace_path !== this.options.workspace
			)
				throw new ResearchError(409, "This database belongs to a different research library");
			return existing.rows[0];
		}
		const result = await client.query(
			"INSERT INTO research.libraries(id,name,root_path,workspace_path) VALUES($1,$2,$3,$4) RETURNING *",
			[randomUUID(), name, this.options.root, this.options.workspace],
		);
		return result.rows[0];
	}
	async baseline(client: PoolClient, libraryId: string): Promise<AssetRevision[]> {
		const result = await client.query(
			"SELECT a.id,a.paper_id,a.sha256,a.source_id,a.source_path,a.output_sha256 FROM research.paper_assets a WHERE a.library_id=$1 AND a.state='ready' AND EXISTS(SELECT 1 FROM research.file_locations f WHERE f.asset_id=a.id AND f.state='present') ORDER BY a.id",
			[libraryId],
		);
		return result.rows.map((row) => ({
			id: row.id,
			paperId: row.paper_id,
			sha256: row.sha256,
			sourceId: row.source_id,
			source: row.source_path,
			outputSha256: row.output_sha256,
		}));
	}
	async planScan(client: PoolClient, libraryId: string, kind: "seed" | "incremental") {
		const { rows } = await client.query("SELECT * FROM research.libraries WHERE id=$1 FOR UPDATE", [libraryId]);
		if (!rows[0]) throw new ResearchError(404, "Library not found");
		const active = await client.query(
			"SELECT * FROM research.batches WHERE library_id=$1 AND status IN ('planned','scanning','indexing')",
			[libraryId],
		);
		if (active.rows[0]) return active.rows[0];
		if (rows[0].state === "seeding" && kind !== "seed")
			throw new ResearchError(409, "Run the initial seed scan first");
		if (rows[0].state !== "seeding" && kind === "seed")
			throw new ResearchError(409, "Initial seed scan already completed");
		const baseline = await this.baseline(client, libraryId);
		const result = await client.query(
			"INSERT INTO research.batches(id,library_id,kind,baseline,manifest_digest) VALUES($1,$2,$3,$4,$5) RETURNING *",
			[randomUUID(), libraryId, kind, JSON.stringify(baseline), digest(baseline)],
		);
		return result.rows[0];
	}
	async observeBatch(batchId: string): Promise<void> {
		const batch = (await this.db.pool.query("SELECT * FROM research.batches WHERE id=$1", [batchId])).rows[0];
		if (!batch || ["ready", "failed"].includes(batch.status)) return;
		if (
			(await this.db.pool.query("SELECT 1 FROM research.batch_items WHERE batch_id=$1 LIMIT 1", [batchId])).rowCount
		)
			return;
		const observation = await stablePdfs(this.options.root, undefined, this.options.stabilityMs);
		if (batch.kind === "seed" && observation.pending.length)
			throw new Error("Seed inventory contains files still being written; retry when the initial PDFs are stable");
		if (batch.kind === "seed" && observation.files.length > 1000)
			throw new Error("Initial seed supports at most 1000 PDFs");
		await this.db.transaction(async (client) => {
			await client.query("SELECT id FROM research.batches WHERE id=$1 FOR UPDATE", [batchId]);
			if ((await client.query("SELECT 1 FROM research.batch_items WHERE batch_id=$1 LIMIT 1", [batchId])).rowCount)
				return;
			await client.query("UPDATE research.batches SET status='scanning' WHERE id=$1", [batchId]);
			const previous = (
				await client.query("SELECT * FROM research.file_locations WHERE library_id=$1", [batch.library_id])
			).rows;
			const byPath = new Map(previous.map((row) => [row.path, row]));
			const seen = [...observation.files.map((file) => file.path), ...observation.pending];
			await client.query(
				"UPDATE research.file_locations SET state='missing' WHERE library_id=$1 AND NOT(path=ANY($2::text[]))",
				[batch.library_id, seen],
			);
			let added = 0;
			let duplicates = 0;
			let deferred = observation.pending.length;
			for (const file of observation.files) {
				const old = byPath.get(file.path);
				const asset = (
					await client.query("SELECT * FROM research.paper_assets WHERE library_id=$1 AND sha256=$2", [
						batch.library_id,
						file.sha256,
					])
				).rows[0];
				if (old?.asset_id === asset?.id && asset?.state === "ready") {
					await client.query(
						"UPDATE research.file_locations SET state='present',last_seen_at=now(),size=$2,mtime=$3 WHERE id=$1",
						[old.id, file.size, file.mtime],
					);
					continue;
				}
				if (batch.kind !== "seed" && added >= 50 && !asset) {
					deferred++;
					continue;
				}
				let assetId = asset?.id;
				let kind = asset ? (asset.state === "ready" ? "duplicate" : "retry") : "new";
				if (!assetId) {
					const arxivMatch = /^(\d{4}\.\d{4,5})(?:v\d+)?\.pdf$/iu.exec(basename(file.path));
					const knownPaper = arxivMatch
						? (
								await client.query("SELECT id FROM research.papers WHERE library_id=$1 AND arxiv_id=$2", [
									batch.library_id,
									arxivMatch[1],
								])
							).rows[0]
						: undefined;
					const paperId = knownPaper?.id ?? randomUUID();
					if (!knownPaper)
						await client.query(
							"INSERT INTO research.papers(id,library_id,title,arxiv_id,identity_state) VALUES($1,$2,$3,$4,$5)",
							[
								paperId,
								batch.library_id,
								basename(file.path, ".pdf"),
								arxivMatch?.[1] ?? null,
								arxivMatch ? "identified" : "provisional",
							],
						);
					assetId = randomUUID();
					kind = knownPaper ? "version" : "new";
					await client.query(
						"INSERT INTO research.paper_assets(id,library_id,paper_id,sha256,size,first_batch_id) VALUES($1,$2,$3,$4,$5,$6)",
						[assetId, batch.library_id, paperId, file.sha256, file.size, batchId],
					);
					added++;
				} else duplicates++;
				const location = await client.query(
					"INSERT INTO research.file_locations(id,library_id,asset_id,path,size,mtime,state) VALUES($1,$2,$3,$4,$5,$6,'present') ON CONFLICT(library_id,path) DO UPDATE SET asset_id=$3,size=$5,mtime=$6,state='present',error=NULL,last_seen_at=now() RETURNING id",
					[old?.id ?? randomUUID(), batch.library_id, assetId, file.path, file.size, file.mtime],
				);
				await client.query(
					"INSERT INTO research.batch_items(id,library_id,batch_id,location_id,asset_id,kind,stage) VALUES($1,$2,$3,$4,$5,$6,'indexing')",
					[randomUUID(), batch.library_id, batchId, location.rows[0].id, assetId, kind],
				);
			}
			await client.query("UPDATE research.batches SET status='indexing',counts=$2 WHERE id=$1", [
				batchId,
				JSON.stringify({ added, duplicates, pending: deferred }),
			]);
		});
	}
	async indexBatch(batchId: string): Promise<void> {
		const batch = (await this.db.pool.query("SELECT * FROM research.batches WHERE id=$1", [batchId])).rows[0];
		if (!batch || batch.status === "ready") return;
		await this.runtime.refresh();
		const assets = (
			await this.db.pool.query(
				"SELECT DISTINCT a.* FROM research.paper_assets a JOIN research.batch_items i ON i.asset_id=a.id WHERE i.batch_id=$1",
				[batchId],
			)
		).rows;
		for (const asset of assets) {
			const revision = await this.runtime.revision(asset.sha256);
			await this.db.transaction(async (client) => {
				if (revision) {
					await client.query(
						"UPDATE research.paper_assets SET state='ready',source_id=$2,source_path=$3,output_sha256=$4,error=NULL WHERE id=$1",
						[asset.id, revision.sourceId, revision.source, revision.outputSha256],
					);
					await client.query(
						"UPDATE research.batch_items SET stage='ready',error=NULL WHERE batch_id=$1 AND asset_id=$2",
						[batchId, asset.id],
					);
				} else {
					const error = `No verified parsed/indexed revision for ${asset.sha256}; inspect the local refresh report`;
					await client.query("UPDATE research.paper_assets SET state='needs_review',error=$2 WHERE id=$1", [
						asset.id,
						error,
					]);
					await client.query(
						"UPDATE research.batch_items SET stage='failed',error=$3 WHERE batch_id=$1 AND asset_id=$2",
						[batchId, asset.id, error],
					);
				}
			});
		}
		await this.db.transaction(async (client) => {
			await client.query("SELECT id FROM research.batches WHERE id=$1 FOR UPDATE", [batchId]);
			if (batch.kind !== "seed") {
				const topics = (
					await client.query<Topic>("SELECT * FROM research.topics WHERE library_id=$1 AND active ORDER BY id", [
						batch.library_id,
					])
				).rows;
				const targets = (
					await client.query(
						"SELECT DISTINCT a.id FROM research.paper_assets a JOIN research.batch_items i ON i.asset_id=a.id WHERE i.batch_id=$1 AND i.kind IN ('new','version','retry') AND a.state='ready'",
						[batchId],
					)
				).rows;
				for (const topic of topics)
					for (const target of targets) await this.planAnalysis(client, target.id, topic.id, batchId);
			}
			await client.query("UPDATE research.batches SET status='ready',finished_at=now(),error=NULL WHERE id=$1", [
				batchId,
			]);
			await client.query("UPDATE research.libraries SET state='active',last_scan_at=now() WHERE id=$1", [
				batch.library_id,
			]);
		});
	}
	async planAnalysis(client: PoolClient, assetId: string, topicId: string, batchId?: string) {
		const asset = (await client.query("SELECT * FROM research.paper_assets WHERE id=$1 AND state='ready'", [assetId]))
			.rows[0];
		const topic = (await client.query<Topic>("SELECT * FROM research.topics WHERE id=$1", [topicId])).rows[0];
		if (!asset || !topic || topic.library_id !== asset.library_id)
			throw new ResearchError(404, "Ready asset and topic must belong to this library");
		const batch = (
			await client.query("SELECT * FROM research.batches WHERE id=$1", [batchId ?? asset.first_batch_id])
		).rows[0];
		const target: AssetRevision = {
			id: asset.id,
			paperId: asset.paper_id,
			sha256: asset.sha256,
			sourceId: asset.source_id,
			source: asset.source_path,
			outputSha256: asset.output_sha256,
		};
		const baseline: AssetRevision[] = batchId ? batch.baseline : await this.baseline(client, asset.library_id);
		const filtered = baseline.filter((item) => item.paperId !== target.paperId && item.id !== target.id);
		const key = digest([target, topic.id, topic.revision, filtered, "research-v1", batchId ? "automatic" : "manual"]);
		const id = randomUUID();
		await client.query(
			"INSERT INTO research.analysis_runs(id,library_id,batch_id,asset_id,topic_id,topic_snapshot,target,baseline,base_key,workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(base_key,generation) DO NOTHING",
			[
				id,
				asset.library_id,
				batch.id,
				assetId,
				topicId,
				JSON.stringify(topic),
				JSON.stringify(target),
				JSON.stringify(filtered),
				key,
				`research:${id}`,
			],
		);
		const result = (
			await client.query("SELECT * FROM research.analysis_runs WHERE base_key=$1 AND generation=0", [key])
		).rows[0];
		if (result.id === id) await this.db.event(client, id, "planned", { manual: !batchId });
		return result;
	}
	async loadReading(runId: string): Promise<ReadingInput | undefined> {
		const row = (await this.db.pool.query("SELECT * FROM research.analysis_runs WHERE id=$1", [runId])).rows[0];
		if (!row || row.cancel_requested || TERMINAL_RUNS.includes(row.state)) return undefined;
		return { target: row.target, topic: row.topic_snapshot, baseline: row.baseline };
	}
	async screening(runId: string, input: ReadingInput): Promise<boolean> {
		const action = await this.db.transaction(async (client) => {
			const row = (await client.query("SELECT * FROM research.analysis_runs WHERE id=$1 FOR UPDATE", [runId]))
				.rows[0];
			if (!row || row.cancel_requested || TERMINAL_RUNS.includes(row.state)) return "skip";
			if (row.state === "reading" || row.state === "validating") return "ready";
			await this.db.event(client, runId, "screening");
			return "screen";
		});
		if (action !== "screen") return action === "ready";
		const relevant = await this.withSignal(runId, (signal) => this.runtime.screen(input.target, input.topic, signal));
		return this.db.transaction(async (client) => {
			const current = (await client.query("SELECT * FROM research.analysis_runs WHERE id=$1 FOR UPDATE", [runId]))
				.rows[0];
			if (current.cancel_requested) return false;
			const manual = (
				await client.query("SELECT payload FROM research.run_events WHERE run_id=$1 AND seq=1", [runId])
			).rows[0]?.payload.manual;
			const used = await client.query(
				"SELECT count(*)::int AS n FROM research.analysis_runs WHERE batch_id=$1 AND topic_id=$2 AND deep_read_reserved=true",
				[current.batch_id, current.topic_id],
			);
			const state = !relevant ? "not_selected" : !manual && used.rows[0].n >= 10 ? "deferred" : "reading";
			if (state === "reading")
				await client.query("UPDATE research.analysis_runs SET deep_read_reserved=true WHERE id=$1", [runId]);
			await this.db.event(client, runId, state);
			if (state !== "reading")
				await client.query("UPDATE research.analysis_runs SET finished_at=now() WHERE id=$1", [runId]);
			return state === "reading";
		});
	}
	private async withSignal<T>(runId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		this.controllers.set(runId, controller);
		const timeout = setTimeout(() => controller.abort(new Error("Research model step exceeded 120 seconds")), 120000);
		try {
			if (!(await this.loadReading(runId))) throw new Error("Research run cancelled or already finished");
			return await fn(controller.signal);
		} finally {
			clearTimeout(timeout);
			this.controllers.delete(runId);
		}
	}
	async read(runId: string, input: ReadingInput): Promise<ReadingResult | undefined> {
		if (!(await this.loadReading(runId))) return undefined;
		return this.withSignal(runId, (signal) => this.runtime.read(input, signal));
	}
	async commitNote(runId: string, result: ReadingResult): Promise<void> {
		const row = (await this.db.pool.query("SELECT * FROM research.analysis_runs WHERE id=$1", [runId])).rows[0];
		if (row.cancel_requested || TERMINAL_RUNS.includes(row.state)) return;
		validateNote(result.note, result.evidence, row.target.id);
		const allowed: AssetRevision[] = [row.target, ...row.baseline];
		if (
			result.evidence.length > 12 ||
			result.evidence.some(
				(entry) =>
					!allowed.some(
						(asset) =>
							asset.id === entry.id &&
							asset.sha256 === entry.sha256 &&
							asset.outputSha256 === entry.outputSha256 &&
							asset.sourceId === entry.sourceId &&
							asset.source === entry.source,
					),
			)
		)
			throw new Error("Reading result contains evidence outside the frozen input");
		for (const asset of [row.target, ...result.evidence]) await this.runtime.verify(asset);
		await this.db.transaction(async (client) => {
			const current = (await client.query("SELECT * FROM research.analysis_runs WHERE id=$1 FOR UPDATE", [runId]))
				.rows[0];
			if (current.cancel_requested || TERMINAL_RUNS.includes(current.state)) return;
			const topic = (await client.query("SELECT revision FROM research.topics WHERE id=$1", [current.topic_id]))
				.rows[0];
			const changed = topic.revision !== current.topic_snapshot.revision;
			await client.query(
				"INSERT INTO research.inbox_items(id,library_id,run_id,topic_id,asset_id,payload,evidence,priority,relevance,validity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(run_id) DO NOTHING",
				[
					randomUUID(),
					current.library_id,
					runId,
					current.topic_id,
					current.asset_id,
					JSON.stringify(result.note),
					JSON.stringify(result.evidence),
					result.note.priority,
					result.note.relevance,
					changed ? "revision_changed" : "partial",
				],
			);
			await client.query("UPDATE research.analysis_runs SET result=$2,finished_at=now() WHERE id=$1", [
				runId,
				JSON.stringify({ coverage: result.coverage, usage: result.usage, diagnostics: result.diagnostics }),
			]);
			await this.db.event(client, runId, result.note.priority === "needs_review" ? "needs_review" : "succeeded", {
				coverage: result.coverage,
			});
		});
	}
	async failRun(runId: string, error: unknown): Promise<void> {
		await this.db.transaction(async (client) => {
			const row = (await client.query("SELECT * FROM research.analysis_runs WHERE id=$1 FOR UPDATE", [runId]))
				.rows[0];
			if (!row || TERMINAL_RUNS.includes(row.state)) return;
			await client.query("UPDATE research.analysis_runs SET error=$2,finished_at=now() WHERE id=$1", [
				runId,
				errorText(error),
			]);
			await this.db.event(client, runId, row.cancel_requested ? "cancelled" : "failed", { error: errorText(error) });
		});
	}
	async cancel(client: PoolClient, runId: string) {
		const row = (await client.query("SELECT * FROM research.analysis_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
		if (!row) throw new ResearchError(404, "Analysis run not found");
		if (!TERMINAL_RUNS.includes(row.state)) {
			await client.query("UPDATE research.analysis_runs SET cancel_requested=true,finished_at=now() WHERE id=$1", [
				runId,
			]);
			await this.db.event(client, runId, "cancelled");
		}
		return { id: runId, state: TERMINAL_RUNS.includes(row.state) ? row.state : "cancelled" };
	}
	abortCancelled(runId: string): void {
		this.controllers.get(runId)?.abort(new Error("Research run cancelled"));
	}
	stop(): void {
		for (const controller of this.controllers.values()) controller.abort(new Error("Research service stopping"));
	}
	async retry(client: PoolClient, runId: string) {
		const row = (await client.query("SELECT * FROM research.analysis_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
		if (!row) throw new ResearchError(404, "Analysis run not found");
		if (!["failed", "cancelled", "needs_review", "deferred", "not_selected"].includes(row.state))
			throw new ResearchError(409, "This run cannot be retried");
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [row.base_key]);
		const generation = (
			await client.query("SELECT max(generation)+1 AS n FROM research.analysis_runs WHERE base_key=$1", [
				row.base_key,
			])
		).rows[0].n;
		const id = randomUUID();
		const result = await client.query(
			"INSERT INTO research.analysis_runs(id,library_id,batch_id,asset_id,topic_id,topic_snapshot,target,baseline,base_key,generation,workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
			[
				id,
				row.library_id,
				row.batch_id,
				row.asset_id,
				row.topic_id,
				JSON.stringify(row.topic_snapshot),
				JSON.stringify(row.target),
				JSON.stringify(row.baseline),
				row.base_key,
				generation,
				`research:${id}`,
			],
		);
		await this.db.event(client, id, "planned", { manual: true, retryOf: runId });
		return result.rows[0];
	}
	async resolveIdentity(
		client: PoolClient,
		paperId: string,
		body: { doi?: string; arxivId?: string; title?: string; assignToPaperId?: string },
	) {
		const row = (await client.query("SELECT * FROM research.papers WHERE id=$1 FOR UPDATE", [paperId])).rows[0];
		if (!row) throw new ResearchError(404, "Paper not found");
		if (body.assignToPaperId) {
			if (row.identity_state !== "provisional")
				throw new ResearchError(409, "Only a provisional paper can be assigned to an existing work");
			const target = (
				await client.query("SELECT * FROM research.papers WHERE id=$1 AND library_id=$2", [
					body.assignToPaperId,
					row.library_id,
				])
			).rows[0];
			if (!target || target.id === paperId) throw new ResearchError(404, "Target work not found");
			const used = await client.query(
				"SELECT 1 FROM research.analysis_runs r JOIN research.paper_assets a ON r.asset_id=a.id WHERE a.paper_id=$1 LIMIT 1",
				[paperId],
			);
			if (used.rowCount)
				throw new ResearchError(
					409,
					"This paper has analysis history; automatic identity merging is not supported",
				);
			await client.query("UPDATE research.paper_assets SET paper_id=$2 WHERE paper_id=$1", [paperId, target.id]);
			await client.query("DELETE FROM research.papers WHERE id=$1", [paperId]);
			return target;
		}
		let identity: ReturnType<typeof normalizeIdentity>;
		try {
			identity = normalizeIdentity(body.doi, body.arxivId);
		} catch (error) {
			throw new ResearchError(400, errorText(error));
		}
		return (
			await client.query(
				"UPDATE research.papers SET doi=COALESCE($2,doi),arxiv_id=COALESCE($3,arxiv_id),title=COALESCE($4,title),identity_state=CASE WHEN $2::text IS NOT NULL OR $3::text IS NOT NULL THEN 'identified' ELSE identity_state END WHERE id=$1 RETURNING *",
				[paperId, identity.doi, identity.arxivId, body.title],
			)
		).rows[0];
	}
}
