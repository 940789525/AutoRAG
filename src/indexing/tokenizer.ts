import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
	const directory =
		options.tokenizerPath ?? join(options.root, ".autorag", "models", "tokenizers", contentHash(options.model));
	const load = async (name: string): Promise<string> => {
		try {
			return await readFile(join(directory, name), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.tokenizerPath) throw error;
		}
		if (!/^[\w.-]+\/[\w.-]+$/.test(options.model)) {
			throw new Error(
				`No tokenizer configured for ${options.model}; set localIndex.tokenizerPath to matching tokenizer assets`,
			);
		}
		const response = await fetch(`https://huggingface.co/${options.model}/resolve/main/${name}`, {
			signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]),
		});
		if (!response.ok)
			throw new Error(
				`tokenizer download ${options.model}/${name}: HTTP ${response.status}: ${await response.text()}`,
			);
		const text = await response.text();
		JSON.parse(text);
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
		await writeFile(temporary, text, "utf8");
		await rename(temporary, join(directory, name));
		return text;
	};
	const [json, config] = await Promise.all([load("tokenizer.json"), load("tokenizer_config.json")]);
	const tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(config));
	return {
		fingerprint: contentHash(`${json}\n${config}`),
		count: (text) => tokenizer.encode(text).ids.length,
	};
}
