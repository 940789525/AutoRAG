import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentOptions, resolveConfigReadOnly } from "../../src/cli/config.ts";

const roots: string[] = [];
function config(value?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "autorag-selection-config-"));
	roots.push(root);
	const path = join(root, "config.json");
	writeFileSync(path, JSON.stringify({ workspacePath: root, searchPaths: [root], contextSelection: value }));
	return { root, path };
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("trusted context selection config", () => {
	it("leaves the default disabled and passes explicit policy to the agent", () => {
		const f = config();
		expect(buildAgentOptions(resolveConfigReadOnly({ flags: { config: f.path } })).contextSelection).toBeUndefined();
		const g = config({ mode: "adaptive", evidenceBudgetTokens: 400 });
		expect(buildAgentOptions(resolveConfigReadOnly({ flags: { config: g.path } })).contextSelection).toEqual({
			mode: "adaptive",
			evidenceBudgetTokens: 400,
		});
	});
	it.each([
		{ mode: "aggressive" },
		{ evidenceBudgetTokens: -1 },
		{ mode: { value: "adaptive" } },
		{ allowRemote: true },
	])("rejects invalid policy %j", (value) => {
		const f = config(value);
		expect(() => resolveConfigReadOnly({ flags: { config: f.path } })).toThrow(/contextSelection/);
	});
	it("does not allow tool-like flags to override the trusted file", () => {
		const f = config({ mode: "off" });
		const resolved = resolveConfigReadOnly({ flags: { config: f.path, "context-selection": "adaptive" } });
		expect(resolved.contextSelection?.mode).toBe("off");
	});
});
