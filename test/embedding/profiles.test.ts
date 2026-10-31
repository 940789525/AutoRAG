import { describe, expect, it } from "vitest";
import { isIndexOperationInput, parseIndexCommand } from "../../src/agent/index-controls.ts";
import { defaultEmbeddingConfig, embeddingFingerprint, normalizeEmbeddingConfig } from "../../src/embedding/config.ts";

describe("trusted embedding configuration", () => {
	it("keeps fingerprints stable when only the port changes", () => {
		const p = defaultEmbeddingConfig().profiles["local-qwen3"];
		expect(embeddingFingerprint(p)).toBe(embeddingFingerprint({ ...p, baseUrl: "http://127.0.0.1:12" }));
		expect(embeddingFingerprint(p)).not.toBe(
			embeddingFingerprint({ ...p, manifest: { ...p.manifest!, queryPrefix: "different" } }),
		);
	});
	it("rejects a non-loopback local backend", () => {
		const c = defaultEmbeddingConfig();
		c.profiles["local-qwen3"].baseUrl = "https://example.com";
		expect(() => normalizeEmbeddingConfig(c)).toThrow(/loopback/);
	});
	it("rejects credentials in URLs and unknown config fields", () => {
		const c = defaultEmbeddingConfig();
		c.profiles["local-qwen3"].baseUrl = "http://user:password@localhost";
		expect(() => normalizeEmbeddingConfig(c)).toThrow(/credentials/);
		expect(() => normalizeEmbeddingConfig({ ...defaultEmbeddingConfig(), apiKey: "fixture" })).toThrow(
			/not recognized/,
		);
	});
	it("rejects a manifest dimension mismatch", () => {
		const c = defaultEmbeddingConfig();
		c.profiles["local-qwen3"].dimension = 4;
		expect(() => normalizeEmbeddingConfig(c)).toThrow(/mismatch/);
	});
	it("does not silently ignore unsupported concurrency", () => {
		const c = defaultEmbeddingConfig();
		c.profiles["local-qwen3"].maxConcurrent = 2;
		expect(() => normalizeEmbeddingConfig(c)).toThrow(/only 1/);
	});
});
describe("TUI index entry", () => {
	it("parses explicit profiles and rejects unknown flags", () => {
		expect(parseIndexCommand("build --embedding local-qwen3")).toEqual({
			operation: "build",
			embeddingProfile: "local-qwen3",
		});
		expect(parseIndexCommand("cancel --job abc")).toEqual({ operation: "cancel", jobId: "abc" });
		expect(() => parseIndexCommand("build --embedding")).toThrow(/Missing/);
		expect(() => parseIndexCommand("build --url https://example.com")).toThrow(/Unsupported/);
	});
	it("routes indexing operations before retrieval without routing ordinary search", () => {
		expect(isIndexOperationInput("用本地 Qwen 模型给已配置的文档目录建立索引")).toBe(true);
		expect(isIndexOperationInput("查看索引进度")).toBe(true);
		expect(isIndexOperationInput("Who approves refunds?")).toBe(false);
	});
});
