import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Process-wide and cross-process exclusion without a long-running database transaction. */
export function acquireIndexLease(directory: string): () => void {
	mkdirSync(directory, { recursive: true });
	const db = new DatabaseSync(join(directory, "writer.sqlite"));
	const token = randomUUID();
	try {
		db.exec(
			"PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)",
		);
		db.exec("BEGIN IMMEDIATE");
		const owner = db.prepare("SELECT pid FROM writer WHERE id=1").get() as { pid: number } | undefined;
		if (owner) {
			let alive = true;
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
			}
			if (alive) throw new Error(`another AutoRAG index writer is active (pid ${owner.pid}, ${directory})`);
		}
		db.prepare("INSERT OR REPLACE INTO writer VALUES (1,?,?)").run(process.pid, token);
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
