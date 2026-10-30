import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { RESEARCH_SCHEMA } from "./schema.ts";
import { ResearchError } from "./types.ts";

export function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ResearchDatabase {
	readonly pool: Pool;
	constructor(connectionString: string) {
		this.pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000 });
	}
	async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await fn(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async migrate(): Promise<void> {
		await this.transaction(async (client) => {
			await client.query("SELECT pg_advisory_xact_lock(77261027)");
			await client.query("CREATE SCHEMA IF NOT EXISTS research");
			await client.query(
				"CREATE TABLE IF NOT EXISTS research.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
			);
			const { rows } = await client.query("SELECT version FROM research.migrations ORDER BY version");
			if (rows.some((row) => row.version > 1)) throw new Error("Research database is newer than this application");
			if (!rows.length) await client.query(RESEARCH_SCHEMA);
		});
	}
	async idempotent<T>(key: string, route: string, body: unknown, fn: (client: PoolClient) => Promise<T>): Promise<T> {
		return this.transaction(async (client) => {
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				`${route}\0${key}`.replaceAll("\0", ":"),
			]);
			const previous = await client.query(
				"SELECT digest,response FROM research.api_requests WHERE key=$1 AND route=$2 AND created_at>now()-interval '7 days'",
				[key, route],
			);
			if (previous.rows[0]) {
				if (previous.rows[0].digest !== digest(body))
					throw new ResearchError(409, "Idempotency-Key was already used with a different request");
				return previous.rows[0].response as T;
			}
			const response = await fn(client);
			await client.query(
				"INSERT INTO research.api_requests(key,route,digest,response) VALUES($1,$2,$3,$4) ON CONFLICT(key,route) DO UPDATE SET digest=$3,response=$4,created_at=now()",
				[key, route, digest(body), JSON.stringify(response)],
			);
			return response;
		});
	}
	async event(client: PoolClient, runId: string, state: string, payload: unknown = {}): Promise<void> {
		const result = await client.query(
			"UPDATE research.analysis_runs SET state=$2,last_event_seq=last_event_seq+1 WHERE id=$1 RETURNING last_event_seq",
			[runId, state],
		);
		if (!result.rows[0]) throw new ResearchError(404, "Analysis run not found");
		await client.query("INSERT INTO research.run_events(run_id,seq,type,payload) VALUES($1,$2,$3,$4)", [
			runId,
			result.rows[0].last_event_seq,
			state,
			JSON.stringify(payload),
		]);
		await client.query(
			"DELETE FROM research.run_events WHERE run_id=$1 AND seq<$2-1000 AND type IN ('planned','screening','reading','validating')",
			[runId, result.rows[0].last_event_seq],
		);
	}
	close(): Promise<void> {
		return this.pool.end();
	}
}
