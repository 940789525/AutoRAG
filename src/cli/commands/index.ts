import { existsSync, lstatSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AutoRAGAgent, type AutoRAGRefreshResult, type RefreshMethod } from "../../agent/agent.ts";
import { removeRefreshProgress } from "../../agent/refresh-progress.ts";
import { chunkMarkdown } from "../../indexing/chunker.ts";
import { loadIndexTokenizer } from "../../indexing/tokenizer.ts";
import { loadMirrorIndex, type ParsedMirrorEntry, saveMirrorIndex } from "../../mirror/index-store.ts";
import { PARSED_MIRROR_SUBDIR, refreshReadinessPath } from "../../mirror/paths.ts";
import { buildAgentOptions, type CliConfig, readRawConfigObject, resolveConfig, writeConfigObject } from "../config.ts";
import { renderError, renderIndex } from "../output.ts";
import { parseMethodFlag } from "./refresh.ts";
import type { CommandContext } from "./types.ts";

const LOCAL_INDEX_SUBDIR = ".autorag/local-index";
const ALL_RESET_TARGETS = [PARSED_MIRROR_SUBDIR, LOCAL_INDEX_SUBDIR] as const;
const ALL_RESET_TARGET_NAMES = ["parsed", "minsync"] as const;

/**
 * Run the `autorag index` command.
 *
 * - `reset` removes the parsed mirror and local indexes (preserving `bin`,
 *   `datasources`, and the memory file).
 * - `rebuild` resets then re-runs a forced refresh.
 * - `remove <source>` deletes every index entry built from one source file and
 *   frees the space it occupied.
 * - `inspect <source>` prints the exact chunks and embedding inputs of one source.
 *
 * Returns 0 on success, 2 for usage/decline errors, 1 for runtime errors
 * including path-escape guard violations.
 */
export async function runIndex(ctx: CommandContext): Promise<number> {
	const sub = ctx.positionals[0];
	if (sub !== "reset" && sub !== "rebuild" && sub !== "inspect" && sub !== "remove") {
		ctx.stderr(
			renderError(new Error("Usage: autorag index <reset|rebuild|remove|inspect> [SOURCE] [--yes] [--method]"), {
				json: ctx.json,
			}),
		);
		return 2;
	}

	let config: CliConfig;
	try {
		config = resolveConfig({ flags: ctx.flags, cwd: ctx.cwd });
	} catch (error) {
		ctx.stderr(renderError(error, { json: ctx.json }));
		return 2;
	}

	if (sub === "inspect") {
		try {
			const source = ctx.positionals[1];
			const entry = Object.values(loadMirrorIndex(config.workspacePath).entries).find(
				(entry) => entry.virtualPath === source || entry.sourcePath === source,
			);
			if (!entry)
				throw new Error(
					`No parsed mirror for ${source ?? "(missing source)"}; run refresh first and pass a virtual source or absolute original path`,
				);
			const tokenizer = await loadIndexTokenizer({
				root: config.workspacePath,
				model: config.minSync?.embedder?.id?.replace(/^(?:native|openai|tei):/, "") ?? "Qwen/Qwen3-Embedding-0.6B",
				tokenizerPath: config.localIndex?.tokenizerPath,
			});
			const markdown = await readFile(entry.outputPath, "utf8");
			ctx.stdout(
				JSON.stringify(
					{
						source: entry.sourcePath,
						virtualPath: entry.virtualPath,
						tokenizer: tokenizer.fingerprint,
						chunks: chunkMarkdown(markdown, tokenizer, config.localIndex).map((chunk) => {
							const embeddingInput = `${config.minSync?.embedder?.passagePrefix ?? ""}${chunk.embeddingText}`;
							return {
								...chunk,
								embeddingInput,
								inputTokens: tokenizer.count(embeddingInput),
								specialTokenReserve: 8,
							};
						}),
					},
					null,
					2,
				),
			);
			return 0;
		} catch (error) {
			ctx.stderr(renderError(error, { json: ctx.json, debug: ctx.debug }));
			return 1;
		}
	}
	if (sub === "remove") return runIndexRemove(ctx, config);

	// Reset only AutoRAG-owned indexes. Keep the legacy MinSync directory for rollback.
	const methods = parseMethodFlag(ctx.flags.method);
	const { targetNames, targetSubdirs, refreshMethods } = resolveResetScope(methods);

	const autoragDir = resolve(config.workspacePath, ".autorag");
	const targets = targetSubdirs.map((subdir) => resolve(config.workspacePath, subdir));

	// Guard 1: `.autorag` and each index dir must be real directories owned by
	// autorag. A symlink here could redirect rmSync outside the workspace, so
	// refuse rather than follow it (lexical containment alone cannot catch this).
	for (const dir of [autoragDir, ...targets]) {
		if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
			ctx.stderr(
				renderError(new Error("Refusing to reset: an index path is a symlink, not a real directory."), {
					json: ctx.json,
				}),
			);
			return 1;
		}
	}

	// Guard 2: every target must resolve inside the .autorag directory so a
	// mis-resolved workspacePath can never delete outside it.
	for (const target of targets) {
		if (!isWithin(target, autoragDir)) {
			ctx.stderr(renderError(new Error(`Refusing to reset target outside .autorag: ${target}`), { json: ctx.json }));
			return 1;
		}
	}

	// Confirmation: --yes bypasses; otherwise require an interactive yes.
	if (!ctx.flags.yes) {
		if (ctx.promptYesNo) {
			const ok = await ctx.promptYesNo(
				`Reset the ${targetNames.join(", ")} indexes under ${join(config.workspacePath, ".autorag")}?`,
			);
			if (!ok) {
				ctx.stderr(renderError(new Error("Reset declined."), { json: ctx.json }));
				return 2;
			}
		} else {
			ctx.stderr(
				renderError(new Error("Reset requires --yes or an interactive terminal (declined)."), { json: ctx.json }),
			);
			return 2;
		}
	}

	// Remove each existing target. force:true makes this idempotent.
	for (const target of targets) {
		rmSync(target, { recursive: true, force: true });
	}
	if (sub === "reset" || targetSubdirs.includes(PARSED_MIRROR_SUBDIR) || targetSubdirs.includes(LOCAL_INDEX_SUBDIR)) {
		rmSync(refreshReadinessPath(config.workspacePath), { force: true });
		removeRefreshProgress(config.workspacePath);
	}

	if (sub === "reset") {
		ctx.stdout(renderIndex({ action: "reset", removed: [...targetNames] }, { json: ctx.json }));
		return 0;
	}

	// rebuild: re-run a forced refresh with a model-free agent, scoped to methods.
	let rebuilt: AutoRAGRefreshResult;
	try {
		const agent = new AutoRAGAgent(buildAgentOptions(config));
		rebuilt = await agent.refresh(true, refreshMethods ? { methods: refreshMethods } : undefined);
	} catch (error) {
		ctx.stderr(renderError(error, { json: ctx.json }));
		return 1;
	}

	ctx.stdout(renderIndex({ action: "rebuild", removed: [...targetNames], rebuilt }, { json: ctx.json }));
	return rebuilt.minsync?.ok === false ? 1 : 0;
}

