import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DocumentStructure } from "../parser/table-structure.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { ParsedMirrorEntry } from "./index-store.ts";
import { parsedOutputPath, structuredOutputPath } from "./paths.ts";

type Revision = Pick<
	ParsedMirrorEntry,
	"virtualPath" | "parserVersion" | "sourceSha256" | "outputSha256" | "structureSha256"
>;

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function mirrorOutputPath(root: string, entry: Revision, backend?: "kordoc" | "docling"): string {
	const revision = entry.structureSha256 ?? (backend === "docling" ? entry.outputSha256 : undefined);
	return revision
		? structuredOutputPath(root, entry.virtualPath, revision)
		: parsedOutputPath(root, entry.virtualPath, backend);
}

function sidecar(path: string): string {
	return path.slice(0, -3) + ".json";
}

export function writeStructuredMirror(
	root: string,
	entry: Omit<Revision, "structureSha256">,
	markdown: string,
	structure: DocumentStructure,
): { outputPath: string; structureSha256: string } {
	const json = JSON.stringify({
		version: 1,
		sourceId: entry.virtualPath,
		sourceSha256: entry.sourceSha256,
		markdownSha256: entry.outputSha256,
		parserFingerprint: entry.parserVersion,
		document: structure,
	});
	const structureSha256 = sha256(json);
	const outputPath = mirrorOutputPath(root, { ...entry, structureSha256 });
	// The manifest is the commit point. Both names are immutable and checked by hash on read.
	writeFileAtomic(outputPath, markdown);
	writeFileAtomic(sidecar(outputPath), json);
	return { outputPath, structureSha256 };
}

export async function readStructure(
	root: string,
	entry: Revision & { readonly outputPath: string },
	markdown: string,
	signal?: AbortSignal,
): Promise<DocumentStructure | undefined> {
	if (entry.structureSha256 === undefined) return undefined;
	if (entry.outputPath !== mirrorOutputPath(root, entry) || sha256(markdown) !== entry.outputSha256)
		throw new Error(`Structured mirror Markdown version mismatch: ${entry.outputPath}`);
	const path = sidecar(entry.outputPath);
	const json = await readFile(path, { encoding: "utf8", signal });
	if (sha256(json) !== entry.structureSha256) throw new Error(`Structure SHA-256 mismatch: ${path}`);
	const payload = JSON.parse(json);
	const doc = payload.document as DocumentStructure | undefined;
	if (
		payload.version !== 1 ||
		payload.sourceId !== entry.virtualPath ||
		payload.sourceSha256 !== entry.sourceSha256 ||
		payload.markdownSha256 !== entry.outputSha256 ||
		payload.parserFingerprint !== entry.parserVersion ||
		doc?.version !== 1 ||
		typeof doc.title !== "string" ||
		!Array.isArray(doc.tables)
	)
		throw new Error(`Invalid structured mirror binding: ${path}`);
	return doc;
}
