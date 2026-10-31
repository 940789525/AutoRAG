import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRefresh } from "../../src/cli/commands/refresh.ts";
import { runStatus } from "../../src/cli/commands/status.ts";
import type { CommandContext } from "../../src/cli/commands/types.ts";
import type { CliConfig } from "../../src/cli/config.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

const embeddingControl = vi.hoisted(() => ({ beforeEmbed: undefined as (() => Promise<void>) | undefined }));
vi.mock("../../src/cli/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/cli/config.ts")>();
	return {
		...actual,
		buildAgentOptions(config: CliConfig) {
			const fixture = nativeIndexFixture();
			return {
				...actual.buildAgentOptions(config),
				...fixture,
				embedder: {
					...fixture.embedder!,
					embed: async (...args: Parameters<NonNullable<typeof fixture.embedder>["embed"]>) => {
						await embeddingControl.beforeEmbed?.();
						return fixture.embedder!.embed(...args);
					},
				},
			};
		},
	};
});

let root: string;
let docs: string;
let previousHome: string | undefined;
let previousPath: string | undefined;

function pathWithoutMinsync(pathEnv = process.env.PATH ?? ""): string {
	const execName = process.platform === "win32" ? "minsync.exe" : "minsync";
	return pathEnv
		.split(delimiter)
		.filter((dir) => dir.length > 0 && !existsSync(join(dir, execName)))
		.join(delimiter);
}

