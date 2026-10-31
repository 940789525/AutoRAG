import { describe, expect, it, vi } from "vitest";
import { defaultEmbeddingConfig } from "../../src/embedding/config.ts";
import { createHttpEmbedder } from "../../src/embedding/http-embedder.ts";
import { createManagedEmbedder } from "../../src/embedding/managed.ts";

const options = {
	baseUrl: "http://127.0.0.1:1",
	protocol: "openai" as const,
	provider: "fixture",
	model: "fixture",
	dimension: 2,
};
describe("HTTP embedding integrity", () => {
	it.each([
		{ data: [{ index: 0, embedding: [0, 0] }] },
		{ data: [{ index: 0, embedding: [1] }] },
		{ data: [{ index: 0, embedding: [null, 1] }] },
		{ data: [{ index: 1, embedding: [1, 1] }] },
		{ model: "wrong", data: [{ index: 0, embedding: [1, 1] }] },
		{ data: [] },
	])("rejects an unusable response before it reaches a store", async (body) => {
		const e = createHttpEmbedder({ ...options, fetchImpl: vi.fn(async () => Response.json(body)) });
		await expect(e.embed(["fixture"])).rejects.toThrow();
	});
	it("rejects duplicate indices and accepts a valid out-of-order response", async () => {
		const body = {
			data: [
				{ index: 0, embedding: [1, 1] },
				{ index: 0, embedding: [2, 2] },
			],
		};
		const e = createHttpEmbedder({ ...options, fetchImpl: vi.fn(async () => Response.json(body)) });
		await expect(e.embed(["a", "b"])).rejects.toThrow();
		const sorted = createHttpEmbedder({
			...options,
			fetchImpl: vi.fn(async () =>
				Response.json({
					data: [
						{ index: 1, embedding: [2, 2] },
						{ index: 0, embedding: [1, 1] },
					],
				}),
			),
		});
		expect(await sorted.embed(["a", "b"])).toEqual([
			[1, 1],
			[2, 2],
		]);
	});
	it("honors retry bounds and never retries authentication errors", async () => {
		const flaky = vi.fn(
			async () => new Response("fixture provider overloaded", { status: 503, headers: { "Retry-After": "0" } }),
		);
		await expect(
			createHttpEmbedder({ ...options, maxRetries: 1, fetchImpl: flaky }).embed(["fixture"]),
		).rejects.toThrow("fixture provider overloaded");
		expect(flaky).toHaveBeenCalledTimes(2);
		const denied = vi.fn(async () => new Response("fixture authentication failed", { status: 401 }));
		await expect(
			createHttpEmbedder({ ...options, maxRetries: 3, fetchImpl: denied }).embed(["fixture"]),
		).rejects.toThrow("fixture authentication failed");
		expect(denied).toHaveBeenCalledOnce();
	});
	it("cancels queued work without issuing another API request", async () => {
		const profile = defaultEmbeddingConfig().profiles["local-qwen3"];
		profile.kind = "api";
		profile.allowRemote = true;
		profile.allowedConsumers = ["local-documents", "memory"];
		let finish!: (r: Response) => void;
		const calls = vi.fn(
			() =>
				new Promise<Response>((r) => {
					finish = r;
				}),
		);
		const e = createManagedEmbedder({ profile, fetchImpl: calls });
		const first = e.embed(["first"]);
		await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce());
		const controller = new AbortController();
		const second = e.forConsumer!("memory").embed(["second"], { signal: controller.signal });
		controller.abort(new Error("fixture cancellation"));
		await expect(second).rejects.toThrow("fixture cancellation");
		expect(calls).toHaveBeenCalledOnce();
		finish(Response.json({ model: profile.model, data: [{ index: 0, embedding: Array(1024).fill(1) }] }));
		await first;
		await Promise.resolve();
		expect(calls).toHaveBeenCalledOnce();
	});
});
