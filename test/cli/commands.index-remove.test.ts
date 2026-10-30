import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIndex } from "../../src/cli/commands/index.ts";
import type { CommandContext } from "../../src/cli/commands/types.ts";
import { loadMirrorIndex, saveMirrorIndex } from "../../src/mirror/index-store.ts";

/**
 * The semantic cleanup is delegated to a refresh, which needs an embedder and a
 * MinSync/local index. Stub the agent so this file tests only what the command
 * itself owns: source resolution, mirror deletion, exclusion persistence, and
 * the refresh call it requests.
 */
const agent = vi.hoisted(() => ({
	calls: [] as { force: boolean; methods?: readonly string[] }[],
}));

vi.mock("../../src/agent/agent.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/agent/agent.ts")>();
	class StubAgent {
		async refresh(force = false, opts?: { methods?: readonly string[] }) {
			agent.calls.push({ force, methods: opts?.methods });
			return {
				scanned: 1,
				written: 0,
				deleted: 1,
				skipped: 0,
				diagnostics: [],
				datasources: [],
				minsync: { ok: true, synced: 0 },
			};
		}
	}
	return { ...actual, AutoRAGAgent: StubAgent };
});

let tmpDir: string;
let previousHome: string | undefined;

beforeEach(() => {
	agent.calls.length = 0;
	tmpDir = mkdtempSync(join(tmpdir(), "autorag-index-remove-"));
	previousHome = process.env.HOME;
	process.env.HOME = join(tmpDir, "home");
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(tmpDir, { recursive: true, force: true });
});

interface Captured {
	readonly stdout: string[];
	readonly stderr: string[];
	readonly ctx: CommandContext;
}

function makeCtx(opts: {
	positionals?: string[];
	flags?: Record<string, string | boolean | undefined>;
	json?: boolean;
	promptYesNo?: (question: string) => Promise<boolean>;
}): Captured {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const ctx: CommandContext = {
		positionals: opts.positionals ?? [],
		flags: opts.flags ?? {},
		json: opts.json ?? false,
		debug: false,
		cwd: tmpDir,
		stdout: (line: string) => {
			stdout.push(line);
		},
		stderr: (line: string) => {
			stderr.push(line);
		},
		promptYesNo: opts.promptYesNo,
	};
	return { stdout, stderr, ctx };
}

interface Fixture {
	readonly workspace: string;
	readonly sourcePath: string;
	readonly outputPath: string;
	readonly configPath: string;
}

/** One indexed source: a real source file, its parsed `.md` mirror, and a config. */
function seedIndexedSource(): Fixture {
	const workspace = join(tmpDir, "workspace");
	const docs = join(tmpDir, "docs");
	mkdirSync(join(workspace, ".autorag", "parsed", "files"), { recursive: true });
	mkdirSync(docs, { recursive: true });

	const body = "# Refunds\n\nDirector approval is required before payout.\n";
	const sourcePath = join(docs, "policy.md");
	writeFileSync(sourcePath, body);
	const outputPath = join(workspace, ".autorag", "parsed", "files", "policy.md.md");
	writeFileSync(outputPath, body);

	saveMirrorIndex(workspace, {
		version: 1,
		entries: {
			"/docs/policy.md": {
				virtualPath: "/docs/policy.md",
				sourcePath,
				outputPath,
				parserName: "plain-text",
				sourceMtimeNs: 1,
				sourceSizeBytes: body.length,
				updatedAt: "1",
			},
		},
	});

	const configPath = join(workspace, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			searchPaths: [docs],
			workspacePath: workspace,
			memoryPath: join(workspace, "memory.json"),
			excludeExactDuplicates: false,
			jikji: false,
			everything: false,
			fsearch: false,
			minSync: { autoInstall: false },
		}),
	);
	return { workspace, sourcePath, outputPath, configPath };
}

function readExcludePaths(configPath: string): unknown {
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	return raw.excludePaths;
}

