import type { Embedder, EmbeddingIdentity } from "../embedding/embedder.ts";

export type IndexPhase = "prepare" | "parse" | "chunk" | "lexical" | "cache" | "embed" | "write" | "maintain" | "done";

export interface IndexEvent {
	readonly runId: string;
	readonly phase: IndexPhase;
	readonly state: "start" | "end" | "error";
	readonly elapsedMs: number;
	readonly durationMs?: number;
	readonly source?: string;
	readonly count?: number;
	readonly detail?: string;
}

export interface IndexReport {
	readonly runId: string;
	readonly backend: "autorag";
	readonly ok: boolean;
	readonly durationMs: number;
	readonly timings: Readonly<Partial<Record<IndexPhase, number>>>;
	readonly documents: number;
	readonly unchanged: number;
	readonly chunks: number;
	readonly embedded: number;
	readonly reused: number;
	readonly deleted: number;
	readonly failures: readonly { path: string; stage: string; error: string }[];
	readonly reportPath: string;
}

export interface IndexDocument {
	readonly virtualPath: string;
	readonly sourcePath: string;
	readonly outputPath: string;
	readonly updatedAt: string;
	readonly parseDurationMs?: number;
}

export interface TokenCounter {
	readonly fingerprint: string;
	count(text: string): number;
}

export interface IndexChunk {
	readonly text: string;
	readonly embeddingText: string;
	readonly heading: string;
	readonly kind: string;
	/** Offsets are UTF-16 code units in the normalized markdown, never PDF/page offsets. */
	readonly start: number;
	readonly end: number;
	readonly tokens: number;
}

export interface IndexRow extends Record<string, unknown> {
	id: string;
	source_id: string;
	source_path: string;
	text: string;
	embedding_text: string;
	embedding_key: string;
	lexical_text: string;
	heading: string;
	kind: string;
	start: number;
	end: number;
	tokens: number;
	vector: number[];
}

export interface IndexHit {
	readonly row: IndexRow;
	readonly score: number;
	readonly cosine?: number;
	readonly profile?: string;
}

export type IndexEvidenceChunk = Pick<
	IndexRow,
	"id" | "source_id" | "source_path" | "text" | "heading" | "kind" | "start" | "end" | "tokens"
>;

export interface IndexStore {
	readChunk?(sourceId: string, chunkId: string): Promise<IndexEvidenceChunk | undefined>;
	countRows(): Promise<number>;
	findVectors(keys: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>;
	/** Atomically replaces complete documents, including deletion of their old chunks. */
	replace(sourceIds: readonly string[], rows: readonly IndexRow[]): Promise<void>;
	search(query: {
		text: string;
		vector?: readonly number[];
		mode: "vector" | "bm25" | "hybrid";
		topK: number;
		scope?: string;
		/** Exact source identities allowed before ranking; an empty list matches nothing. */
		sourceIds?: readonly string[];
	}): Promise<readonly IndexHit[]>;
	maintain(): Promise<void>;
}

export interface LexicalAnalyzer {
	readonly fingerprint: string;
	analyze(text: string, signal?: AbortSignal): Promise<string>;
	close?(): void;
}

export interface LocalIndexOptions {
	readonly root: string;
	readonly embedder: Embedder;
	readonly identity?: EmbeddingIdentity;
	/** Includes document formatting/prefixes and the operator's model revision. */
	readonly embeddingFingerprint?: string;
	readonly koreanModelPath?: string;
	readonly tokenizerPath?: string;
	readonly targetTokens?: number;
	readonly maxTokens?: number;
	/** Actual serving-runtime input limit, not the model card's theoretical context window. */
	readonly maxInputTokens?: number;
	readonly batchSize?: number;
	readonly maxBatchTokens?: number;
	/** Debug mode uses the same stages with one input per embedding request. */
	readonly debug?: boolean;
	readonly onEvent?: (event: IndexEvent) => void;
	/** Injection points for offline tests and embedded hosts. */
	readonly tokenizer?: TokenCounter;
	readonly analyzer?: LexicalAnalyzer;
	readonly store?: IndexStore;
}
