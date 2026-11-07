import { readFile, realpath } from "node:fs/promises";
import { fileSha256 } from "../filesystem/content-fingerprint.ts";
import { loadActiveMirrorIndex, type ParsedMirrorEntry } from "../mirror/index-store.ts";
import { mirrorOutputPath, readStructure } from "../mirror/structured.ts";
import type { DocumentStructure } from "../parser/table-structure.ts";
import { contentHash } from "./chunker.ts";
import type { LocalReadHandle } from "./evidence.ts";
import type { IndexEvidenceChunk } from "./types.ts";

export const MAX_EVIDENCE_BODY_BYTES = 64 * 1024;

export interface EvidenceRevision {
	readonly source: string;
	readonly sourceSha256: string;
	readonly outputSha256: string;
	readonly structureSha256?: string;
	readonly structure?: DocumentStructure;
	readonly markdown: string;
}

/** Uses the hashes captured from parser input/output, never a timestamp as proof of source identity. */
export async function readEvidenceRevision(
	root: string,
	entry: ParsedMirrorEntry,
	authorize: (source: string, sourceId: string) => boolean,
	signal?: AbortSignal,
	backend?: "kordoc" | "docling",
): Promise<EvidenceRevision | undefined> {
	signal?.throwIfAborted();
	const source = await realpath(entry.sourcePath);
	if (!authorize(source, entry.virtualPath)) return undefined;
	if (!entry.sourceSha256 || !entry.outputSha256 || entry.outputPath !== mirrorOutputPath(root, entry, backend))
		return undefined;
	const sourceSha256 = await fileSha256(entry.sourcePath, signal);
	const markdown = await readFile(entry.outputPath, { encoding: "utf8", signal });
	const outputSha256 = contentHash(markdown);
	if (sourceSha256 !== entry.sourceSha256 || outputSha256 !== entry.outputSha256) return undefined;
	const structure = await readStructure(root, entry, markdown, signal);
	if ((await realpath(entry.sourcePath)) !== source || !authorize(source, entry.virtualPath)) return undefined;
	return { source, sourceSha256, outputSha256, structureSha256: entry.structureSha256, structure, markdown };
}

export function evidenceHandle(
	row: IndexEvidenceChunk,
	profile: string,
	revision: EvidenceRevision,
): LocalReadHandle | undefined {
	if (row.text !== revision.markdown.slice(row.start, row.end)) return undefined;
	return {
		version: 1,
		source: revision.source,
		sourceId: row.source_id,
		chunkId: row.id,
		profile,
		bodySha256: contentHash(row.text),
		sourceSha256: revision.sourceSha256,
		outputSha256: revision.outputSha256,
		...(revision.structureSha256 === undefined ? {} : { structureSha256: revision.structureSha256 }),
	};
}

export async function verifyEvidenceRevision(
	root: string,
	handle: LocalReadHandle,
	authorize: (source: string, sourceId: string) => boolean,
	signal?: AbortSignal,
): Promise<EvidenceRevision> {
	if (!authorize(handle.source, handle.sourceId))
		throw new Error("Local evidence is outside the current search roots or scope");
	const mirror = loadActiveMirrorIndex(root);
	const entry = mirror.entries[handle.sourceId];
	if (!entry) throw new Error("Local evidence mirror is unavailable; refresh and search again");
	const revision = await readEvidenceRevision(root, entry, authorize, signal, mirror.backend);
	if (
		!revision ||
		revision.source !== handle.source ||
		revision.sourceSha256 !== handle.sourceSha256 ||
		revision.outputSha256 !== handle.outputSha256 ||
		revision.structureSha256 !== handle.structureSha256
	)
		throw new Error(`Local evidence source or parsed version changed: ${handle.source}; refresh and search again`);
	return revision;
}