describe("runIndex remove", () => {
	it("returns exit 2 with usage when the source argument is missing", async () => {
		const { ctx, stderr } = makeCtx({ positionals: ["remove"], flags: { yes: true } });
		expect(await runIndex(ctx)).toBe(2);
		expect(stderr.join("\n")).toContain("Usage: autorag index remove");
	});

	it("returns exit 1 when no indexed source matches the argument", async () => {
		const fx = seedIndexedSource();
		const { ctx, stderr } = makeCtx({
			positionals: ["remove", "/docs/missing.md"],
			flags: { yes: true, config: fx.configPath },
		});

		expect(await runIndex(ctx)).toBe(1);
		expect(stderr.join("\n")).toContain("No indexed source matches");
		// Nothing was deleted and no configuration changed.
		expect(existsSync(fx.outputPath)).toBe(true);
		expect(readExcludePaths(fx.configPath)).toBeUndefined();
		expect(agent.calls).toHaveLength(0);
	});

	it("requires --yes or an interactive terminal and changes nothing when declined", async () => {
		const fx = seedIndexedSource();
		const { ctx, stderr } = makeCtx({
			positionals: ["remove", "/docs/policy.md"],
			flags: { config: fx.configPath },
		});

		expect(await runIndex(ctx)).toBe(2);
		expect(stderr.join("\n")).toContain("requires --yes");
		expect(existsSync(fx.outputPath)).toBe(true);
		expect(loadMirrorIndex(fx.workspace).entries["/docs/policy.md"]).toBeDefined();
		expect(readExcludePaths(fx.configPath)).toBeUndefined();
	});

	it("returns exit 2 and changes nothing when the confirmation prompt is declined", async () => {
		const fx = seedIndexedSource();
		const { ctx, stderr } = makeCtx({
			positionals: ["remove", "/docs/policy.md"],
			flags: { config: fx.configPath },
			promptYesNo: async () => false,
		});

		expect(await runIndex(ctx)).toBe(2);
		expect(stderr.join("\n")).toContain("declined");
		expect(existsSync(fx.outputPath)).toBe(true);
		expect(loadMirrorIndex(fx.workspace).entries["/docs/policy.md"]).toBeDefined();
	});

	it("deletes the parsed mirror, excludes the source, and requests a parsed+minsync refresh", async () => {
		const fx = seedIndexedSource();
		const { ctx, stdout, stderr } = makeCtx({
			positionals: ["remove", "/docs/policy.md"],
			flags: { yes: true, config: fx.configPath },
			json: true,
		});

		expect(await runIndex(ctx), stderr.join("\n")).toBe(0);

		// The parsed mirror entry and its `.md` mirror are gone.
		expect(loadMirrorIndex(fx.workspace).entries["/docs/policy.md"]).toBeUndefined();
		expect(existsSync(fx.outputPath)).toBe(false);
		// The user's source file is never deleted.
		expect(existsSync(fx.sourcePath)).toBe(true);
		// The exclusion is persisted so a later refresh will not re-index it.
		expect(readExcludePaths(fx.configPath)).toEqual([fx.sourcePath]);
		// Semantic cleanup runs through a scoped refresh.
		expect(agent.calls).toHaveLength(1);
		expect(agent.calls[0]).toMatchObject({ force: false, methods: ["parsed", "minsync"] });

		const result = JSON.parse(stdout[0]);
		expect(result.ok).toBe(true);
		expect(result.action).toBe("remove");
		expect(result.source).toBe("/docs/policy.md");
		expect(result.excluded).toBe(true);
		expect(result.removed).toBeUndefined();
	});

	it("accepts the absolute source path as the target", async () => {
		const fx = seedIndexedSource();
		const { ctx } = makeCtx({
			positionals: ["remove", fx.sourcePath],
			flags: { yes: true, config: fx.configPath },
			json: true,
		});

		expect(await runIndex(ctx)).toBe(0);
		expect(loadMirrorIndex(fx.workspace).entries["/docs/policy.md"]).toBeUndefined();
	});

	it("does not duplicate an exclusion the source already had", async () => {
		const fx = seedIndexedSource();
		writeFileSync(
			fx.configPath,
			JSON.stringify({
				searchPaths: [join(tmpDir, "docs")],
				workspacePath: fx.workspace,
				memoryPath: join(fx.workspace, "memory.json"),
				excludeExactDuplicates: false,
				jikji: false,
				everything: false,
				fsearch: false,
				minSync: { autoInstall: false },
				excludePaths: [fx.sourcePath],
			}),
		);
		const { ctx, stdout } = makeCtx({
			positionals: ["remove", "/docs/policy.md"],
			flags: { yes: true, config: fx.configPath },
			json: true,
		});

		expect(await runIndex(ctx)).toBe(0);
		expect(readExcludePaths(fx.configPath)).toEqual([fx.sourcePath]);
		expect(JSON.parse(stdout[0]).excluded).toBe(false);
	});

	it("returns exit 1 once the source is no longer indexed", async () => {
		const fx = seedIndexedSource();
		const first = makeCtx({
			positionals: ["remove", "/docs/policy.md"],
			flags: { yes: true, config: fx.configPath },
			json: true,
		});
		expect(await runIndex(first.ctx)).toBe(0);

		const second = makeCtx({
			positionals: ["remove", "/docs/policy.md"],
			flags: { yes: true, config: fx.configPath },
			json: true,
		});
		expect(await runIndex(second.ctx)).toBe(1);
	});
});
