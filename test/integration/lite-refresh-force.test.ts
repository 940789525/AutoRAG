import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { nativeIndexFixture } from "../helpers/native-index.ts";

describe("model-free full refresh", () => {
	it("rebuilds chunk metadata on force while reusing valid document embeddings", async () => {
		const root = mkdtempSync(join(tmpdir(), "autorag-force-native-"));
		try {
			const docs = join(root, "docs");
			mkdirSync(docs);
			writeFileSync(join(docs, "note.md"), "Force refresh fixture");
			const agent = new AutoRAGAgent({
				...nativeIndexFixture(),
				searchPaths: [docs],
				workspacePath: root,
				memoryPath: join(root, "memory.json"),
				jikji: false,
				everything: false,
				fsearch: false,
				excludeExactDuplicates: false,
			});
			const first = await agent.refresh(false, { methods: ["minsync"] });
			const warm = await agent.refresh(false, { methods: ["minsync"] });
			const forced = await agent.refresh(true, { methods: ["minsync"] });
			expect(first.minsync?.report?.embedded).toBe(1);
			expect(warm.minsync?.report?.unchanged).toBe(1);
			expect(forced.minsync?.report).toMatchObject({ unchanged: 0, embedded: 0, reused: 1 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
