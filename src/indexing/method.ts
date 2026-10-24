import { realpathSync } from "node:fs";
import type { MinSyncSyncResult } from "../minsync/types.ts";
import type {
	RetrievalMethod,
	RetrievalMethodDescriptor,
	RetrievalOptions,
	RetrievalResult,
} from "../retrieval/types.ts";
import { LocalDocumentIndex } from "./pipeline.ts";
import type { IndexDocument, IndexEvent, IndexHit, LocalIndexOptions } from "./types.ts";

/** Legacy registry names are retained so saved method selections keep working. No MinSync CLI is spawned. */
export class LocalIndexMethod implements RetrievalMethod {
	readonly index: LocalDocumentIndex;
	private readonly mode: "vector" | "hybrid";
	private readonly defaultTopK: number;
	constructor(
		options: LocalIndexOptions & { index?: LocalDocumentIndex; mode?: "vector" | "hybrid"; defaultTopK?: number },
	) {
		this.index = options.index ?? new LocalDocumentIndex(options);
		this.mode = options.mode ?? "vector";
		this.defaultTopK = options.defaultTopK ?? 50;
	}
	describe(): RetrievalMethodDescriptor {
		return {
			name: this.mode === "vector" ? "minsync" : "hybrid",
			type: this.mode,
			description: "AutoRAG-owned local document index (explicit embedding and LanceDB operations)",
			status: "active",
			capabilities: [
				"semantic",
				...(this.mode === "hybrid" ? ["lexical"] : []),
				"incremental",
				"parsed-mirrors",
				"virtual-paths",
				"stage-timings",
			],
		};
	}
	isReady(): boolean {
		return this.index.isReady();
	}
	async sync(
		force = false,
		signal?: AbortSignal,
		documents?: AsyncIterable<IndexDocument>,
		onEvent?: (event: IndexEvent) => void,
	): Promise<MinSyncSyncResult> {
		const report = await this.index.sync(documents, { force, signal, onEvent });
		const failedSources = new Set(report.failures.map((failure) => failure.path)).size;
		return {
			ok: report.ok,
			synced: Math.max(0, report.documents - report.unchanged - failedSources),
			workspacePath: this.index.directory,
			report,
			...(report.failures.length
				? {
						filesFailed: report.failures,
						reason: report.failures.map((failure) => `${failure.path}: ${failure.error}`).join("\n"),
					}
				: {}),
		};
	}
	async retrieve(query: string, options: RetrievalOptions): Promise<RetrievalResult[]> {
		const queryOptions = { ...options, topK: options.topK ?? this.defaultTopK };
		let hits: readonly IndexHit[];
		let embeddingError: string | undefined;
		try {
			hits = await this.index.search(query, { ...queryOptions, mode: this.mode });
		} catch (error) {
			if (this.mode !== "hybrid" || options.signal?.aborted) throw error;
			// Preserve the existing hybrid fallback, with the underlying failure visible on each hit.
			hits = await this.index.search(query, { ...queryOptions, mode: "bm25" });
			embeddingError = error instanceof Error ? error.message : String(error);
		}
		return hits.map(({ row, score }) => ({
			id: row.id,
			source: realpathSync(row.source_path),
			content: row.text,
			score,
			metadata: {
				method: this.mode === "vector" ? "minsync" : "hybrid",
				indexBackend: "autorag",
				...(embeddingError === undefined ? {} : { embeddingError, retrievalMode: "bm25" }),
				virtualPath: row.source_id,
				chunkId: row.id,
				heading: row.heading,
				chunkType: row.kind,
				start: row.start,
				end: row.end,
				tokens: row.tokens,
			},
		}));
	}
}
