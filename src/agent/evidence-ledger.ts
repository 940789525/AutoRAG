import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type LocalEvidenceResult,
	type LocalReadHandle,
	localEvidence,
	localReadHandleSchema,
} from "../indexing/evidence.ts";
import type { RetrievalResult } from "../retrieval/types.ts";
import type { AutoRAGEvidenceRef } from "./results.ts";

/** Stored content per evidence entry; a huge chunk must not bloat the run or the memory file. */
const MAX_CONTENT_CHARS = 2_000;

export interface LedgerEvidenceInput {
	readonly method: string;
	readonly source: string;
	readonly content: string;
	readonly retrievalResultId?: string;
	readonly chunkIndex?: number;
	readonly lineNumber?: number;
	readonly parserType?: string;
	readonly documentType?: string;
	readonly documentArea?: string;
	readonly evidenceType?: string;
	readonly evidenceLocation?: string;
}

/** Custom session entry type under which a conversation persists its evidence ledger. */
export const EVIDENCE_ENTRY_TYPE = "autorag.evidence";

const ledgerEntrySchema = Type.Object({
	id: Type.String({ pattern: "^e[1-9][0-9]*$" }),
	/** Source plus a digest of the full chunk: the same chunk retrieved again keeps its id. */
	key: Type.String(),
	method: Type.String(),
	source: Type.String(),
	content: Type.String(),
	retrieverMix: Type.Array(Type.String()),
	retrievalResultId: Type.Optional(Type.String()),
	chunkIndex: Type.Optional(Type.Number()),
	lineNumber: Type.Optional(Type.Number()),
	parserType: Type.Optional(Type.String()),
	documentType: Type.Optional(Type.String()),
	documentArea: Type.Optional(Type.String()),
	evidenceType: Type.Optional(Type.String()),
	evidenceLocation: Type.Optional(Type.String()),
	localReadHandle: Type.Optional(localReadHandleSchema),
	localReadAmbiguous: Type.Optional(Type.Boolean()),
});

/** One recorded piece of evidence: what a retrieval tool returned, under the id it printed. */
export type LedgerEntry = Static<typeof ledgerEntrySchema>;

/** What a session persists under {@link EVIDENCE_ENTRY_TYPE}. */
const persistedEvidenceSchema = Type.Object({ entries: Type.Array(Type.Unknown()) });

/**
 * Entries a session persisted under {@link EVIDENCE_ENTRY_TYPE}. A malformed
 * entry is skipped: its id then resolves to nothing and the citation is
 * dropped with a diagnostic, never mis-resolved.
 */
export function parseLedgerEntries(data: unknown): LedgerEntry[] {
	if (!Value.Check(persistedEvidenceSchema, data)) return [];
	return data.entries.flatMap((entry): LedgerEntry[] => {
		if (Value.Check(ledgerEntrySchema, entry)) return [entry];
		// A corrupt optional locator must not destroy an otherwise valid historical citation.
		if (entry && typeof entry === "object") {
			const withoutLocator = { ...entry } as Record<string, unknown>;
			delete withoutLocator.localReadHandle;
			if (Value.Check(ledgerEntrySchema, withoutLocator)) return [withoutLocator];
		}
		return [];
	});
}

/** Highest evidence id ordinal among `entries` (`e12` is 12); 0 when there are none. */
export function highestOrdinal(entries: readonly LedgerEntry[]): number {
	let highest = 0;
	for (const entry of entries) highest = Math.max(highest, Number(entry.id.slice(1)));
	return highest;
}

