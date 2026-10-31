import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createEmbeddingControls,
	EMBEDDING_STATUS_KEY,
	EMBEDDING_TOGGLE_KEY,
	embeddingStatusText,
} from "../../src/agent/embedding-controls.ts";
import type { ManagedEmbedder } from "../../src/embedding/embedder.ts";

/** The part of pi's registered command the tests drive. */
interface RegisteredCommandShape {
	readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	readonly getArgumentCompletions?: (
		prefix: string,
	) => { value: string }[] | null | Promise<{ value: string }[] | null>;
}

interface Harness {
	readonly statuses: (string | undefined)[];
	readonly notes: { readonly message: string; readonly type: string | undefined }[];
	readonly fire: (event: "session_start" | "session_shutdown") => void;
	readonly press: () => Promise<void>;
	readonly run: (args: string) => Promise<void>;
	readonly complete: (prefix: string) => Promise<{ value: string }[] | null>;
	readonly shortcuts: string[];
}

/** A pi that records what the extension registers and lets the test drive its events and its key. */
function install(embedder: ManagedEmbedder, options: { remote: boolean; isIndexing?: () => boolean }): Harness {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	let command: RegisteredCommandShape | undefined;
	const shortcuts: string[] = [];
	const statuses: (string | undefined)[] = [];
	const notes: { message: string; type: string | undefined }[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			notify: (message: string, type?: string) => notes.push({ message, type }),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		registerShortcut: (key: string, registration: { handler: (ctx: ExtensionContext) => Promise<void> }) => {
			shortcuts.push(key);
			shortcut = registration.handler;
		},
		registerCommand: (name: string, registration: RegisteredCommandShape) => {
			if (name === "embedding") command = registration;
		},
	} as unknown as ExtensionAPI;
	createEmbeddingControls({ embedder, ...options })(pi);
	return {
		statuses,
		notes,
		shortcuts,
		fire: (event) => handlers.get(event)?.({}, ctx),
		press: async () => shortcut?.(ctx),
		run: async (args) => command?.handler(args, ctx),
		complete: async (prefix) => (await command?.getArgumentCompletions?.(prefix)) ?? null,
	};
}

function local() {
	let running = false;
	const start = vi.fn(async () => {
		running = true;
	});
	const stop = vi.fn(async () => {
		if (!running)
			throw new Error("Embedding service is externally managed or already stopped; no process was stopped");
		running = false;
	});
	const embedder: ManagedEmbedder = {
		identity: async () => ({ provider: "fastembed", model: "qwen", dimension: 1024 }),
		embed: async () => [],
		health: async () => (running ? { backend: "local-http", alive: true } : { backend: "none", alive: false }),
		describeEndpoint: async () => undefined,
		close: async () => {},
		start,
		stop,
	};
	return { embedder, start, stop };
}
describe("FastEmbed TUI lifecycle", () => {
	it("shows readiness and the service start key", () => {
		expect(embeddingStatusText({ backend: "local-http", alive: true })).toBe("embedding: FastEmbed ● up");
		expect(embeddingStatusText({ backend: "api", alive: true })).toBe("embedding: remote ● up");
		expect(embeddingStatusText({ backend: "none", alive: false })).toContain("starts FastEmbed");
		expect(EMBEDDING_STATUS_KEY).toBe("autorag-embedding");
	});
	it("starts and stops only through the managed service controller", async () => {
		const { embedder, start, stop } = local();
		const h = install(embedder, { remote: false });
		expect(h.shortcuts).toEqual([EMBEDDING_TOGGLE_KEY]);
		await h.press();
		expect(start).toHaveBeenCalledOnce();
		expect(h.statuses.at(-1)).toBe("embedding: FastEmbed ● up");
		await h.press();
		expect(stop).toHaveBeenCalledOnce();
		expect(h.notes.at(-1)?.message).toContain("Stopped this session");
	});
	it("keeps on idempotent and refuses to stop an external process", async () => {
		const { embedder, start } = local();
		const h = install(embedder, { remote: false });
		await h.run("off");
		expect(h.notes.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("externally managed") });
		await h.run("on");
		await h.run("on");
		expect(start).toHaveBeenCalledOnce();
	});
	it("never starts, stops or authorizes an API from the toggle", async () => {
		const { embedder, start, stop } = local();
		const h = install(embedder, { remote: true });
		await h.run("on");
		await h.press();
		expect(start).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(h.notes.at(-1)?.message).toContain("remote endpoint");
	});
	it("preserves startup diagnostics and rejects lifecycle changes during indexing", async () => {
		const { embedder, start } = local();
		start.mockRejectedValue(new Error("missing model at /fixture/qwen"));
		const h = install(embedder, { remote: false });
		await h.run("on");
		expect(h.notes.at(-1)?.message).toBe("missing model at /fixture/qwen");
		const busy = install(embedder, { remote: false, isIndexing: () => true });
		await busy.run("on");
		expect(busy.notes.at(-1)?.message).toContain("index task is active");
		expect(start).toHaveBeenCalledOnce();
	});
	it("supports status and completion without starting a service", async () => {
		const { embedder, start } = local();
		const h = install(embedder, { remote: false });
		await h.run("status");
		expect(start).not.toHaveBeenCalled();
		expect(h.notes.at(-1)?.message).toContain("/embedding on");
		expect((await h.complete("o"))?.map((v) => v.value)).toEqual(["on", "off"]);
		await h.run("restart");
		expect(h.notes.at(-1)?.type).toBe("warning");
	});
	it("drops in-flight probes and polling after session shutdown", async () => {
		vi.useFakeTimers();
		try {
			const { embedder } = local();
			let release!: (v: { backend: "none"; alive: false }) => void;
			const probe = vi.fn(
				() =>
					new Promise<{ backend: "none"; alive: false }>((r) => {
						release = r;
					}),
			);
			embedder.health = probe;
			const h = install(embedder, { remote: false });
			h.fire("session_start");
			h.fire("session_shutdown");
			release({ backend: "none", alive: false });
			await vi.advanceTimersByTimeAsync(60000);
			expect(h.statuses).toEqual([]);
			expect(probe).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
