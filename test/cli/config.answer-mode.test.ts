import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentOptions, ConfigError, resolveConfig } from "../../src/cli/config.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "autorag-answer-mode-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function resolve(answerMode?: unknown) {
	const path = join(root, "config.json");
	writeFileSync(path, JSON.stringify(answerMode === undefined ? {} : { answerMode }));
	return resolveConfig({ flags: { config: path }, env: { HOME: root }, cwd: root });
}

describe("answer delivery mode", () => {
	it("defaults file and library options to one complete answer", () => {
		const config = resolve();
		expect(config.answerMode).toBe("single");
		expect(buildAgentOptions(config).answerMode).toBe("single");
	});
	it.each(["single", "progressive"] as const)("passes explicit %s mode to the agent", (mode) => {
		expect(buildAgentOptions(resolve(mode)).answerMode).toBe(mode);
	});
	it.each(["fast", "", false, 2, {}, null])("rejects invalid mode %j", (mode) => {
		expect(() => resolve(mode)).toThrow(ConfigError);
		expect(() => resolve(mode)).toThrow(/answerMode/);
	});
});