/**
 * Resolve which index directories to reset and which refresh methods to run,
 * based on the parsed `--method` flag. When `methods` is undefined (no flag),
 * both index dirs are reset and a full refresh runs.
 *
 * Mapping:
 * - `minsync` → reset LOCAL_INDEX_SUBDIR, refresh with minsync (+ parsed)
 * - `parsed` → reset PARSED_MIRROR_SUBDIR, refresh with parsed only
 * - `all` or undefined → both dirs + full refresh
 * - `datasources`/`jikji` → no dirs to reset, but included in refresh methods
 */
function resolveResetScope(methods: readonly RefreshMethod[] | undefined): {
	targetNames: readonly string[];
	targetSubdirs: readonly string[];
	refreshMethods: readonly RefreshMethod[] | undefined;
} {
	if (methods === undefined) {
		return {
			targetNames: ALL_RESET_TARGET_NAMES,
			targetSubdirs: ALL_RESET_TARGETS,
			refreshMethods: undefined,
		};
	}
	const subdirs: string[] = [];
	const names: string[] = [];
	const refresh: RefreshMethod[] = [];
	const addTarget = (name: string, subdir: string): void => {
		if (names.includes(name)) return;
		names.push(name);
		subdirs.push(subdir);
	};
	for (const m of methods) {
		refresh.push(m);
		if (m === "parsed") {
			addTarget("parsed", PARSED_MIRROR_SUBDIR);
		} else if (m === "minsync") {
			addTarget("minsync", LOCAL_INDEX_SUBDIR);
		}
		// datasources/jikji have no reset dir but are valid refresh methods.
	}
	return {
		targetNames: names,
		targetSubdirs: subdirs,
		refreshMethods: refresh,
	};
}

function isWithin(target: string, base: string): boolean {
	const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
	return target === base || target.startsWith(prefix);
}

/**
 * `autorag index remove <source>` — delete every index entry built from one source
 * file and free the space it occupied.
 *
 * The source file itself is never touched; only indexes derived from it are. Because
 * the source stays on disk, the removal is made durable in two places:
 *
 * 1. the parsed-mirror entry and its `.md` mirror are deleted right away, and
 * 2. the source is appended to `excludePaths`, so a later `refresh` (including the
 *    watch daemon) treats it as deliberately un-indexed instead of re-parsing it.
 *
 * A scoped refresh then drops the semantic vectors and compacts the store, which is
 * what actually returns disk space. Index the source again by removing it from
 * `excludePaths` and running `autorag refresh`.
 */
