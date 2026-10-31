import { afterEach, describe, expect, it } from "vitest";
import {
	createEmbedderFromConfig,
	defaultEmbeddingConfig,
	ProfileEmbedder,
	QWEN_MANIFEST,
	releaseEmbedders,
} from "../../src/embedding/index.ts";

afterEach(() => releaseEmbedders());
describe("embedding profiles factory", () => {
	it("defaults to FastEmbed Qwen without loading MinSync or starting a process", async () => {
		const e = createEmbedderFromConfig({ home: "/nonexistent-old-minsync-home" });
		expect(e).toBeInstanceOf(ProfileEmbedder);
		expect(await e.identity()).toMatchObject({
			provider: "fastembed",
			model: "Qwen/Qwen3-Embedding-0.6B",
			dimension: 1024,
		});
		expect(await e.describeEndpoint()).toMatchObject({
			backend: "local-http",
			queryPrefix: QWEN_MANIFEST.queryPrefix,
		});
	});
	it("rejects conflicting old and new configuration", () => {
		expect(() =>
			createEmbedderFromConfig({
				embedding: defaultEmbeddingConfig(),
				embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B" },
			}),
		).toThrow(/Conflicting/);
	});
	it("does not silently choose Qwen for a different legacy local model", () => {
		expect(() => createEmbedderFromConfig({ embedder: { id: "native:other/model" } })).toThrow(/unsupported/);
	});
	it("a legacy remote endpoint does not grant remote sending permission", async () => {
		const e = createEmbedderFromConfig({
			embedder: { id: "openai:legacy", baseUrl: "https://example.com", dimension: 3 },
		});
		await expect(e.embed(["private fixture"])).rejects.toThrow(/Remote embedding is disabled/);
	});
});
