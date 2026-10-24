import type { LocalIndexOptions } from "./types.ts";

export type LocalIndexConfig = Pick<
	LocalIndexOptions,
	| "tokenizerPath"
	| "koreanModelPath"
	| "targetTokens"
	| "maxTokens"
	| "maxInputTokens"
	| "batchSize"
	| "maxBatchTokens"
	| "debug"
	| "embeddingFingerprint"
>;

export function normalizeLocalIndex(value: unknown): LocalIndexConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("localIndex must be an object");
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (["targetTokens", "maxTokens", "maxInputTokens", "batchSize", "maxBatchTokens"].includes(key)) {
			if (!Number.isInteger(item) || (item as number) < 1)
				throw new Error(`localIndex.${key} must be a positive integer`);
		} else if (["tokenizerPath", "koreanModelPath", "embeddingFingerprint"].includes(key)) {
			if (typeof item !== "string" || !item.trim()) throw new Error(`localIndex.${key} must be a nonempty string`);
		} else if (key === "debug") {
			if (typeof item !== "boolean") throw new Error("localIndex.debug must be a boolean");
		} else throw new Error(`localIndex.${key} is not a recognized field`);
		output[key] = item;
	}
	const config = output as LocalIndexConfig;
	if (
		(config.maxTokens ?? 768) < 32 ||
		(config.targetTokens ?? Math.min(512, config.maxTokens ?? 768)) > (config.maxTokens ?? 768)
	) {
		throw new Error("localIndex token budgets must satisfy targetTokens <= maxTokens and maxTokens >= 32");
	}
	return config;
}
