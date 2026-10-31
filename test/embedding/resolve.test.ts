import { describe, expect, it, vi } from "vitest";
import { defaultEmbeddingConfig, QWEN_MANIFEST } from "../../src/embedding/config.ts";
import { createManagedEmbedder } from "../../src/embedding/managed.ts";

function local(fetchImpl: typeof fetch) {
	return createManagedEmbedder({ profile: defaultEmbeddingConfig().profiles["local-qwen3"], fetchImpl });
}
function info(overrides: Record<string, unknown> = {}) {
	return {
		ready: true,
		model: QWEN_MANIFEST.model,
		dimension: 1024,
		revision: QWEN_MANIFEST.revision,
		maxInputTokens: 2048,
		prefixOwner: "client",
		pooling: "last-token",
		normalization: "l2",
		...overrides,
	};
}
describe("HTTP managed embeddings", () => {
	it("health is a read-only readiness probe and never falls back to an addon", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fixture connection refused"));
		const e = local(fetchImpl);
		expect(await e.health()).toMatchObject({ backend: "none", alive: false, detail: "fixture connection refused" });
		await expect(e.embed(["x"])).rejects.toThrow("fixture connection refused");
		expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith("/health"))).toBe(true);
	});
	it.each([
		{ revision: "different" },
		{ dimension: 3 },
		{ ready: false },
		{ prefixOwner: "server" },
		{ maxInputTokens: 128 },
	])("rejects incompatible service identity %o", async (bad) => {
		const e = local(vi.fn(async () => Response.json(info(bad))));
		expect(await e.health()).toMatchObject({ alive: false });
		await expect(e.embed(["x"])).rejects.toThrow(/identity mismatch/);
	});
	it("applies the query prompt exactly once and keeps passages raw", async () => {
		const inputs: string[][] = [];
		const e = local(
			vi.fn(async (url, init) => {
				if (String(url).endsWith("/health")) return Response.json(info());
				const body = JSON.parse(init!.body as string);
				inputs.push(body.input);
				return Response.json({
					model: QWEN_MANIFEST.model,
					data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1024).fill(0.01) })),
				});
			}),
		);
		await e.embed(["question"], { role: "query" });
		await e.embed(["passage"]);
		expect(inputs).toEqual([[QWEN_MANIFEST.queryPrefix + "question"], ["passage"]]);
	});
	it("authorizes each remote consumer before any HTTP request", async () => {
		const fetchImpl = vi.fn();
		const p = defaultEmbeddingConfig().profiles["local-qwen3"];
		const e = createManagedEmbedder({
			profile: {
				...p,
				kind: "api",
				baseUrl: "https://example.com",
				allowRemote: true,
				allowedConsumers: ["local-documents"],
			},
			fetchImpl,
		});
		await expect(e.forConsumer!("memory").embed(["private"])).rejects.toThrow(/authorize consumer memory/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("missing API credentials fail before any request", async () => {
		const fetchImpl = vi.fn();
		const p = defaultEmbeddingConfig().profiles["local-qwen3"];
		const e = createManagedEmbedder({
			profile: { ...p, kind: "api", allowRemote: true, apiKeyEnv: "FIXTURE_API_KEY" },
			env: {},
			fetchImpl,
		});
		await expect(e.embed(["private"])).rejects.toThrow(/FIXTURE_API_KEY/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("a reachable 404 health endpoint is not model readiness", async () => {
		expect(
			await local(vi.fn().mockResolvedValue(new Response("fixture no health", { status: 404 }))).health(),
		).toMatchObject({ alive: false, detail: expect.stringContaining("404") });
	});
});