async function runIndexRemove(ctx: CommandContext, initial: CliConfig): Promise<number> {
	const requested = ctx.positionals[1];
	if (requested === undefined || requested.length === 0) {
		ctx.stderr(renderError(new Error("Usage: autorag index remove <source> [--yes]"), { json: ctx.json }));
		return 2;
	}
	const entry = findMirroredSource(initial.workspacePath, requested, ctx.cwd);
	if (entry === undefined) {
		ctx.stderr(
			renderError(
				new Error(
					`No indexed source matches ${requested}. Pass a virtual path or source path shown by "autorag index inspect" or "autorag status".`,
				),
				{ json: ctx.json },
			),
		);
		return 1;
	}

	// Confirmation mirrors `index reset`: --yes bypasses, otherwise require an interactive yes.
	if (!ctx.flags.yes) {
		if (ctx.promptYesNo) {
			const ok = await ctx.promptYesNo(`Delete every index entry built from ${entry.virtualPath}?`);
			if (!ok) {
				ctx.stderr(renderError(new Error("Removal declined."), { json: ctx.json }));
				return 2;
			}
		} else {
			ctx.stderr(
				renderError(new Error("Removal requires --yes or an interactive terminal (declined)."), { json: ctx.json }),
			);
			return 2;
		}
	}

	// Persist the exclusion first, so a config write failure aborts before anything is deleted.
	const excluded = excludeSourcePath(initial, entry.sourcePath);
	removeMirrorEntry(initial.workspacePath, entry);
	// MinSync drops staged mirrors it no longer sees; keep that staging area in step with the mirror index.

	let rebuilt: AutoRAGRefreshResult;
	try {
		// Re-resolve so the refresh runs with the exclusion just persisted.
		const config = resolveConfig({ flags: ctx.flags, cwd: ctx.cwd });
		const agent = new AutoRAGAgent(buildAgentOptions(config));
		rebuilt = await agent.refresh(false, { methods: ["parsed", "minsync"] });
	} catch (error) {
		ctx.stderr(renderError(error, { json: ctx.json, debug: ctx.debug }));
		if (!ctx.json) {
			ctx.stderr(
				`note: the parsed index entry for ${entry.virtualPath} was already removed; run "autorag refresh" to retry the semantic cleanup.`,
			);
		}
		return 1;
	}

	ctx.stdout(
		renderIndex(
			{ action: "remove", source: entry.virtualPath, excluded, rebuilt },
			{ json: ctx.json, debug: ctx.debug },
		),
	);
	return rebuilt.minsync?.ok === false ? 1 : 0;
}

/** Find the parsed-mirror entry for a virtual path, an absolute source path, or a cwd-relative path. */
function findMirroredSource(workspacePath: string, requested: string, cwd: string): ParsedMirrorEntry | undefined {
	const entries = Object.values(loadMirrorIndex(workspacePath).entries);
	const absolute = resolve(cwd, requested);
	return (
		entries.find((entry) => entry.virtualPath === requested || entry.sourcePath === requested) ??
		entries.find((entry) => entry.sourcePath === absolute)
	);
}

/** Drop one entry from the parsed-mirror index, including any skip record, and delete its `.md` mirror. */
function removeMirrorEntry(workspacePath: string, entry: ParsedMirrorEntry): void {
	const index = loadMirrorIndex(workspacePath);
	const entries = { ...index.entries };
	delete entries[entry.virtualPath];
	const skipped = { ...index.skipped };
	delete skipped[entry.virtualPath];
	saveMirrorIndex(workspacePath, { version: 1, entries, skipped });
	rmSync(entry.outputPath, { force: true });
}

/**
 * Append the source to the persisted `excludePaths` so the next refresh treats it as
 * deliberately un-indexed instead of re-parsing it. Returns whether the config changed
 * (`false` when the source was already excluded).
 */
function excludeSourcePath(config: CliConfig, sourcePath: string): boolean {
	if ((config.excludePaths ?? []).includes(sourcePath)) return false;
	const configPath = config.configPath;
	if (configPath === undefined) throw new Error("Cannot persist the exclusion: no config file path was resolved.");
	const raw = existsSync(configPath) ? readRawConfigObject(configPath) : {};
	const existing = Array.isArray(raw.excludePaths)
		? raw.excludePaths.filter((value): value is string => typeof value === "string")
		: [];
	writeConfigObject(configPath, { ...raw, excludePaths: [...existing, sourcePath] });
	return true;
}
