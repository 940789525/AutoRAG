import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { contentHash } from "./chunker.ts";
import { KIWI_MODEL_FILES, KIWI_MODEL_SHA256 } from "./kiwi-model.ts";
import type { LexicalAnalyzer } from "./types.ts";

/** Original words + ICU segmentation; Kiwi morphology loads only for Korean and runs off the main thread. */
export function createLexicalAnalyzer(options: { root?: string; koreanModelPath?: string } = {}): LexicalAnalyzer {
	const segmenter = new Intl.Segmenter("und", { granularity: "word" });
	let worker: Worker | undefined;
	let nextId = 0;
	const pending = new Map<number, { resolve(tokens: string[]): void; reject(error: unknown): void }>();
	const signals = new Map<AbortSignal, { abort(): void; count: number }>();
	const stamps = options.koreanModelPath
		? KIWI_MODEL_FILES.map((name) => {
				const value = statSync(join(options.koreanModelPath!, name), { bigint: true });
				return `${name}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
			})
		: [KIWI_MODEL_SHA256];
	const close = (error: unknown = new Error("lexical analyzer was closed")): void => {
		const running = worker;
		worker = undefined;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		void running?.terminate();
	};
	const korean = (text: string, signal?: AbortSignal): Promise<string[]> => {
		signal?.throwIfAborted();
		if (!worker) {
			const here = dirname(fileURLToPath(import.meta.url));
			const path = [
				join(here, "lexical-worker.ts"),
				join(here, "indexing", "lexical-worker.js"),
				join(here, "lexical-worker.js"),
			].find(existsSync);
			if (!path) return Promise.reject(new Error(`AutoRAG lexical worker entry is missing near ${here}`));
			const running = new Worker(pathToFileURL(path), {
				workerData: {
					configured: options.koreanModelPath,
					directory: join(options.root ?? process.cwd(), ".autorag", "models"),
				},
			});
			worker = running;
			running.on("message", ({ id, tokens, error }: { id: number; tokens?: string[]; error?: string }) => {
				if (worker !== running) return;
				const request = pending.get(id);
				if (!request) return;
				pending.delete(id);
				if (error) request.reject(new Error(error));
				else request.resolve(tokens ?? []);
				if (pending.size === 0) running.unref();
			});
			running.on("error", (error) => {
				if (worker !== running) return;
				for (const request of pending.values()) request.reject(error);
				pending.clear();
				worker = undefined;
			});
			running.on("exit", (code) => {
				if (worker !== running) return;
				for (const request of pending.values())
					request.reject(new Error(`lexical worker exited before answering (code ${code})`));
				pending.clear();
				worker = undefined;
			});
		}
		worker.ref();
		const id = ++nextId;
		return new Promise<string[]>((resolve, reject) => {
			const timer = setTimeout(() => close(new Error("lexical worker timed out after 330000ms")), 330_000);
			if (signal) {
				let listener = signals.get(signal);
				if (!listener) {
					listener = { abort: () => close(signal.reason), count: 0 };
					signals.set(signal, listener);
					signal.addEventListener("abort", listener.abort, { once: true });
				}
				listener.count++;
			}
			const cleanup = () => {
				clearTimeout(timer);
				const listener = signal ? signals.get(signal) : undefined;
				if (signal && listener && --listener.count === 0) {
					signal.removeEventListener("abort", listener.abort);
					signals.delete(signal);
				}
			};
			pending.set(id, {
				resolve(tokens) {
					cleanup();
					resolve(tokens);
				},
				reject(error) {
					cleanup();
					reject(error);
				},
			});
			worker!.postMessage({ id, text });
		});
	};
	return {
		fingerprint: contentHash(`icu-${process.versions.icu}-originals-v1:${stamps.join(";")}`),
		async analyze(text, signal) {
			signal?.throwIfAborted();
			const original = text
				.toLowerCase()
				.split(/\s+/u)
				.map((word) => word.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""))
				.filter(Boolean);
			const segments = [...segmenter.segment(text.toLowerCase())]
				.filter((part) => part.isWordLike)
				.map((part) => part.segment);
			const morphemes = /[\uac00-\ud7af]/u.test(text) ? await korean(text, signal) : [];
			return [...original, ...segments, ...morphemes].join(" ");
		},
		close,
	};
}
