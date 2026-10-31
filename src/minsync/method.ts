/** Deprecated configuration types only. Runtime MinSync methods were removed. */
import type { MinSyncEmbedderConfig } from "./types.ts";
export interface EnsureMinSyncBinaryOptions {
	readonly root: string;
	readonly platform?: NodeJS.Platform;
	readonly arch?: NodeJS.Architecture;
	readonly env?: NodeJS.ProcessEnv;
	readonly releaseProvider?: () => Promise<unknown>;
	readonly assetInstaller?: (asset: unknown, destination: string) => Promise<void>;
	readonly cargoInstaller?: (destination: string) => Promise<{ binaryPath: string; version: string } | undefined>;
	readonly cargoLocator?: (env: NodeJS.ProcessEnv) => string | undefined;
}
export interface MinSyncVectorMethodOptions {
	readonly root: string;
	/** Test/embedded override; CLI config intentionally does not persist this. */
	readonly binaryPath?: string;
	readonly workspacePath?: string;
	readonly installer?: Omit<EnsureMinSyncBinaryOptions, "root">;
	readonly autoInstall?: boolean;
	readonly embedder?: MinSyncEmbedderConfig;
	readonly maxChunkSize?: number;
	readonly mode?: "vector" | "hybrid" | "bm25";
	/** Default `topK` used when the caller omits one. Default 50. */
	readonly defaultTopK?: number;
	/** Fetch cap applied when a scope narrows the query. Default 100. */
	readonly scopedTopK?: number;
}

export type MinSyncHybridMethodOptions = Omit<MinSyncVectorMethodOptions, "mode">;
