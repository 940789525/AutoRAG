import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIndex } from "../../src/cli/commands/index.ts";
import type { CommandContext } from "../../src/cli/commands/types.ts";
import type { CliConfig } from "../../src/cli/config.ts";
import { saveMirrorIndex } from "../../src/mirror/index-store.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

const embeddingControl = vi.hoisted(() => ({ beforeEmbed: undefined as (() => Promise<void>) | undefined }));

vi.mock("../../src/cli/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/cli/config.ts")>();
	return {
		...actual,
		buildAgentOptions: (config: CliConfig) => {
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

let tmpDir: string;
let previousHome: string | undefined;

beforeEach(() => {
	embeddingControl.beforeEmbed = undefined;
	tmpDir = mkdtempSync(join(tmpdir(), "autorag-cli-index-"));
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
	cwd?: string;
	promptYesNo?: (question: string) => Promise<boolean>;
}): Captured {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const ctx: CommandContext = {
		positionals: opts.positionals ?? [],
		flags: opts.flags ?? {},
		json: opts.json ?? false,
		debug: false,
		cwd: opts.cwd ?? tmpDir,
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

interface WorkspaceFixture {
	readonly workspace: string;
	readonly parsed: string;
	readonly minsync: string;
	readonly bin: string;
	readonly datasources: string;
	readonly memoryFile: string;
	readonly outsideFile: string;
	readonly siblingDir: string;
	readonly siblingFile: string;
}

function seedWorkspace(): WorkspaceFixture {
	const workspace = join(tmpDir, "workspace");
	const autorag = join(workspace, ".autorag");
	mkdirSync(autorag, { recursive: true });

	const parsed = join(autorag, "parsed");
	const minsync = join(autorag, "local-index");
	mkdirSync(join(autorag, "minsync"), { recursive: true });
	writeFileSync(join(autorag, "minsync", "legacy.bin"), "keep legacy data");
	const bin = join(autorag, "bin");
	const datasources = join(autorag, "datasources");

	for (const dir of [parsed, minsync, bin, datasources]) {
		mkdirSync(dir, { recursive: true });
	}
	// Each reset target contains a file so the directory is non-empty.
	writeFileSync(join(parsed, "index.json"), "{}");
	writeFileSync(join(minsync, "data.bin"), "bytes");
	writeFileSync(join(bin, "runner"), "binary");
	writeFileSync(join(datasources, "source.json"), "{}");

	const memoryFile = join(autorag, "memory.json");
	writeFileSync(
		memoryFile,
		'{"version":5,"curatedResults":[],"evidenceChunks":[],"judgedEvidence":[],"insights":[],"pendingInsightEntries":[],"warnings":[]}',
	);

	// Files outside .autorag that must never be touched by reset.
	const outsideFile = join(workspace, "important.txt");
	writeFileSync(outsideFile, "keep me");
	const siblingDir = join(tmpDir, "sibling-outside");
	mkdirSync(siblingDir, { recursive: true });
	const siblingFile = join(siblingDir, "keep.txt");
	writeFileSync(siblingFile, "sibling keep");

	return { workspace, parsed, minsync, bin, datasources, memoryFile, outsideFile, siblingDir, siblingFile };
}

describe("runIndex", () => {
	it("streams rebuild progress before completion and keeps JSON stdout separate", async () => {
		const fx = seedWorkspace();
		const docs = join(tmpDir, "progress-docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "note.txt"), "A synthetic document for progress verification.");
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
		const { ctx, stdout, stderr } = makeCtx({
			positionals: ["rebuild"],
			flags: { yes: true, method: "local", "search-paths": docs },
			cwd: fx.workspace,
			json: true,
		});
		const pending = runIndex(ctx);
		try {
			await started;
			expect(stdout).toHaveLength(0);
			expect(stderr.join("\n")).toContain("向量化：进行中");
			expect(stderr.join("\n")).toContain("note.txt");
		} finally {
			release();
			await pending;
		}
		expect(stdout).toHaveLength(1);
		const result = JSON.parse(stdout[0]);
		expect(result.rebuilt.localIndex.report.embedded).toBeGreaterThan(0);
		expect(result.removed).toEqual(["local"]);
		expect(stdout[0]).not.toMatch(/minsync/i);
		expect(stderr.join("\n")).not.toMatch(/minsync/i);
	});

	it("returns exit 2 for an unknown subcommand", async () => {
		const { ctx, stderr } = makeCtx({ positionals: ["frobnicate"], flags: { yes: true } });
		const code = await runIndex(ctx);
		expect(code).toBe(2);
		expect(stderr.join("\n")).toContain("Usage");
	});

	it("returns exit 2 when no subcommand is given", async () => {
		const { ctx, stderr } = makeCtx({ positionals: [], flags: { yes: true } });
		const code = await runIndex(ctx);
		expect(code).toBe(2);
		expect(stderr.join("\n")).toContain("Usage");
	});

	it("reset --yes removes parsed/minsync and preserves bin/datasources/memory", async () => {
		const fx = seedWorkspace();
		const { ctx, stdout } = makeCtx({
			positionals: ["reset"],
			flags: { yes: true },
			cwd: fx.workspace,
			json: true,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(0);

		expect(existsSync(fx.parsed)).toBe(false);
		expect(existsSync(fx.minsync)).toBe(false);
		expect(existsSync(join(fx.workspace, ".autorag", "minsync", "legacy.bin"))).toBe(true);

		expect(existsSync(fx.bin)).toBe(true);
		expect(existsSync(fx.datasources)).toBe(true);
		expect(existsSync(fx.memoryFile)).toBe(true);

		const parsed = JSON.parse(stdout[0]);
		expect(parsed.ok).toBe(true);
		expect(parsed.action).toBe("reset");
		expect(parsed.removed).toEqual(["parsed", "local"]);
	});

	it("declined reset returns exit 2 and removes nothing", async () => {
		const fx = seedWorkspace();
		const { ctx, stderr } = makeCtx({
			positionals: ["reset"],
			flags: {},
			cwd: fx.workspace,
			promptYesNo: async () => false,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(2);
		expect(stderr.join("\n")).toContain("declined");

		// Nothing removed.
		expect(existsSync(fx.parsed)).toBe(true);
		expect(existsSync(fx.minsync)).toBe(true);
		expect(existsSync(fx.bin)).toBe(true);
		expect(existsSync(fx.datasources)).toBe(true);
	});

	it("reset without --yes and without promptYesNo returns exit 2 and removes nothing", async () => {
		const fx = seedWorkspace();
		const { ctx } = makeCtx({
			positionals: ["reset"],
			flags: {},
			cwd: fx.workspace,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(2);
		expect(existsSync(fx.parsed)).toBe(true);
		expect(existsSync(fx.minsync)).toBe(true);
	});

	it("path-escape guard: reset never deletes files outside .autorag", async () => {
		const fx = seedWorkspace();
		const { ctx } = makeCtx({
			positionals: ["reset"],
			flags: { yes: true },
			cwd: fx.workspace,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(0);

		// Files outside .autorag (workspace root and a tmp sibling) survive.
		expect(existsSync(fx.outsideFile)).toBe(true);
		expect(existsSync(fx.siblingFile)).toBe(true);
		expect(existsSync(fx.siblingDir)).toBe(true);
	});

	it("refuses to reset when .autorag is a symlink pointing outside the workspace", async () => {
		// Attacker/mis-config: .autorag is a symlink to a dir outside the workspace.
		// rmSync would follow it and delete the target's contents; the guard must refuse.
		const workspace = join(tmpDir, "ws");
		mkdirSync(workspace, { recursive: true });
		const escapeTarget = join(tmpDir, "escape-target");
		mkdirSync(join(escapeTarget, "parsed"), { recursive: true });
		const sentinel = join(escapeTarget, "parsed", "SENTINEL.txt");
		writeFileSync(sentinel, "must survive");
		symlinkSync(escapeTarget, join(workspace, ".autorag"));

		const { ctx, stderr } = makeCtx({
			positionals: ["reset"],
			flags: { yes: true },
			cwd: workspace,
		});
		const code = await runIndex(ctx);

		expect(code).toBe(1);
		expect(stderr.join("\n")).toContain("symlink");
		// The symlink target's contents are untouched.
		expect(existsSync(sentinel)).toBe(true);
	});

	it("rebuild --yes removes then re-creates the parsed index via refresh", async () => {
		const fx = seedWorkspace();
		mkdirSync(join(tmpDir, "home", ".autorag"), { recursive: true });
		writeFileSync(
			join(tmpDir, "home", ".autorag", "config.json"),
			JSON.stringify({ jikji: false, everything: false, fsearch: false, minSync: { autoInstall: false } }),
		);
		// Provide a parseable source file so refresh rebuilds the parsed mirror.
		const docs = join(fx.workspace, "docs");
		mkdirSync(docs, { recursive: true });
		writeFileSync(join(docs, "note.txt"), "Alpha content for rebuild\n");

		const { ctx, stdout } = makeCtx({
			positionals: ["rebuild"],
			flags: { yes: true, "search-paths": docs },
			cwd: fx.workspace,
			json: true,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(0);

		// Reset removed the stale targets; refresh re-created at least the parsed mirror.
		expect(existsSync(fx.parsed)).toBe(true);
		// bin/datasources/memory still intact.
		expect(existsSync(fx.bin)).toBe(true);
		expect(existsSync(fx.datasources)).toBe(true);
		expect(existsSync(fx.memoryFile)).toBe(true);

		const parsed = JSON.parse(stdout[0]);
		expect(parsed.ok).toBe(true);
		expect(parsed.action).toBe("rebuild");
		expect(parsed.removed).toEqual(["parsed", "local"]);
		expect(parsed.rebuilt).toBeDefined();
	});
});
describe("runIndex --method scoped reset", () => {
	it("reset --method minsync removes only the minsync index", async () => {
		const fx = seedWorkspace();
		const { ctx, stdout } = makeCtx({
			positionals: ["reset"],
			flags: { yes: true, method: "minsync" },
			cwd: fx.workspace,
			json: true,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(0);

		expect(existsSync(fx.minsync)).toBe(false);
		expect(existsSync(join(fx.workspace, ".autorag", "minsync", "legacy.bin"))).toBe(true);
		expect(existsSync(fx.parsed)).toBe(true);

		const parsed = JSON.parse(stdout[0]);
		expect(parsed.removed).toEqual(["local"]);
	});

	it("reset --method all removes the parsed mirror and shared MinSync index", async () => {
		const fx = seedWorkspace();
		const { ctx, stdout } = makeCtx({
			positionals: ["reset"],
			flags: { yes: true, method: "all" },
			cwd: fx.workspace,
			json: true,
		});

		const code = await runIndex(ctx);
		expect(code).toBe(0);

		expect(existsSync(fx.parsed)).toBe(false);
		expect(existsSync(fx.minsync)).toBe(false);
		expect(existsSync(join(fx.workspace, ".autorag", "minsync", "legacy.bin"))).toBe(true);

		const parsed = JSON.parse(stdout[0]);
		expect(parsed.removed).toEqual(["parsed", "local"]);
	});
});

it("inspects actual chunk inputs with a workspace-relative tokenizer and passage prefix", async () => {
	const workspace = join(tmpDir, "inspect-workspace");
	const assets = join(workspace, "assets");
	mkdirSync(assets, { recursive: true });
	writeFileSync(
		join(assets, "tokenizer.json"),
		JSON.stringify({
			version: "1.0",
			truncation: null,
			padding: null,
			added_tokens: [],
			normalizer: null,
			pre_tokenizer: { type: "WhitespaceSplit" },
			post_processor: null,
			decoder: null,
			model: { type: "WordLevel", vocab: { "[UNK]": 0 }, unk_token: "[UNK]" },
		}),
	);
	writeFileSync(join(assets, "tokenizer_config.json"), JSON.stringify({ unk_token: "[UNK]" }));
	const source = join(workspace, "policy.md");
	const text = "# Refunds\n\nDirector approval is required before payout.";
	writeFileSync(source, text);
	saveMirrorIndex(workspace, {
		version: 1,
		entries: {
			"/docs/policy.md": {
				virtualPath: "/docs/policy.md",
				sourcePath: source,
				outputPath: source,
				parserName: "fixture",
				sourceMtimeNs: 0,
				sourceSizeBytes: text.length,
				updatedAt: "1",
			},
		},
	});
	const config = join(workspace, "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			workspacePath: workspace,
			searchPaths: [workspace],
			localIndex: { tokenizerPath: "assets" },
			minSync: { embedder: { passagePrefix: "passage: " } },
		}),
	);
	const { ctx, stdout, stderr } = makeCtx({
		positionals: ["inspect", "/docs/policy.md"],
		flags: { config },
		json: true,
	});
	expect(await runIndex(ctx), stderr.join("\n")).toBe(0);
	const result = JSON.parse(stdout[0]);
	expect(result.virtualPath).toBe("/docs/policy.md");
	expect(result.chunks.length).toBeGreaterThan(0);
	for (const chunk of result.chunks) {
		expect(chunk.embeddingInput).toBe(`passage: ${chunk.embeddingText}`);
		expect(chunk.inputTokens).toBeGreaterThan(0);
		expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
	}
});
