import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it("runs the research executable through an installed-style symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "research-entry-"));
	try {
		const executable = join(root, "autorag-research");
		await symlink(fileURLToPath(new URL("../../src/research/index.ts", import.meta.url)), executable);
		const child = spawn(process.execPath, ["--experimental-strip-types", executable], {
			env: { ...process.env, AUTORAG_HOME: join(root, "home"), AUTORAG_CONFIG: join(root, "home", "config.json") },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (data) => {
			output += data;
		});
		child.stderr.on("data", (data) => {
			output += data;
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on("exit", resolve);
			child.on("error", reject);
		});
		assert.equal(code, 1, output);
		assert.match(output, /Usage: autorag-research/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
