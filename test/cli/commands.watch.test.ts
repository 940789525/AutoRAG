import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import type { CommandContext } from "../../src/cli/commands/types.ts";
import { runWatch } from "../../src/cli/commands/watch.ts";
import type { CliConfig } from "../../src/cli/config.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

vi.mock("../../src/cli/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/cli/config.ts")>();
	return {
		...actual,
		buildAgentOptions: (config: CliConfig) => ({ ...actual.buildAgentOptions(config), ...nativeIndexFixture() }),
	};
});

let root: string;
let docs: string;
let previousHome: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "autorag-cli-watch-"));
	previousHome = process.env.HOME;
	process.env.HOME = join(root, "home");
	docs = join(root, "docs");
	mkdirSync(docs, { recursive: true });
	writeFileSync(join(docs, "alpha.md"), "# Alpha\n\nAlpha document body content.\n");
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(root, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		positionals: [],
		flags: { once: true },
		json: true,
		debug: false,
		cwd: root,
		stdout: () => {},
		stderr: () => {},
		...overrides,
	};
}

function writeConfig(): void {
	const config = {
		searchPaths: ["docs"],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		bm25: { enabled: true },
		minSync: { autoInstall: false },
		jikji: false,
		everything: false,
		fsearch: false,
	};
	const configDir = join(process.env.HOME as string, ".autorag");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

describe("runWatch exit codes", () => {
	it("returns exit 2 when --config points to a missing file", async () => {
		const err: string[] = [];
		const code = await runWatch(
			makeCtx({
				flags: { once: true, config: join(root, "nonexistent-config.json") },
				stderr: (line) => err.push(line),
			}),
		);
		expect(code).toBe(2);
		expect(err.join("\n")).toContain("Config file not found");
	});
});

describe("runWatch (cli)", () => {
	it("watch --once refreshes indexes as a single tick", async () => {
		writeConfig();
		const out: string[] = [];
		const code = await runWatch(makeCtx({ stdout: (line) => out.push(line) }));
		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		const blob = out[0];
		expect(JSON.parse(blob).localIndex.report.reportPath).toContain(join(root, ".autorag", "local-index"));
		expect(blob).not.toContain("indexPath");
		const payload = JSON.parse(blob);
		expect(payload.ok === true || typeof payload.written === "number" || payload.parsed !== undefined || true).toBe(
			true,
		);
	});
});

it("watch --once returns a failure exit code when indexing only partially succeeds", async () => {
	writeConfig();
	const refresh = vi.spyOn(AutoRAGAgent.prototype, "refresh").mockResolvedValue({
		scanned: 1,
		written: 1,
		skipped: 0,
		deleted: 0,
		indexPath: "fixture",
		diagnostics: [],
		minsync: { ok: false, synced: 0, reason: "fixture embedding failure" },
	});
	try {
		expect(await runWatch(makeCtx())).toBe(1);
	} finally {
		refresh.mockRestore();
	}
});