beforeEach(() => {
	embeddingControl.beforeEmbed = undefined;
	root = mkdtempSync(join(tmpdir(), "autorag-cli-refresh-"));
	previousHome = process.env.HOME;
	previousPath = process.env.PATH;
	process.env.HOME = join(root, "home");
	// The suite-wide setup file puts an inert `minsync` on PATH, so the default
	// fixture resolves one; the absent-binary test strips it explicitly.
	process.env.PATH = previousPath;
	docs = join(root, "docs");
	mkdirSync(docs, { recursive: true });
	writeFileSync(join(docs, "alpha.md"), "# Alpha\n\nAlpha document body content.\n");
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	rmSync(root, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		positionals: [],
		flags: {},
		json: true,
		debug: false,
		cwd: root,
		stdout: () => {},
		stderr: () => {},
		...overrides,
	};
}

function writeConfig(minSync: unknown = { autoInstall: false }): void {
	const config: Record<string, unknown> = {
		searchPaths: ["docs"],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		jikji: false,
		everything: false,
		fsearch: false,
	};
	if (minSync !== undefined) config.minSync = minSync;
	const configDir = join(process.env.HOME as string, ".autorag");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

describe("runStatus exit codes", () => {
	it("returns exit 2 when --config points to a missing file", async () => {
		const err: string[] = [];
		const code = await runStatus(
			makeCtx({
				flags: { config: join(root, "nonexistent-config.json") },
				stderr: (line) => err.push(line),
			}),
		);
		expect(code).toBe(2);
		expect(err.join("\n")).toContain("Config file not found");
	});
});

describe("runRefresh + runStatus (cli)", () => {
	it("refresh then status emits JSON with counts and no leaked paths", async () => {
		writeConfig();

		const refreshOut: string[] = [];
		const refreshCode = await runRefresh(makeCtx({ stdout: (line) => refreshOut.push(line) }));
		expect(refreshCode).toBe(0);
		expect(refreshOut).toHaveLength(1);

		const refreshBlob = refreshOut[0];
		// Path opacity: no absolute index path, no temp root, no bm25 subdir literal.
		expect(refreshBlob).not.toContain("indexPath");
		expect(JSON.parse(refreshBlob).localIndex.report.reportPath).toContain(join(root, ".autorag", "local-index"));
		expect(refreshBlob).not.toContain(join(".autorag", "bm25"));

		const statusOut: string[] = [];
		const statusCode = await runStatus(makeCtx({ stdout: (line) => statusOut.push(line) }));
		expect(statusCode).toBe(0);
		expect(statusOut).toHaveLength(1);

		const statusBlob = statusOut[0];
		expect(statusBlob).not.toContain("indexPath");
		expect(statusBlob).not.toContain(root);
		expect(statusBlob).not.toContain(join(".autorag", "bm25"));

		const status = JSON.parse(statusBlob);
		// `status` runs in a fresh agent instance (a separate CLI process in real
		// use), so in-memory `state`/`counts` are not carried across invocations.
		// Freshness is: it comes from the readiness marker the refresh wrote plus the
		// stat-only scan, so a new invocation after a refresh reports the corpus as
		// current and finds no source newer than the recorded mirror index.
		expect(typeof status.state).toBe("string");
		expect(Array.isArray(status.diagnostics)).toBe(true);
		expect(status.stale).toBe(false);
		const staleDiagnostics = (status.diagnostics as { code: string }[]).filter((d) => d.code === "stale-index");
		expect(staleDiagnostics).toHaveLength(0);
		expect(status.components).toBeDefined();
	});

	it("refreshes without the MinSync CLI when embedding is available", async () => {
		writeConfig({ autoInstall: false });
		process.env.PATH = pathWithoutMinsync(previousPath);
		const out: string[] = [];
		expect(await runRefresh(makeCtx({ flags: { method: "local" }, stdout: (line) => out.push(line) }))).toBe(0);
		expect(JSON.parse(out[0]).localIndex.report.backend).toBe("autorag");
	});

	it("skips unknown datasource entries and reports a non-fatal diagnostic", async () => {
		const configDir = join(process.env.HOME as string, ".autorag");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			`${JSON.stringify(
				{
					searchPaths: ["docs"],
					workspacePath: root,
					memoryPath: join(root, "memory.json"),
					bm25: { forceEngine: "typescript-fallback" },
					minSync: { autoInstall: false },
					everything: false,
					fsearch: false,
					datasources: {
						"discord-nomadamas": {},
						"slack-local": {},
					},
				},
				null,
				2,
			)}\n`,
		);

		const stderr: string[] = [];
		const statusOut: string[] = [];
		const code = await runStatus(
			makeCtx({
				stdout: (line) => statusOut.push(line),
				stderr: (line) => stderr.push(line),
			}),
		);
		expect(code).toBe(0);
		expect(stderr.join("\n")).not.toContain("Unknown datasource skill");
		expect(statusOut).toHaveLength(1);
		const status = JSON.parse(statusOut[0]) as { diagnostics: Array<{ code: string; message: string }> };
		expect(status.diagnostics.some((diagnostic) => diagnostic.code === "unknown-datasource-skill")).toBe(true);
		expect(statusOut[0]).toContain("discord-nomadamas");
		expect(statusOut[0]).toContain("slack-local");
		expect(statusOut[0]).not.toContain(root);
	});

	it("reports idle and stale before any refresh has run", async () => {
		writeConfig();

		const statusOut: string[] = [];
		const code = await runStatus(makeCtx({ stdout: (line) => statusOut.push(line) }));
		expect(code).toBe(0);

		const status = JSON.parse(statusOut[0]);
		expect(status.state).toBe("idle");
		expect(status.stale).toBe(true);
		expect(status.counts).toBeUndefined();
	});

	it("reports the active native indexing stage from a separate status invocation", async () => {
		writeConfig();
		let began!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		embeddingControl.beforeEmbed = async () => {
			began();
			await held;
		};
		const refresh = runRefresh(makeCtx({ flags: { method: "local" } }));
		try {
			await started;
			const out: string[] = [];
			expect(await runStatus(makeCtx({ stdout: (line) => out.push(line) }))).toBe(0);
			const status = JSON.parse(out[0]);
			expect(status.inFlight).toBe(true);
			expect(status.progress.indexing.phase).toBeDefined();
		} finally {
			release();
			await refresh;
		}
	});

	it("refreshes only MinSync when --method minsync is given", async () => {
		writeConfig();

		const out: string[] = [];
		const code = await runRefresh(makeCtx({ flags: { method: "minsync" }, stdout: (line) => out.push(line) }));
		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		const blob = out[0];
		expect(blob).not.toContain("indexPath");
		expect(JSON.parse(blob).localIndex.report.backend).toBe("autorag");
		const parsed = JSON.parse(blob);
		expect(parsed.counts).toBeDefined();
		expect(parsed.localIndex).toBeDefined();
		expect(typeof parsed.localIndex.ok).toBe("boolean");
	});

	it("returns nonzero and the underlying embedding failure in the refresh JSON", async () => {
		writeConfig();
		embeddingControl.beforeEmbed = async () => {
			throw new Error(`provider failed at ${root}`);
		};
		const out: string[] = [];
		expect(await runRefresh(makeCtx({ flags: { method: "local" }, stdout: (line) => out.push(line) }))).toBe(1);
		const result = JSON.parse(out[0]);
		expect(result.localIndex.ok).toBe(false);
		expect(result.localIndex.reason).toContain(`provider failed at ${root}`);
		expect(result.localIndex.report.failures.length).toBeGreaterThan(0);
	});

	it("refreshes with all methods when --method all is given", async () => {
		writeConfig();

		const out: string[] = [];
		const code = await runRefresh(makeCtx({ flags: { method: "all" }, stdout: (line) => out.push(line) }));
		expect(code).toBe(0);
		const parsed = JSON.parse(out[0]);
		expect(parsed.counts).toBeDefined();
	});

	it("rejects an unknown --method value", async () => {
		writeConfig();

		const err: string[] = [];
		const code = await runRefresh(makeCtx({ flags: { method: "bogus" }, stderr: (line) => err.push(line) }));
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("Unknown --method value");
	});
});
