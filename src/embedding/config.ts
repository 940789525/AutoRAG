import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LegacyEmbedderConfig as MinSyncEmbedderConfig } from "./legacy.ts";

export const DEFAULT_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B";
export const DEFAULT_EMBEDDING_URL = "http://127.0.0.1:18382";
export const QWEN_QUERY_PREFIX =
	"Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";
export const EMBEDDING_CONSUMERS = ["local-documents", "memory", "chat-sidecars", "gist", "native-cli"] as const;
export type EmbeddingConsumer = (typeof EMBEDDING_CONSUMERS)[number];

export interface EmbeddingManifest {
	model: string;
	dimension: number;
	revision: string;
	maxInputTokens: number;
	queryPrefix: string;
	passagePrefix: string;
	pooling: string;
	normalization: string;
	tokenizerPath?: string;
}

export interface EmbeddingProfile {
	kind: "local-http" | "api";
	protocol: "openai" | "tei";
	baseUrl: string;
	model: string;
	dimension: number;
	modelManifest?: string;
	manifest?: EmbeddingManifest;
	apiKeyEnv?: string;
	allowRemote?: boolean;
	allowedConsumers?: readonly EmbeddingConsumer[];
	batchSize?: number;
	maxConcurrent?: number;
	timeoutMs?: number;
	maxRetries?: number;
}

export interface EmbeddingConfig {
	defaultProfile: string;
	profiles: Record<string, EmbeddingProfile>;
}

export const QWEN_MANIFEST: EmbeddingManifest = {
	model: DEFAULT_EMBEDDING_MODEL,
	dimension: 1024,
	revision: "af95f2c416ffe9379369ad64f9113e865db6112c/fastembed-0.9.1/v1",
	maxInputTokens: 2048,
	queryPrefix: QWEN_QUERY_PREFIX,
	passagePrefix: "",
	pooling: "last-token",
	normalization: "l2",
};

export function defaultEmbeddingConfig(): EmbeddingConfig {
	return {
		defaultProfile: "local-qwen3",
		profiles: {
			"local-qwen3": {
				kind: "local-http",
				protocol: "openai",
				baseUrl: DEFAULT_EMBEDDING_URL,
				model: DEFAULT_EMBEDDING_MODEL,
				dimension: 1024,
				manifest: { ...QWEN_MANIFEST },
				allowedConsumers: [...EMBEDDING_CONSUMERS],
				batchSize: 4,
				maxConcurrent: 1,
				timeoutMs: 120_000,
				maxRetries: 2,
			},
		},
	};
}

