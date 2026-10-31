import type { EmbeddingConsumer, EmbeddingProfile } from "./config.ts";
import { defaultEmbeddingConfig, embeddingConfigFromLegacy, embeddingFingerprint } from "./config.ts";
import type { EmbedderHealth, ManagedEmbedder } from "./embedder.ts";
import { createHttpEmbedder, type EmbeddingProtocol } from "./http-embedder.ts";
import { LocalEmbeddingService } from "./local-service.ts";
import type { EmbeddingPrefixes } from "./prefixes.ts";

export interface RemoteEmbedderSettings {
	readonly baseUrl: string;
	readonly model: string;
	readonly protocol: EmbeddingProtocol;
	readonly dimension?: number;
	readonly apiKeyEnv?: string;
	readonly batchSize?: number;
	readonly timeoutMs?: number;
	readonly provider?: string;
}
export interface ManagedEmbedderOptions {
	readonly profile?: EmbeddingProfile;
	readonly consumer?: EmbeddingConsumer;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetchImpl?: typeof fetch;
	/** Deprecated endpoint constructor. Remote sending still requires a trusted profile opt-in. */
	readonly remote?: RemoteEmbedderSettings;
	readonly prefixes?: EmbeddingPrefixes;
	readonly home?: string;
	readonly model?: string;
	readonly inProcess?: unknown;
}

/** HTTP only: no MinSync probing, native addon, installation or fallback. */
export function createManagedEmbedder(options: ManagedEmbedderOptions): ManagedEmbedder {
	const profile =
		options.profile ??
		(options.remote
			? embeddingConfigFromLegacy({ id: `${options.remote.protocol}:${options.remote.model}`, ...options.remote })
					.profiles["legacy-endpoint"]
			: defaultEmbeddingConfig().profiles["local-qwen3"]);
	const manifest = profile.manifest!;
	const fingerprint = embeddingFingerprint(profile);
	const fetchImpl = options.fetchImpl ?? fetch;
	const service = new LocalEmbeddingService(profile, options.env);
	const check = (consumer: EmbeddingConsumer): void => {
		if (profile.kind === "api" && profile.allowRemote !== true)
			throw new Error(
				"Remote embedding is disabled: set allowRemote:true in trusted embedding profile configuration",
			);
		if (!profile.allowedConsumers?.includes(consumer))
			throw new Error(`Embedding profile does not authorize consumer ${consumer}`);
		if (profile.apiKeyEnv && !(options.env ?? process.env)[profile.apiKeyEnv])
			throw new Error(`embedding API key is not set: environment variable ${profile.apiKeyEnv} is empty or missing`);
	};
	const http = createHttpEmbedder({
		...profile,
		provider: profile.kind === "local-http" ? "fastembed" : "api",
		fingerprint,
		env: options.env,
		fetchImpl,
	});
	let queue = Promise.resolve();
	const serial = <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
		if (signal?.aborted) return Promise.reject(signal.reason);
		const run = queue.then(() => {
			signal?.throwIfAborted();
			return work();
		});
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		if (!signal) return run;
		let abort!: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		});
		return Promise.race([run, cancelled]).finally(() => signal.removeEventListener("abort", abort));
	};
	const health = async (consumer = options.consumer ?? "local-documents"): Promise<EmbedderHealth> => {
		try {
			check(consumer);
			if (profile.kind === "api" || manifest.pooling === "provider-managed")
				await serial(() => http.embed(["AutoRAG embedding connection probe"]));
			else {
				const response = await fetchImpl(`${profile.baseUrl.replace(/\/+$/, "")}/health`, {
					signal: AbortSignal.timeout(2000),
					redirect: "error",
				});
				if (!response.ok) throw new Error(`FastEmbed health HTTP ${response.status}: ${await response.text()}`);
				const info = (await response.json()) as {
					model?: string;
					dimension?: number;
					revision?: string;
					ready?: boolean;
					maxInputTokens?: number;
					prefixOwner?: string;
					pooling?: string;
					normalization?: string;
				};
				if (
					info.ready !== true ||
					info.model !== profile.model ||
					info.dimension !== profile.dimension ||
					info.revision !== manifest.revision ||
					(info.maxInputTokens ?? 0) < manifest.maxInputTokens ||
					info.prefixOwner !== "client" ||
					info.pooling !== manifest.pooling ||
					info.normalization !== manifest.normalization
				)
					throw new Error(`FastEmbed health identity mismatch: ${JSON.stringify(info)}`);
			}
			return { backend: profile.kind, alive: true, detail: profile.baseUrl };
		} catch (error) {
			return {
				backend: profile.kind === "api" ? "api" : "none",
				alive: false,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	};
	const forConsumer = (consumer: EmbeddingConsumer): ManagedEmbedder => ({
		capabilities: async () => ({
			handlesRetries: true,
			maxInputTokens: manifest.maxInputTokens,
			queryPrefix: manifest.queryPrefix,
			passagePrefix: manifest.passagePrefix,
		}),
		identity: async () => {
			check(consumer);
			return http.identity();
		},
		embed: async (texts, request) => {
			check(consumer);
			request?.signal?.throwIfAborted();
			if (profile.kind === "local-http" && manifest.pooling !== "provider-managed") {
				const state = await health(consumer);
				if (!state.alive) throw new Error(state.detail ?? "FastEmbed service is not ready");
			}
			const prefix = request?.role === "query" ? manifest.queryPrefix : manifest.passagePrefix;
			return serial(
				() => http.embed(prefix ? texts.map((text) => `${prefix}${text}`) : texts, request),
				request?.signal,
			);
		},
		health: () => health(consumer),
		describeEndpoint: async () => {
			check(consumer);
			return {
				baseUrl: profile.baseUrl,
				protocol: profile.protocol,
				model: profile.model,
				dimension: profile.dimension,
				apiKeyEnv: profile.apiKeyEnv,
				queryPrefix: manifest.queryPrefix,
				passagePrefix: manifest.passagePrefix,
				backend: profile.kind,
			};
		},
		start: async (signal, onProgress) => {
			check(consumer);
			if (profile.kind === "api") return;
			if (manifest.pooling === "provider-managed") {
				const state = await health(consumer);
				if (!state.alive) throw new Error(state.detail);
				return;
			}
			await service.start(async () => (await health(consumer)).alive, signal, onProgress);
		},
		stop: () => service.stop(),
		close: () => service.close(),
		forConsumer,
	});
	return forConsumer(options.consumer ?? "local-documents");
}
