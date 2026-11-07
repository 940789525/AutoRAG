import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { abortReason } from "../process/abort-reason.ts";
import { terminateProcessTree } from "../process/terminate-tree.ts";
import { ParseError } from "./errors.ts";
import { serializeDocling } from "./table-structure.ts";
import { type ParseInput, type ParseOutput, Parser } from "./types.ts";

export const DOCLING_DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".xlsx"] as const;
const IMAGE_EXTENSIONS = [".png", ".jpeg", ".jpg", ".webp"] as const;
const MAX_REPLY = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export interface DoclingOptions {
	readonly ocr: boolean;
	readonly languages: readonly string[];
	readonly timeoutMs: number;
}

export class DoclingParser extends Parser {
	readonly name = "docling";
	readonly version: string;
	readonly extensions: readonly string[];
	readonly #options: DoclingOptions;

	constructor(options: DoclingOptions) {
		super();
		this.#options = options;
		this.extensions = options.ocr
			? [...DOCLING_DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS]
			: DOCLING_DOCUMENT_EXTENSIONS;
		this.version = createHash("sha256")
			.update(readFileSync(join(dirname(workerPath()), "docling-models.json")))
			.update(readFileSync(workerPath()))
			.update(
				JSON.stringify([
					"docling-accurate-v1",
					options,
					process.env.AUTORAG_DOCLING_PYTHON,
					process.env.AUTORAG_DOCLING_MODELS,
				]),
			)
			.digest("hex");
	}

	openTask() {
		return new DoclingTask(this.#options);
	}

	async parse(input: ParseInput): Promise<ParseOutput> {
		const task = this.openTask();
		try {
			return await task.parse(input);
		} finally {
			await task.close();
		}
	}
}

class DoclingTask {
	readonly #options: DoclingOptions;
	#stage?: string;
	#child?: ChildProcessWithoutNullStreams;
	#closed?: Promise<void>;
	#stderr = "";
	#id = 0;

	constructor(options: DoclingOptions) {
		this.#options = options;
	}

	async parse(input: ParseInput, signal?: AbortSignal): Promise<ParseOutput> {
		try {
			signal?.throwIfAborted();
			const filename = basename(input.virtualPath);
			this.#stderr = "";
			const child = this.#child ?? this.#spawn();
			const id = ++this.#id;
			const file = `${id}${extname(filename).toLowerCase()}`;
			const path = join(this.#stage!, file);
			try {
				await writeFile(path, input.bytes, { flag: "wx", mode: 0o600, signal });
				const reply = await this.#request(child, { v: 1, id, file, filename }, signal);
				const parsed = serializeDocling(reply.blocks, reply.diagnostics, input.virtualPath, this.#options.ocr);
				return {
					...parsed,
					diagnostics: parsed.structure.quality.warnings.map((message) => ({
						code: "parser-warning",
						severity: "warning",
						message,
					})),
				};
			} finally {
				await rm(path, { force: true });
			}
		} catch (error) {
			if (signal?.aborted) throw abortReason(signal);
			throw new ParseError("docling", input.virtualPath, error);
		}
	}

	async close(): Promise<void> {
		await this.#stop();
		if (this.#stage) await rm(this.#stage, { recursive: true, force: true });
	}

	#spawn(): ChildProcessWithoutNullStreams {
		const python = deploymentPath("AUTORAG_DOCLING_PYTHON");
		const models = deploymentPath("AUTORAG_DOCLING_MODELS");
		const worker = workerPath();
		this.#stage ??= mkdtempSync(join(tmpdir(), "autorag-docling-"));
		const seconds = Math.max(0.01, Math.min(110, this.#options.timeoutMs / 1000 - 1));
		const child = spawn(python, ["-u", worker, models, this.#stage, String(this.#options.ocr), String(seconds)], {
			detached: process.platform !== "win32",
			windowsHide: true,
			env: {
				...process.env,
				HF_HUB_OFFLINE: "1",
				TRANSFORMERS_OFFLINE: "1",
				HF_HUB_DISABLE_TELEMETRY: "1",
				DO_NOT_TRACK: "1",
				OMP_NUM_THREADS: "4",
				MKL_NUM_THREADS: "4",
				OPENBLAS_NUM_THREADS: "1",
				PYTHONDONTWRITEBYTECODE: "1",
			},
		});
		child.stderr.setEncoding("utf8").on("data", (text: string) => {
			this.#stderr = (this.#stderr + text).slice(-MAX_STDERR);
		});
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			this.#stderr = `${this.#stderr}\n${error.message}`.slice(-MAX_STDERR);
		});
		this.#closed = new Promise((resolve) =>
			child.once("close", () => {
				if (this.#child === child) this.#child = undefined;
				resolve();
			}),
		);
		this.#child = child;
		return child;
	}

	async #stop(): Promise<void> {
		if (this.#child) terminateProcessTree(this.#child);
		await this.#closed;
	}

	#request(
		child: ChildProcessWithoutNullStreams,
		packet: { v: number; id: number; file: string; filename: string },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const request = JSON.stringify(packet) + "\n";
			if (Buffer.byteLength(request) > 8192) {
				reject(new Error("Docling request exceeds the 8 KiB limit"));
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			const clear = () => {
				clearTimeout(timer);
				child.stdout.off("data", onData);
				child.off("close", onClose);
				signal?.removeEventListener("abort", onAbort);
			};
			const failure = (message: string, stop: boolean) => {
				clear();
				const error = new Error(`${message}${this.#stderr.trim() ? `\n${this.#stderr.trim()}` : ""}`);
				if (stop) void this.#stop().then(() => reject(error), reject);
				else reject(error);
			};
			const onClose = (code: number | null, childSignal: string | null) =>
				failure(`Docling worker exited (code ${code}, signal ${childSignal})`, false);
			const onAbort = () => {
				clear();
				void this.#stop().then(() => reject(abortReason(signal!)), reject);
			};
			const onData = (chunk: Buffer) => {
				chunks.push(chunk);
				size += chunk.length;
				if (size > MAX_REPLY) return failure("Docling response exceeds the 4 MiB limit", true);
				const newline = chunk.indexOf(10);
				if (newline === -1) return;
				let reply: Record<string, unknown>;
				try {
					if (newline !== chunk.length - 1) throw new Error("Unexpected extra Docling JSONL output");
					reply = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
					if (reply?.v !== 1 || reply.id !== packet.id || typeof reply.ok !== "boolean")
						throw new Error("Invalid Docling response identity");
				} catch (error) {
					return failure(String(error), true);
				}
				if (!reply.ok) return failure(String(reply.error), false);
				clear();
				resolve(reply);
			};
			const timer = setTimeout(
				() => failure(`Docling parse exceeded the ${this.#options.timeoutMs}ms deadline`, true),
				this.#options.timeoutMs,
			);
			child.stdout.on("data", onData);
			child.once("close", onClose);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			else if (child.exitCode !== null || child.signalCode !== null) onClose(child.exitCode, child.signalCode);
			else child.stdin.write(request);
		});
	}
}

function workerPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const worker = [here, join(here, "parser"), join(here, "..", "parser")]
		.map((directory) => join(directory, "docling-worker.py"))
		.find(existsSync);
	if (!worker) throw new Error(`Docling worker is missing near ${here}`);
	return worker;
}

function deploymentPath(name: string): string {
	const value = process.env[name];
	if (!value || !isAbsolute(value)) throw new Error(`Set ${name} to an absolute local path for the Docling parser`);
	return value;
}
