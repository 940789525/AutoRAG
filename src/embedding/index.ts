import { join } from "node:path";
import { resolveAutoRAGHome } from "../config/home.ts";
import {
	DEFAULT_EMBEDDING_MODEL,
	type EmbeddingConfig,
	embeddingConfigFromLegacy,
	normalizeEmbeddingConfig,
	QWEN_MANIFEST,
} from "./config.ts";
import type { ManagedEmbedder } from "./embedder.ts";
import type { LegacyEmbedderConfig as MinSyncEmbedderConfig } from "./legacy.ts";
import { createManagedEmbedder } from "./managed.ts";
import { ProfileEmbedder } from "./profiles.ts";

export * from "./config.ts";
export { DEFAULT_EMBEDDING_MODEL as DEFAULT_DAEMON_MODEL } from "./config.ts";
export type {
	Embedder,
	EmbedderEndpoint,
	EmbedderHealth,
	EmbeddingBackend,
	EmbeddingIdentity,
	EmbedOptions,
	EmbedRole,
	ManagedEmbedder,
} from "./embedder.ts";
export { createHttpEmbedder, type EmbeddingProtocol } from "./http-embedder.ts";
export { createManagedEmbedder, type ManagedEmbedderOptions, type RemoteEmbedderSettings } from "./managed.ts";
export { type EmbeddingPrefixes, QWEN3_QUERY_PREFIX, resolveEmbeddingPrefixes } from "./prefixes.ts";
export { ProfileEmbedder } from "./profiles.ts";
export { remoteEmbedderFromMinSync } from "./settings.ts";

export interface EmbedderFromConfigOptions {
	readonly embedding?: EmbeddingConfig;
	readonly profile?: string;
	readonly workspaceRoot?: string;
	/** Deprecated configuration input, never an instruction to execute MinSync. */
	readonly embedder?: MinSyncEmbedderConfig;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

export function createEmbedderFromConfig(options: EmbedderFromConfigOptions): ManagedEmbedder {
	if (options.embedding && options.embedder)
		throw new Error(
			"Conflicting embedding and minSync.embedder configurations; migrate to embedding profiles explicitly",
		);
	const config = options.embedding
		? normalizeEmbeddingConfig(options.embedding)
		: embeddingConfigFromLegacy(options.embedder);
	for (const p of Object.values(config.profiles)) {
		if (
			p.kind === "local-http" &&
			p.model === DEFAULT_EMBEDDING_MODEL &&
			p.manifest?.revision === QWEN_MANIFEST.revision &&
			!p.manifest.tokenizerPath
		)
			p.manifest.tokenizerPath = join(
				resolveAutoRAGHome(options.env),
				"models",
				"fastembed",
				"qwen3-0.6b-af95f2c416ffe9379369ad64f9113e865db6112c",
			);
	}
	const name = options.profile ?? config.defaultProfile;
	const profile = config.profiles[name];
	if (!profile) throw new Error(`Embedding profile is not configured: ${name}`);
	const embedder = options.profile
		? createManagedEmbedder({ profile, env: options.env })
		: new ProfileEmbedder(config, options);
	created.add(embedder);
	return embedder;
}

const created = new Set<ManagedEmbedder>();
export async function releaseEmbedders(): Promise<void> {
	const embedders = [...created];
	created.clear();
	await Promise.allSettled(embedders.map((embedder) => embedder.close()));
}
