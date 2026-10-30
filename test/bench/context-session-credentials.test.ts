import { describe, expect, it } from "vitest";
import { parseReadOnlyCredential, readOnlyCodexCredentials } from "../../scripts/bench/context-session-credentials.ts";

describe("read-only experiment credential transport", () => {
	const envelope = () => ({
		access: "synthetic-test-access",
		expiresAt: Date.now() + 60_000,
		sourceHash: "a".repeat(64),
	});
	it("accepts an existing unexpired in-memory access token with a source fingerprint", () => {
		const value = envelope();
		expect(parseReadOnlyCredential(JSON.stringify(value))).toEqual(value);
	});
	it("exposes only copied OAuth credentials and refuses writes or refreshes", async () => {
		const store = readOnlyCodexCredentials(envelope());
		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(await store.read("deepseek")).toBeUndefined();
		const first = await store.read("openai-codex");
		expect(first?.type).toBe("oauth");
		expect(await store.read("openai-codex")).not.toBe(first);
		await expect(store.modify("openai-codex", async () => undefined)).rejects.toThrow(
			"cannot be refreshed or written",
		);
		await expect(store.delete("openai-codex")).rejects.toThrow("cannot be deleted");
	});
	it("rejects refresh tokens, expired access and malformed fingerprints", () => {
		for (const value of [
			{ ...envelope(), refresh: "never-forward-this" },
			{ ...envelope(), expiresAt: 0 },
			{ ...envelope(), sourceHash: "not-a-hash" },
		])
			expect(() => parseReadOnlyCredential(JSON.stringify(value))).toThrow();
	});
	it("does not echo malformed credential contents in parsing errors", () => {
		try {
			parseReadOnlyCredential('{"access":"synthetic-secret"');
		} catch (error) {
			expect(String(error)).not.toContain("synthetic-secret");
			expect(String(error)).toContain("Invalid read-only credential JSON");
		}
	});
});
