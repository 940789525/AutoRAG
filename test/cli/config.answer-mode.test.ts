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

describe("retrieval policy", () => {
	it.each(["observe", "enforce", "unrecognized"])(
		"does not silently accept an unavailable local filter: %s",
		(mode) => {
			const path = join(root, "config.json");
			writeFileSync(path, JSON.stringify({ retrievalPolicy: "on-demand", localEvidenceFilter: { mode } }));
			expect(() => resolveConfig({ flags: { config: path }, cwd: root })).toThrow(/has not passed calibration/);
		},
	);
	it("accepts an explicit rollback without reading the inactive calibration path", () => {
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify({ localEvidenceFilter: { mode: "off", calibrationPath: "absent" } }));
		expect(buildAgentOptions(resolveConfig({ flags: { config: path }, cwd: root })).localEvidenceFilter?.mode).toBe(
			"off",
		);
	});
	it.each([undefined, "legacy", "on-demand"])("passes %s from trusted config to the agent", (policy) => {
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify({ retrievalPolicy: policy }));
		const conf = resolveConfig({
			flags: { config: path, "retrieval-policy": "on-demand" },
			env: { HOME: root },
			cwd: root,
		});
		expect(buildAgentOptions(conf).retrievalPolicy).toBe(policy ?? "legacy");
	});
	it.each(["auto", false, null])("rejects invalid retrieval policy %j", (value) => {
		const path = join(root, "config.json");
		writeFileSync(path, JSON.stringify({ retrievalPolicy: value }));
		expect(() => resolveConfig({ flags: { config: path }, cwd: root })).toThrow(/retrievalPolicy/);
	});
});