export interface LookupEvidenceOptions {
	/** False in remote sessions: only evidence a tool returned this run may be cited. */
	readonly allowLocalFiles: boolean;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
	const value = metadata[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** First chars of a local file the model opened itself; the path when it is not readable text. */
function readFileExcerpt(path: string): string {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const buffer = Buffer.alloc(MAX_CONTENT_CHARS * 4);
		const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, bytes);
		return head.includes(0) ? path : head.toString("utf8").slice(0, MAX_CONTENT_CHARS);
	} catch {
		return path;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function toEvidenceRef(entry: LedgerEntry): AutoRAGEvidenceRef {
	return {
		method: entry.method,
		source: entry.source,
		content: entry.content,
		retrieverMix: [...entry.retrieverMix],
		...(entry.retrievalResultId !== undefined ? { retrievalResultId: entry.retrievalResultId } : {}),
		...(entry.chunkIndex !== undefined ? { chunkIndex: entry.chunkIndex } : {}),
		...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {}),
		...(entry.parserType !== undefined ? { parserType: entry.parserType } : {}),
		...(entry.documentType !== undefined ? { documentType: entry.documentType } : {}),
		...(entry.documentArea !== undefined ? { documentArea: entry.documentArea } : {}),
		...(entry.evidenceType !== undefined ? { evidenceType: entry.evidenceType } : {}),
		...(entry.evidenceLocation !== undefined ? { evidenceLocation: entry.evidenceLocation } : {}),
	};
}

export function evidenceLedgerKey(source: string, content: string, handle?: LocalReadHandle): string {
	const digest = createHash("sha256").update(content.replace(/\s+/gu, " ").trim()).digest("hex");
	return handle?.structureSha256
		? `${source}\0${digest}\0${handle.profile}\0${handle.chunkId}`
		: `${source}\0${digest}`;
}

/**
 * Record of every piece of evidence the retrieval tools returned in one
 * conversation.
 *
 * Tools hand the model a short id (`e1`, `e2`, ...) next to each result. The
 * model cites evidence by id; the harness resolves the id back to the exact
 * source, method, content, and chunk metadata it recorded. The model never
 * retypes a path or a chunk, so it cannot misquote or invent one, and the
 * stable evidence id stored in memory is always derived from real evidence.
 *
 * Ids count up for as long as the process lives and are never reissued, so an
 * id the model saw in any earlier turn keeps naming the chunk it named. The
 * hosting session persists what {@link takeUnsaved} returns and rebuilds the
 * ledger with {@link restore} when a conversation is resumed.
 */
export class EvidenceLedger {
	/** Internal observer only; signals and full vectors are never persisted in ledger entries. */
	onLocalResult?: (id: string, result: RetrievalResult) => void;
	onClear?: () => void;
	private entries: LedgerEntry[] = [];
	private readonly byKey = new Map<string, LedgerEntry>();
	private readonly byId = new Map<string, LedgerEntry>();
	/** Entries recorded or changed since the last {@link takeUnsaved}. */
	private readonly unsaved = new Set<LedgerEntry>();
	/**
	 * Ordinal of the last issued id. Survives {@link clear} and {@link restore}:
	 * a conversation keeps earlier turns' tool output in context, so restarting
	 * at e1 would let a stale id silently resolve to a different chunk.
	 */
	private lastOrdinal = 0;
	private readonly localReadIds = new Set<string>();
	localReadEntry(id: string): LedgerEntry | undefined {
		const entry = this.byId.get(id);
		return entry?.localReadHandle ? structuredClone(entry) : undefined;
	}
	localReadEntries(): readonly LedgerEntry[] {
		return [...this.localReadIds].flatMap((id) => {
			const entry = this.localReadEntry(id);
			return entry ? [entry] : [];
		});
	}
	private attachLocalReadHandle(id: string, handle: LocalReadHandle | undefined): void {
		if (!handle || !Value.Check(localReadHandleSchema, handle)) return;
		const entry = this.byId.get(id)!;
		if (entry.localReadAmbiguous) return;
		if (entry.localReadHandle && JSON.stringify(entry.localReadHandle) !== JSON.stringify(handle)) {
			delete entry.localReadHandle;
			entry.localReadAmbiguous = true;
			this.localReadIds.delete(id);
		} else {
			entry.localReadHandle = { ...handle };
			this.localReadIds.add(id);
		}
		this.unsaved.add(entry);
		while (this.localReadIds.size > 1024) {
			const oldest = this.localReadIds.values().next().value!;
			this.localReadIds.delete(oldest);
			const evicted = this.byId.get(oldest)!;
			delete evicted.localReadHandle;
			this.unsaved.add(evicted);
		}
	}

	/** Record evidence and return its id. The same chunk always gets the same id. */
	register(input: LedgerEvidenceInput, handle?: LocalReadHandle): string {
		const content = input.content.slice(0, MAX_CONTENT_CHARS);
		// Key on the full normalized chunk, not the capped stored content: two
		// distinct chunks sharing their first MAX_CONTENT_CHARS must keep their
		// own ids and metadata instead of merging into the first one.
		const key = evidenceLedgerKey(input.source, input.content, handle);
		const existing = this.byKey.get(key);
		if (existing !== undefined) {
			if (!existing.retrieverMix.includes(input.method)) {
				existing.retrieverMix.push(input.method);
				this.unsaved.add(existing);
			}
			return existing.id;
		}
		const entry: LedgerEntry = {
			...input,
			content,
			id: `e${++this.lastOrdinal}`,
			key,
			retrieverMix: [input.method],
		};
		this.entries.push(entry);
		this.byKey.set(key, entry);
		this.byId.set(entry.id, entry);
		this.unsaved.add(entry);
		return entry.id;
	}

