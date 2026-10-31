import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EmbedderHealth, ManagedEmbedder } from "../embedding/embedder.ts";

/** The footer and notifications of one pi session; writes after that session is replaced are dropped. */
interface SessionFooter {
	setStatus(text: string | undefined): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

/** Footer slot of the embedding indicator. */
export const EMBEDDING_STATUS_KEY = "autorag-embedding";
/** Toggles the session-owned local FastEmbed service. Not bound by pi, pi-tui or AutoRAG's own interrupt/follow-up keys. */
export const EMBEDDING_TOGGLE_KEY = "ctrl+shift+e";
const POLL_INTERVAL_MS = 15_000;

/** What `/embedding` accepts. `toggle` is also what the key does. */
const EMBEDDING_ACTIONS = ["on", "off", "toggle", "status"] as const;
type EmbeddingAction = (typeof EMBEDDING_ACTIONS)[number];

/** A sentence for `/embedding status`; the footer carries the short form. */
function describeHealth(health: EmbedderHealth): string {
	if (health.alive)
		return `Embedding backend: ${health.backend}${health.detail === undefined ? "" : ` (${health.detail})`}.`;
	return `No embedding backend is alive${health.detail === undefined ? "" : `: ${health.detail}`}. Run /embedding on, or configure an authorized embedding API profile.`;
}

export interface EmbeddingControlsOptions {
	readonly embedder: ManagedEmbedder;
	/** True when the active profile is an API: the toggle then has nothing local to start or stop. */
	readonly remote: boolean | (() => boolean);
	readonly isIndexing?: () => boolean;
}

/** The footer text for one probe result. Plain text: pi's footer owns colour. */
export function embeddingStatusText(health: EmbedderHealth, toggleKey: string = EMBEDDING_TOGGLE_KEY): string {
	if (health.backend === "remote" || health.backend === "api") {
		return health.alive ? "embedding: remote ● up" : `embedding: remote ○ down (${health.detail ?? "no answer"})`;
	}
	if (health.backend === "local-http" && health.alive) return "embedding: FastEmbed ● up";
	if (health.backend === "daemon") return "embedding: daemon ● up";
	if (health.backend === "in-process") return "embedding: in-process ●";
	return `embedding: off ○ (/embedding on, or ${toggleKey}, starts FastEmbed)`;
}

/** Session-scoped service controls. Existing external processes are never stopped. */
export function createEmbeddingControls(options: EmbeddingControlsOptions): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let timer: NodeJS.Timeout | undefined;
		let busy = false;
		// pi invalidates an extension ctx once its session is replaced (/new, /resume, reload) and throws when
		// it is used again. A probe or a toggle can finish after that, so every write is tied to the session
		// that started it and dropped when that session is gone; the next session_start installs a fresh one.
		let generation = 0;

		const ui = (ctx: ExtensionContext): SessionFooter => {
			const mine = generation;
			return {
				setStatus: (text: string | undefined): void => {
					if (generation === mine) ctx.ui.setStatus(EMBEDDING_STATUS_KEY, text);
				},
				notify: (message: string, type: "info" | "warning" | "error"): void => {
					if (generation === mine) ctx.ui.notify(message, type);
				},
			};
		};

		const refresh = async (target: SessionFooter): Promise<void> => {
			try {
				target.setStatus(embeddingStatusText(await options.embedder.health()));
			} catch {
				target.setStatus("embedding: unknown");
			}
		};

		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			generation += 1;
			const target = ui(ctx);
			void refresh(target);
			clearInterval(timer);
			timer = setInterval(() => {
				if (!busy) void refresh(target);
			}, POLL_INTERVAL_MS);
			timer.unref();
		});
		pi.on("session_shutdown", () => {
			generation += 1;
			clearInterval(timer);
			timer = undefined;
		});

		/** One action for the key and for `/embedding`: `toggle` flips, `on`/`off` only move toward that state. */
		const act = async (action: EmbeddingAction, ctx: ExtensionContext): Promise<void> => {
			const target = ui(ctx);
			if (action === "status") {
				try {
					const health = await options.embedder.health();
					target.setStatus(embeddingStatusText(health));
					target.notify(describeHealth(health), health.alive ? "info" : "warning");
				} catch (error) {
					target.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (typeof options.remote === "function" ? options.remote() : options.remote) {
				target.notify("Embedding uses a remote endpoint; there is no local service to start or stop.", "info");
				return;
			}
			if (busy) {
				target.notify("The embedding service is already being started or stopped.", "info");
				return;
			}
			busy = true;
			try {
				if (options.isIndexing?.())
					throw new Error("An index task is active; cancel it before changing the embedding service lifecycle");
				const running = (await options.embedder.health()).alive;
				if (action === "on" && running)
					target.notify("Embedding is already running; an external service remains externally managed.", "info");
				else if (action === "off" || (action === "toggle" && running)) {
					if (!options.embedder.stop) throw new Error("This embedding service is externally managed");
					await options.embedder.stop();
					target.notify("Stopped this session's FastEmbed service.", "info");
				} else {
					target.setStatus("embedding: preparing Qwen ONNX model and starting FastEmbed…");
					if (!options.embedder.start) throw new Error("This embedding service is externally managed");
					await options.embedder.start();
					target.notify(describeHealth(await options.embedder.health()), "info");
				}
			} catch (error) {
				target.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				busy = false;
				await refresh(target);
			}
		};

		pi.registerShortcut(EMBEDDING_TOGGLE_KEY, {
			description: "Start or stop this session's local FastEmbed service",
			handler: (ctx) => act("toggle", ctx),
		});

		pi.registerCommand("embedding", {
			description: "Embedding service: /embedding [on|off|toggle|status] (no argument: toggle)",
			getArgumentCompletions: (prefix) => {
				const matches = EMBEDDING_ACTIONS.filter((name) => name.startsWith(prefix.trim().toLowerCase()));
				return matches.length === 0 ? null : matches.map((name) => ({ value: name, label: name }));
			},
			handler: async (args, ctx) => {
				const word = args.trim().toLowerCase();
				const action = word === "" ? "toggle" : EMBEDDING_ACTIONS.find((name) => name === word);
				if (action === undefined) {
					ui(ctx).notify(
						`Unknown argument "${word}". Use /embedding [${EMBEDDING_ACTIONS.join("|")}].`,
						"warning",
					);
					return;
				}
				await act(action, ctx);
			},
		});
	};
}
