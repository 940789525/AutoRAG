import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexRow, IndexStore } from "./types.ts";

/** SQLite is a recovery journal, not a second vector database. Replaying an unacknowledged replace is safe. */
export class IndexJournal {
	private readonly db: DatabaseSync;
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true });
		this.db = new DatabaseSync(join(directory, "journal.sqlite"));
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
	}
	unchanged(id: string, fingerprint: string): boolean {
		return (
			(this.db.prepare("SELECT fingerprint FROM sources WHERE id=?").get(id) as { fingerprint: string } | undefined)
				?.fingerprint === fingerprint
		);
	}
	sources(): string[] {
		return this.db
			.prepare("SELECT id FROM sources")
			.all()
			.map((row) => String(row.id));
	}
	hasPending(): boolean {
		return this.db.prepare("SELECT 1 FROM pending LIMIT 1").get() !== undefined;
	}
	async recover(store: IndexStore): Promise<number> {
		const rows = this.db.prepare("SELECT id,payload FROM pending").all();
		for (const row of rows) {
			await this.commitPayload(store, String(row.id), String(row.payload));
		}
		return rows.length;
	}
	async replace(
		store: IndexStore,
		documents: readonly { id: string; fingerprint: string | null }[],
		rows: readonly IndexRow[],
	): Promise<void> {
		const id = randomUUID();
		const payload = join(this.directory, `${id}.pending.json`);
		// Payload reaches disk before its journal entry; an orphan payload is harmless after a crash.
		writeFileSync(payload, JSON.stringify({ documents, rows }), { flush: true });
		this.db.prepare("INSERT INTO pending(id,payload) VALUES (?,?)").run(id, payload);
		await this.commitPayload(store, id, payload);
	}
	private async commitPayload(store: IndexStore, id: string, payload: string): Promise<void> {
		const value = JSON.parse(readFileSync(payload, "utf8")) as {
			documents: { id: string; fingerprint: string | null }[];
			rows: IndexRow[];
		};
		await store.replace(
			value.documents.map((document) => document.id),
			value.rows,
		);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const document of value.documents) {
				if (document.fingerprint === null) this.db.prepare("DELETE FROM sources WHERE id=?").run(document.id);
				else
					this.db
						.prepare("INSERT OR REPLACE INTO sources(id,fingerprint) VALUES (?,?)")
						.run(document.id, document.fingerprint);
			}
			this.db.prepare("DELETE FROM pending WHERE id=?").run(id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		rmSync(payload, { force: true });
	}
	close(): void {
		this.db.close();
	}
}