export function isLoopbackEndpoint(value: string): boolean {
	return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a nonempty string`);
	return value;
}

function positive(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
	return value as number;
}

export function normalizeEmbeddingConfig(value: unknown, configPath?: string): EmbeddingConfig {
	if (value === undefined) return defaultEmbeddingConfig();
	const raw = object(value, "embedding");
	for (const key of Object.keys(raw))
		if (!["defaultProfile", "profiles"].includes(key)) throw new Error(`embedding.${key} is not recognized`);
	const defaultProfile = text(raw.defaultProfile, "embedding.defaultProfile");
	const profiles: Record<string, EmbeddingProfile> = {};
	for (const [name, entry] of Object.entries(object(raw.profiles, "embedding.profiles"))) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error(`Invalid embedding profile id: ${name}`);
		const path = `embedding.profiles.${name}`;
		const r = object(entry, path);
		const allowed = [
			"kind",
			"protocol",
			"baseUrl",
			"model",
			"dimension",
			"modelManifest",
			"manifest",
			"apiKeyEnv",
			"allowRemote",
			"allowedConsumers",
			"batchSize",
			"maxConcurrent",
			"timeoutMs",
			"maxRetries",
		];
		for (const key of Object.keys(r)) if (!allowed.includes(key)) throw new Error(`${path}.${key} is not recognized`);
		if (r.kind !== "local-http" && r.kind !== "api") throw new Error(`${path}.kind must be local-http or api`);
		if (r.protocol !== "openai" && r.protocol !== "tei") throw new Error(`${path}.protocol must be openai or tei`);
		const baseUrl = text(r.baseUrl, `${path}.baseUrl`);
		const url = new URL(baseUrl);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
			throw new Error(`${path}.baseUrl must be an HTTP server root without credentials, query or fragment`);
		if (r.kind === "local-http" && !isLoopbackEndpoint(baseUrl))
			throw new Error(`${path}: local-http must use a loopback endpoint`);
		if (r.allowRemote !== undefined && typeof r.allowRemote !== "boolean")
			throw new Error(`${path}.allowRemote must be boolean`);
		if (r.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(r.apiKeyEnv, `${path}.apiKeyEnv`)))
			throw new Error(`${path}.apiKeyEnv must name an environment variable`);
		const model = text(r.model, `${path}.model`);
		const dimension = positive(r.dimension, `${path}.dimension`);
		let manifest = r.manifest;
		let manifestPath: string | undefined;
		if (r.modelManifest !== undefined) {
			if (manifest !== undefined) throw new Error(`${path}: use modelManifest or manifest, not both`);
			manifestPath = resolve(
				configPath ? dirname(configPath) : process.cwd(),
				text(r.modelManifest, `${path}.modelManifest`),
			);
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		}
		if (manifest === undefined && r.kind === "local-http" && model === DEFAULT_EMBEDDING_MODEL && dimension === 1024)
			manifest = { ...QWEN_MANIFEST };
		const m = object(manifest, `${path}.manifest`);
		for (const key of Object.keys(m))
			if (
				![
					"model",
					"dimension",
					"revision",
					"maxInputTokens",
					"queryPrefix",
					"passagePrefix",
					"pooling",
					"normalization",
					"tokenizerPath",
				].includes(key)
			)
				throw new Error(`${path}.manifest.${key} is not recognized`);
		for (const key of ["queryPrefix", "passagePrefix"] as const)
			if (typeof m[key] !== "string") throw new Error(`${path}.manifest.${key} must be a string`);
		if (m.model !== model || m.dimension !== dimension) throw new Error(`${path}: manifest model/dimension mismatch`);
		const normalized: EmbeddingManifest = {
			model,
			dimension,
			revision: text(m.revision, `${path}.manifest.revision`),
			maxInputTokens: positive(m.maxInputTokens, `${path}.manifest.maxInputTokens`),
			queryPrefix: typeof m.queryPrefix === "string" ? m.queryPrefix : "",
			passagePrefix: typeof m.passagePrefix === "string" ? m.passagePrefix : "",
			pooling: text(m.pooling, `${path}.manifest.pooling`),
			normalization: text(m.normalization, `${path}.manifest.normalization`),
		};
		if (m.tokenizerPath !== undefined)
			normalized.tokenizerPath = resolve(
				manifestPath ? dirname(manifestPath) : configPath ? dirname(configPath) : process.cwd(),
				text(m.tokenizerPath, `${path}.manifest.tokenizerPath`),
			);
		const consumers = r.allowedConsumers ?? (r.kind === "local-http" ? EMBEDDING_CONSUMERS : []);
		if (!Array.isArray(consumers) || consumers.some((c) => !EMBEDDING_CONSUMERS.includes(c)))
			throw new Error(`${path}.allowedConsumers must contain explicit supported consumer ids`);
		const p: EmbeddingProfile = {
			kind: r.kind,
			protocol: r.protocol,
			baseUrl,
			model,
			dimension,
			manifest: normalized,
			allowedConsumers: [...consumers],
			allowRemote: r.allowRemote === true,
		};
		if (r.apiKeyEnv !== undefined) p.apiKeyEnv = r.apiKeyEnv as string;
		for (const key of ["batchSize", "maxConcurrent", "timeoutMs"] as const)
			if (r[key] !== undefined) p[key] = positive(r[key], `${path}.${key}`);
		if (p.maxConcurrent !== undefined && p.maxConcurrent !== 1)
			throw new Error(`${path}.maxConcurrent: only 1 is supported in this release`);
		if (r.maxRetries !== undefined) {
			if (!Number.isInteger(r.maxRetries) || (r.maxRetries as number) < 0 || (r.maxRetries as number) > 5)
				throw new Error(`${path}.maxRetries must be between 0 and 5`);
			p.maxRetries = r.maxRetries as number;
		}
		profiles[name] = p;
	}
	if (!Object.hasOwn(profiles, defaultProfile))
		throw new Error(`embedding.defaultProfile ${defaultProfile} is not configured`);
	return { defaultProfile, profiles };
}

export function embeddingFingerprint(profile: EmbeddingProfile): string {
	const m = profile.manifest ?? QWEN_MANIFEST;
	return createHash("sha256")
		.update(
			JSON.stringify([
				profile.kind,
				profile.protocol,
				m.model,
				m.dimension,
				m.revision,
				m.maxInputTokens,
				m.queryPrefix,
				m.passagePrefix,
				m.pooling,
				m.normalization,
			]),
		)
		.digest("hex");
}

/** Old endpoint settings never imply permission to send corpus text remotely. */
export function embeddingConfigFromLegacy(legacy: MinSyncEmbedderConfig | undefined): EmbeddingConfig {
	if (!legacy?.id || legacy.id.startsWith("native:")) {
		if (legacy?.id && legacy.id !== `native:${DEFAULT_EMBEDDING_MODEL}`)
			throw new Error(`Legacy local model ${legacy.id} is unsupported; configure an explicit embedding profile`);
		const config = defaultEmbeddingConfig();
		if (legacy?.queryPrefix !== undefined)
			config.profiles[config.defaultProfile].manifest!.queryPrefix = legacy.queryPrefix;
		if (legacy?.passagePrefix !== undefined)
			config.profiles[config.defaultProfile].manifest!.passagePrefix = legacy.passagePrefix;
		return config;
	}
	const i = legacy.id.indexOf(":");
	const model = i < 0 ? legacy.id : legacy.id.slice(i + 1);
	const baseUrl = legacy.baseUrl ?? "https://api.openai.com";
	const local = isLoopbackEndpoint(baseUrl);
	if (!legacy.dimension)
		throw new Error(
			"Legacy endpoint dimension is required; configure an explicit embedding profile with a matching manifest",
		);
	const manifest: EmbeddingManifest = {
		model,
		dimension: legacy.dimension,
		revision: "legacy-endpoint-v1",
		maxInputTokens: 2048,
		queryPrefix: legacy.queryPrefix ?? "",
		passagePrefix: legacy.passagePrefix ?? "",
		pooling: "provider-managed",
		normalization: "provider-managed",
	};
	return normalizeEmbeddingConfig({
		defaultProfile: "legacy-endpoint",
		profiles: {
			"legacy-endpoint": {
				kind: local ? "local-http" : "api",
				protocol: legacy.id.startsWith("tei:") ? "tei" : "openai",
				baseUrl,
				model,
				dimension: manifest.dimension,
				manifest,
				apiKeyEnv: legacy.apiKeyEnv,
				allowedConsumers: local ? EMBEDDING_CONSUMERS : [],
				allowRemote: false,
				batchSize: legacy.batchSize,
				timeoutMs: legacy.timeoutMs,
				maxRetries: legacy.maxRetries,
			},
		},
	});
}
