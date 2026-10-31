import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash } from "./chunker.ts";
import type { TokenCounter } from "./types.ts";

/** Loads tokenizer assets only; no source document is sent to the model hub. */
export async function loadIndexTokenizer(options: {
	root: string;
	model: string;
	tokenizerPath?: string;
	signal?: AbortSignal;
}): Promise<TokenCounter> {
	if (
		!options.tokenizerPath &&
		["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(options.model)
	) {
		const { getEncoding } = await import("js-tiktoken");
		const tokenizer = getEncoding("cl100k_base");
		return { fingerprint: "js-tiktoken-1.0.21-cl100k_base", count: (text) => tokenizer.encode(text, [], []).length };
	}
	const { Tokenizer } = await import("@huggingface/tokenizers");
	if (!options.tokenizerPath)
		throw new Error(
			`No tokenizer configured for ${options.model}; set manifest.tokenizerPath or localIndex.tokenizerPath to matching local assets`,
		);
	const directory = options.tokenizerPath;
	const load = (name: string) => readFile(join(directory, name), "utf8");
	const [json, config] = await Promise.all([load("tokenizer.json"), load("tokenizer_config.json")]);
	const tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(config));
	return {
		fingerprint: contentHash(`${json}\n${config}`),
		count: (text) => tokenizer.encode(text).ids.length,
	};
}