	/** Record one retrieval result as returned by `tool`; backend metadata is carried over. */
	registerResult(tool: string, result: RetrievalResult): string {
		const metadata = result.metadata;
		const chunkIndex = metadataNumber(metadata, "chunkIndex");
		const lineNumber = metadataNumber(metadata, "lineNumber");
		const parserType = metadataString(metadata, "parserType");
		const documentType = metadataString(metadata, "documentType");
		const documentArea = metadataString(metadata, "documentArea");
		const evidenceType = metadataString(metadata, "evidenceType");
		const evidenceLocation = metadataString(metadata, "evidenceLocation");
		const handle = (result as LocalEvidenceResult)[localEvidence]?.readHandle;
		const id = this.register(
			{
				method: metadataString(metadata, "method") ?? tool,
				source: result.source,
				content: result.content,
				retrievalResultId: result.id,
				...(chunkIndex !== undefined ? { chunkIndex } : {}),
				...(lineNumber !== undefined ? { lineNumber } : {}),
				...(parserType !== undefined ? { parserType } : {}),
				...(documentType !== undefined ? { documentType } : {}),
				...(documentArea !== undefined ? { documentArea } : {}),
				...(evidenceType !== undefined ? { evidenceType } : {}),
				...(evidenceLocation !== undefined ? { evidenceLocation } : {}),
			},
			handle,
		);
		this.onLocalResult?.(id, result);
		this.attachLocalReadHandle(id, handle);
		return id;
	}

	/**
	 * Resolve one cited reference to recorded evidence. A ref is an evidence id
	 * (`e3` or `[e3]`), the exact source a tool returned (a URL, a datasource
	 * id, a path), or the absolute path of a real local file the model opened
	 * itself. Returns an empty list when nothing matches: the caller drops the
	 * citation instead of failing the run.
	 */
	lookup(raw: string, options: LookupEvidenceOptions): AutoRAGEvidenceRef[] {
		const trimmed = raw.trim();
		const ref = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1).trim() : trimmed;
		const byId = this.byId.get(ref);
		if (byId !== undefined) return [toEvidenceRef(byId)];
		const bySource = this.entries.filter((entry) => entry.source === ref);
		if (bySource.length > 0) return bySource.map(toEvidenceRef);
		if (options.allowLocalFiles && isAbsolute(ref) && isRegularFile(ref)) {
			return [{ method: "bash", source: ref, content: readFileExcerpt(ref) }];
		}
		return [];
	}

	/** Forget every recorded entry. Ids are never reissued, so a previous conversation's id stays unresolvable. */
	clear(): void {
		this.onClear?.();
		this.entries = [];
		this.byKey.clear();
		this.byId.clear();
		this.unsaved.clear();
		this.localReadIds.clear();
	}

	/** Entries recorded or changed since the last call, for the hosting session to persist. */
	takeUnsaved(): LedgerEntry[] {
		const entries = [...this.unsaved];
		this.unsaved.clear();
		return entries;
	}

	/**
	 * Rebuild the ledger from persisted entries, such as the ones on the resumed
	 * conversation branch; a later entry with the same id replaces an earlier
	 * one. Ids keep counting past every restored id and past `ordinalFloor`, the
	 * highest id issued anywhere in the conversation (other branches included),
	 * so a restored ledger never reissues an id a transcript may still show.
	 */
	restore(entries: readonly LedgerEntry[], ordinalFloor = 0): void {
		this.clear();
		const latest = new Map<string, LedgerEntry>();
		for (const entry of entries) latest.set(entry.id, { ...entry, retrieverMix: [...entry.retrieverMix] });
		for (const entry of latest.values()) {
			this.entries.push(entry);
			this.byKey.set(entry.key, entry);
			this.byId.set(entry.id, entry);
			if (entry.localReadHandle) this.localReadIds.add(entry.id);
		}
		while (this.localReadIds.size > 1024) {
			const oldest = this.localReadIds.values().next().value!;
			this.localReadIds.delete(oldest);
			delete this.byId.get(oldest)!.localReadHandle;
		}
		this.lastOrdinal = Math.max(this.lastOrdinal, ordinalFloor, highestOrdinal(this.entries));
	}
}
