import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// The configured development DB is used only to create/drop a separate, randomly named test DB.
const base = process.env.AUTORAG_RESEARCH_DATABASE_URL;
assert(base, "Set AUTORAG_RESEARCH_DATABASE_URL to the development database URL");
const url = new URL(base);
if (process.env.AUTORAG_RESEARCH_DATABASE_PASSWORD_FILE) {
	url.password = (await readFile(process.env.AUTORAG_RESEARCH_DATABASE_PASSWORD_FILE, "utf8")).trim();
}
const admin = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
const name = `research_tui_${randomBytes(6).toString("hex")}_test`;
const root = await mkdtemp(join(tmpdir(), "autorag-research-test-"));
let created = false;
try {
	await admin.query(`CREATE DATABASE "${name}"`);
	created = true;
	url.pathname = `/${name}`;
	const child = spawn(
		process.execPath,
		[
			"node_modules/vitest/vitest.mjs",
			"run",
			"test/research",
			"test/agent/tui-mode.test.ts",
			"test/agent/embedding-controls.test.ts",
			"test/agent/pi-session.test.ts",
			"test/indexing/lance-store.test.ts",
			"test/indexing/pipeline.test.ts",
			"test/profiles/agent-factory.test.ts",
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				AUTORAG_RESEARCH_TEST_DATABASE_URL: url.href,
				AUTORAG_HOME: join(root, "home"),
				AUTORAG_CONFIG: join(root, "config.json"),
			},
		},
	);
	const code = await new Promise((resolve, reject) => {
		child.once("exit", resolve);
		child.once("error", reject);
	});
	process.exitCode = code === 0 ? 0 : 1;
} finally {
	if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
	await admin.end();
	await rm(root, { recursive: true, force: true });
}
