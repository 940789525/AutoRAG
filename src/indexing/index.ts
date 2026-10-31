export { CHUNKER_VERSION, chunkMarkdown } from "./chunker.ts";
export { type LocalIndexConfig, normalizeLocalIndex } from "./config.ts";
export { type IndexJob, type IndexJobRequest, IndexJobs } from "./jobs.ts";
export { LocalIndexMethod } from "./method.ts";
export { LocalDocumentIndex } from "./pipeline.ts";
export type {
	IndexChunk,
	IndexDocument,
	IndexEvent,
	IndexHit,
	IndexReport,
	IndexRow,
	IndexStore,
	LexicalAnalyzer,
	LocalIndexOptions,
	TokenCounter,
} from "./types.ts";
