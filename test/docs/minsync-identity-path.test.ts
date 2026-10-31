import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("embedding migration documentation", () => {
	it("retains legacy data and points operators to the active implementation", () => {
		const old = readFileSync("docs/minsync-setup.md", "utf8");
		const current = readFileSync("docs/embedding-setup.md", "utf8");
		expect(old).toContain("embedding-setup.md");
		expect(old).toContain("~/.cache/minsync/models");
		expect(current).toContain(".autorag/local-index");
		expect(current).toContain("--offline");
		expect(current).toContain("--require-hashes");
		expect(current).not.toContain("cargo install minsync");
	});
});
