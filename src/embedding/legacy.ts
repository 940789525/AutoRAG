/** Read-only conversion input for saved minSync.embedder configurations. */
export interface LegacyEmbedderConfig {
	readonly id?: string;
	readonly baseUrl?: string;
	/** Environment variable name whose value holds the embedder API key. /^[A-Za-z_][A-Za-z0-9_]*$/ */
	readonly apiKeyEnv?: string;
	/** Positive integer embedding dimension. */
	readonly dimension?: number;
	readonly queryPrefix?: string;
	readonly passagePrefix?: string;
	readonly timeoutMs?: number;
	readonly batchSize?: number;
	readonly maxRetries?: number;
	readonly maxConcurrent?: number;
}
