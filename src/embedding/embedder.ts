/** Shared semantic contract: local FastEmbed over loopback HTTP or a trusted API profile. */

export interface EmbeddingIdentity {
	readonly provider: string;
	readonly model: string;
	readonly dimension: number;
	readonly fingerprint?: string;
}

/**
 * What a text is for. Instruction-aware models embed a search query differently from the document it should
 * match, so a caller says which side it is on. `"document"` is the default.
 */
export type EmbedRole = "query" | "document";

export interface EmbedOptions {
	readonly role?: EmbedRole;
	readonly signal?: AbortSignal;
}

export interface Embedder {
	/** Pin a profile for an entire multi-call consumer operation. */
	snapshot?(): Embedder;
	capabilities?(): Promise<{
		readonly maxInputTokens?: number;
		readonly handlesRetries?: boolean;
		readonly queryPrefix?: string;
		readonly passagePrefix?: string;
	}>;
	identity(): Promise<EmbeddingIdentity>;
	embed(texts: readonly string[], options?: EmbedOptions): Promise<readonly (readonly number[])[]>;
}

/** Where a {@link ManagedEmbedder} is sending text right now. `none` means nothing can embed. */
export type EmbeddingBackend = "local-http" | "api" | "daemon" | "in-process" | "remote" | "none";

/** Whether the embedding backend answers right now. Probed on every call; nothing is cached. */
export interface EmbedderHealth {
	readonly backend: EmbeddingBackend;
	readonly alive: boolean;
	/** The answering server's address when alive, or why it is not. */
	readonly detail?: string;
}

/** Where a {@link ManagedEmbedder} currently sends text, for external CLIs that need a URL. */
export interface EmbedderEndpoint {
	/** Server root; the OpenAI route is under `/v1`, TEI at `/embed`. */
	readonly baseUrl: string;
	readonly protocol: "openai" | "tei";
	readonly model: string;
	readonly dimension: number | undefined;
	/** Name of the environment variable that holds the bearer token; remote endpoints only. */
	readonly apiKeyEnv?: string;
	/**
	 * Prefixes this endpoint's consumers must apply themselves: the server embeds text as sent. Set only when
	 * the embedder was given prefixes.
	 */
	readonly queryPrefix?: string;
	readonly passagePrefix?: string;
	readonly backend: "local-http" | "api" | "daemon" | "remote";
}

/**
 * An embedder that reports its endpoint. Only explicit indexing/service controls can start a local child.
 */
export interface ManagedEmbedder extends Embedder {
	/** Validates local readiness or probes the API with fixed non-corpus text. Never starts anything. */
	health(): Promise<EmbedderHealth>;
	/** The HTTP endpoint behind this embedder right now, or undefined while it would embed in-process. */
	describeEndpoint(): Promise<EmbedderEndpoint | undefined>;
	close(): Promise<void>;
	/** Explicit user operations only; health and embedding never start a process. */
	start?(signal?: AbortSignal, onProgress?: (detail: string) => void): Promise<void>;
	stop?(): Promise<void>;
	forConsumer?(consumer: import("./config.ts").EmbeddingConsumer): ManagedEmbedder;
}
