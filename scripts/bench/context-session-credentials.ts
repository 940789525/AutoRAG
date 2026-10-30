import assert from "node:assert/strict";
import type { CredentialStore } from "@earendil-works/pi-ai";

export function readOnlyCodexCredentials(value: { access: string; expiresAt: number }): CredentialStore {
	const credential = {
		type: "oauth" as const,
		access: value.access,
		expires: value.expiresAt,
		refresh: "read-only-refresh-disabled",
	};
	return {
		read: async (provider) => (provider === "openai-codex" ? { ...credential } : undefined),
		list: async () => [{ providerId: "openai-codex", type: "oauth" }],
		modify: async () => {
			throw new Error("Read-only experiment credentials cannot be refreshed or written");
		},
		delete: async () => {
			throw new Error("Read-only experiment credentials cannot be deleted");
		},
	};
}

export function parseReadOnlyCredential(text: string): { access: string; expiresAt: number; sourceHash: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid read-only credential JSON");
	}
	assert(value && typeof value === "object" && !Array.isArray(value), "Invalid read-only credential envelope");
	const record = value as Record<string, unknown>;
	assert(
		Object.keys(record).length === 3 &&
			Object.keys(record).every((key) => ["access", "expiresAt", "sourceHash"].includes(key)),
		"Unexpected credential fields; refresh credentials are not accepted",
	);
	assert(typeof record.access === "string" && record.access.length > 0, "Missing read-only access token");
	assert(
		typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt > Date.now(),
		"Read-only credential expired",
	);
	assert(
		typeof record.sourceHash === "string" && /^[a-f0-9]{64}$/u.test(record.sourceHash),
		"Invalid credential source fingerprint",
	);
	return { access: record.access, expiresAt: record.expiresAt, sourceHash: record.sourceHash };
}
