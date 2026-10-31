import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ownerAlive, processBirth } from "./process-owner.ts";

/** Process-wide and cross-process exclusion without a long-running database transaction. */
export function acquireIndexLease(directory: string): () => void {
	mkdirSync(directory, { recursive: true });
	const db = new DatabaseSync(join(directory, "writer.sqlite"));
	const token = randomUUID();
	try {
		db.exec(
			"PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)",
		);
		const columns = db.prepare("PRAGMA table_info(writer)").all() as { name: string }[];
		if (!columns.some((column) => column.name === "birth")) {
			try {
				db.exec("ALTER TABLE writer ADD COLUMN birth TEXT");
			} catch (error) {
				if (!String(error).includes("duplicate column")) throw error;
			}
		}
		db.exec("BEGIN IMMEDIATE");
		const owner = db.prepare("SELECT pid, birth FROM writer WHERE id=1").get() as
			| { pid: number; birth?: string }
			| undefined;
		if (owner && ownerAlive(owner.pid, owner.birth))
			throw new Error(`another AutoRAG index writer is active (pid ${owner.pid}, ${directory})`);
		db.prepare("INSERT OR REPLACE INTO writer (id,pid,token,birth) VALUES (1,?,?,?)").run(
			process.pid,
			token,
			processBirth() ?? null,
		);
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* No active transaction after a SQLite acquisition failure. */
		}
		db.close();
		throw error;
	}
	return () => {
		try {
			db.prepare("DELETE FROM writer WHERE token=?").run(token);
		} finally {
			db.close();
		}
	};
}
