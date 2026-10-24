import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "vitest";
import { createHttpEmbedder } from "../../src/embedding/http-embedder.ts";

describe("embedding request cancellation", () => {
	it("aborts an actual loopback embedding request with the caller's reason", async () => {
		let received!: () => void;
		const arrived = new Promise<void>((resolve) => {
			received = resolve;
		});
		const server = createServer(() => received());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert(address && typeof address !== "string");
			const embedder = createHttpEmbedder({
				protocol: "openai",
				provider: "fixture",
				model: "fixture",
				dimension: 2,
				baseUrl: `http://127.0.0.1:${address.port}`,
				timeoutMs: 5_000,
			});
			const controller = new AbortController();
			const reason = new Error("operator stopped indexing");
			const request = embedder.embed(["fixture text"], { role: "document", signal: controller.signal });
			const rejected = assert.rejects(request, (error) => error === reason);
			await arrived;
			controller.abort(reason);
			await rejected;
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
