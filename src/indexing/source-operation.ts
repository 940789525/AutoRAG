import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveConfig, updateConfigObject } from "../cli/config.ts";
import { planSourceRoots, resolveVirtualSource, sourceIdentifier } from "../filesystem/source-paths.ts";
import { writeFileAtomic } from "../mirror/atomic-write.ts";
import { loadMirrorIndex, saveMirrorIndex } from "../mirror/index-store.ts";
import { parsedOutputPath } from "../mirror/paths.ts";
import { isPathExcluded } from "../mirror/sync.ts";
import { contentHash } from "./chunker.ts";

interface Receipt {
	sourceId: string;
	path: string;
	configPath: string;
	ownsExclusion: boolean;
	phase: "remove" | "restore";
}
function receiptFile(root: string, id: string) {
	return join(root, ".autorag", "index-jobs", "sources", `${contentHash(id)}.json`);
}

/** Called under the workspace refresh lease. Keep the receipt through partial sync failures. */
export function prepareSourceOperation(
	mode: "remove" | "restore",
	root: string,
	roots: readonly string[],
	configPath: string,
	id: string,
	registered?: boolean,
) {
	const target = resolveVirtualSource(id, planSourceRoots(roots));
	if (
		!target ||
		target.sourceId !== id ||
		sourceIdentifier(target.root, target.realPath) !== id ||
		!statSync(target.realPath).isFile()
	)
		throw new Error(`No permitted local file matches ${id}`);
	const path = target.realPath;
	const file = receiptFile(root, id);
	const prior: Receipt | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
	if (prior && (prior.path !== path || prior.sourceId !== id || prior.configPath !== configPath))
		throw new Error("Source identity or configuration changed since removal");
	const mirror = loadMirrorIndex(root);
	const entry = mirror.entries[id];
	const output = parsedOutputPath(root, id);
	if (entry && (entry.sourcePath !== path || entry.outputPath !== output))
		throw new Error("Source mirror identity mismatch");
	if (mode === "remove" && (!entry || registered === false) && !prior)
		throw new Error(`No indexed source matches ${id}`);
	if (mode === "restore" && !prior?.ownsExclusion) throw new Error(`No restorable exclusion for ${id}`);
	let added = false;
	updateConfigObject(configPath, (raw) => {
		const cfg = resolveConfig({ flags: { config: configPath }, readOnly: true });
		if (
			resolve(cfg.workspacePath) !== resolve(root) ||
			!cfg.searchPaths.some((p) => realpathSync(p) === target.root.rootPath)
		)
			throw new Error("Workspace or search roots changed; reopen the TUI");

		const origin = raw.workspacePath ? resolve(dirname(configPath), String(raw.workspacePath)) : dirname(configPath);
		const existing = raw.excludePaths ?? [];
		if (!Array.isArray(existing) || !existing.every((x) => typeof x === "string"))
			throw new Error("Invalid excludePaths");
		const exact = (p: string) => resolve(origin, p) === path;
		const present = existing.some(exact);
		if (
			mode === "remove" &&
			registered !== undefined &&
			!prior &&
			isPathExcluded(path, new Set(existing.map((p) => resolve(origin, p))))
		)
			throw new Error(`Source is already excluded: ${id}`);
		const other = existing.filter((p) => !exact(p));
		if (mode === "restore" && isPathExcluded(path, new Set(other.map((p) => resolve(origin, p)))))
			throw new Error(`Source remains excluded by another path: ${id}`);
		added = mode === "remove" && !present;
		const receipt: Receipt = {
			sourceId: id,
			path,
			configPath,
			ownsExclusion: added || prior?.ownsExclusion === true,
			phase: mode,
		};
		writeFileAtomic(file, JSON.stringify(receipt));
		raw.excludePaths = mode === "remove" ? (present ? existing : [...existing, path]) : other;
	});
	// Delete only the canonical generated output. Restore must parse the original even on retry.
	try {
		if (existsSync(output) && realpathSync(output) !== output) throw new Error("Unexpected parsed mirror symlink");
		rmSync(output, { force: true });
		const entries = { ...mirror.entries };
		const skipped = { ...mirror.skipped };
		delete entries[id];
		delete skipped[id];
		saveMirrorIndex(root, { ...mirror, entries, skipped });
	} catch (error) {
		throw new Error(`Exclusion updated for ${id}; mirror cleanup failed: ${String(error)}`);
	}
	return added;
}
export function completeSourceRestore(root: string, id: string) {
	rmSync(receiptFile(root, id), { force: true });
}
