import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPath } from "../../src/cli/config.ts";

describe("test configuration isolation", () => {
	it("discards inherited AutoRAG overrides and resolves config inside the temporary home", () => {
		expect(process.env.AUTORAG_CONFIG).toBeUndefined();
		expect(process.env.AUTORAG_HOME).toBeUndefined();
		const home = process.env.HOME!;
		expect(existsSync(home)).toBe(true);
		const location = relative(tmpdir(), home);
		expect(isAbsolute(location) || location.startsWith("..")).toBe(false);
		const resolved = resolveConfigPath({ flags: {} });
		expect(resolved.configPath).toBe(join(home, ".autorag", "config.json"));
		expect(resolved.explicit).toBe(false);
	});
});
