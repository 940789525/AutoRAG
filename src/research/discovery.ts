import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileSha256 } from "../filesystem/content-fingerprint.ts";

export function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export interface FileObservation {
	path: string;
	size: number;
	mtime: string;
	sha256: string;
}

/** Watch notifications are hints. The same bounded, symlink-free scan also runs after restarts. */
export async function stablePdfs(
	root: string,
	signal?: AbortSignal,
	stabilityMs = 2000,
): Promise<{ files: FileObservation[]; pending: string[] }> {
	const candidates: { path: string; size: number; mtime: string }[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			signal?.throwIfAborted();
			if (entry.name.startsWith(".") || ["node_modules", "dist"].includes(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && /\.pdf$/iu.test(entry.name)) {
				const info = await lstat(path, { bigint: true });
				candidates.push({ path, size: Number(info.size), mtime: String(info.mtimeNs) });
				if (candidates.length > 1100)
					throw new Error("Research MVP supports at most 1100 PDF locations; narrow the library root");
			}
		}
	}
	await visit(root);
	await sleep(stabilityMs, undefined, { signal });
	const files: FileObservation[] = [];
	const pending: string[] = [];
	for (const item of candidates) {
		try {
			const info = await lstat(item.path, { bigint: true });
			if (
				!info.isFile() ||
				info.isSymbolicLink() ||
				!within(root, await realpath(item.path)) ||
				Number(info.size) !== item.size ||
				String(info.mtimeNs) !== item.mtime
			) {
				pending.push(item.path);
				continue;
			}
			files.push({ ...item, sha256: await fileSha256(item.path, signal) });
		} catch (error) {
			if (signal?.aborted) throw error;
			// An unreadable file must not silently look like an empty library.
			throw new Error(`Cannot observe ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { files, pending };
}

/** Identifiers are explicit metadata, never inferred by title similarity. */
export function normalizeIdentity(doi?: string, arxiv?: string): { doi?: string; arxivId?: string } {
	const normalizedDoi = doi
		?.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
		.toLowerCase();
	const arxivId = arxiv
		?.trim()
		.replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//iu, "")
		.replace(/\.pdf$/iu, "")
		.replace(/v\d+$/u, "");
	if (normalizedDoi && !/^10\.\d{4,9}\/\S+$/u.test(normalizedDoi)) throw new Error("Invalid DOI");
	if (arxivId && !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/u.test(arxivId))
		throw new Error("Invalid arXiv identifier");
	return { ...(normalizedDoi ? { doi: normalizedDoi } : {}), ...(arxivId ? { arxivId } : {}) };
}
