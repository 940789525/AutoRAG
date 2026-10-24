import type { AutoRAGAgentOptions } from "../../src/agent/agent.ts";
import type { ManagedEmbedder } from "../../src/embedding/embedder.ts";

/** A deterministic embedding boundary; integration tests still use the real indexing/database code. */
export function createTestEmbedder(): ManagedEmbedder {
	return {
		identity: async () => ({ provider: "fixture", model: "native-index-fixture", dimension: 4 }),
		embed: async (texts, options) => {
			options?.signal?.throwIfAborted();
			return texts.map((text) => [
				1,
				/refund|approval/i.test(text) ? 1 : 0,
				/policy|retention/i.test(text) ? 1 : 0,
				/chargeback|receipt/i.test(text) ? 1 : 0,
			]);
		},
		health: async () => ({ backend: "in-process", alive: true }),
		describeEndpoint: async () => undefined,
		close: async () => {},
	};
}

export function nativeIndexFixture(): Pick<AutoRAGAgentOptions, "embedder" | "localIndex"> {
	return {
		embedder: createTestEmbedder(),
		localIndex: {
			tokenizer: { fingerprint: "fixture-unicode-v1", count: (text) => Array.from(text).length },
			analyzer: {
				fingerprint: "fixture-words-v1",
				analyze: async (text, signal) => {
					signal?.throwIfAborted();
					return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
				},
			},
		},
	};
}
