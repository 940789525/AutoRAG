import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveAutoRAGHome } from "../config/home.ts";
import { DEFAULT_EMBEDDING_MODEL, type EmbeddingProfile } from "./config.ts";

function serviceScript(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth++, dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (!existsSync(pkg)) continue;
		if (JSON.parse(readFileSync(pkg, "utf8")).name !== "@autorag/librarian") continue;
		const built = join(dir, "dist", "embedding-service.py");
		return existsSync(built) ? built : join(dir, "src", "embedding", "service.py");
	}
	throw new Error("AutoRAG embedding-service.py is missing from this installation");
}

/** Existing loopback services never become owned by this controller. */
export class LocalEmbeddingService {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private stderr = "";
	private readonly profile: EmbeddingProfile;
	private readonly env: NodeJS.ProcessEnv;
	constructor(profile: EmbeddingProfile, env: NodeJS.ProcessEnv = process.env) {
		this.profile = profile;
		this.env = env;
	}
	start(ready: () => Promise<boolean>, signal?: AbortSignal, onProgress?: (detail: string) => void): Promise<void> {
		this.starting ??= this.startChild(ready, signal, onProgress).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}
	private async startChild(
		ready: () => Promise<boolean>,
		signal?: AbortSignal,
		onProgress?: (detail: string) => void,
	): Promise<void> {
		if (await ready()) return;
		if (
			this.profile.kind !== "local-http" ||
			this.profile.model !== DEFAULT_EMBEDDING_MODEL ||
			this.profile.protocol !== "openai"
		)
			throw new Error("This embedding endpoint is externally managed; start its service yourself");
		const url = new URL(this.profile.baseUrl);
		if (url.pathname !== "/" || url.hostname === "localhost")
			throw new Error("Managed FastEmbed requires an explicit loopback IP and server root URL");
		const cache = join(resolveAutoRAGHome(this.env), "models", "fastembed");
		mkdirSync(cache, { recursive: true });
		const script = serviceScript();
		const localPython = join(
			script.endsWith("embedding-service.py") ? dirname(dirname(script)) : dirname(dirname(dirname(script))),
			".venv-embedding",
			process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
		);
		const child = spawn(
			this.env.AUTORAG_FASTEMBED_PYTHON ?? (existsSync(localPython) ? localPython : "python3"),
			[script, "--host", url.hostname.replace(/[[\]]/g, ""), "--port", url.port || "80", "--cache-dir", cache],
			{
				env: this.env,
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true,
			},
		);
		this.child = child;
		this.stderr = "";
		const logs = join(resolveAutoRAGHome(this.env), "logs");
		mkdirSync(logs, { recursive: true });
		const logPath = join(logs, `fastembed-${child.pid ?? "start"}.log`);
		onProgress?.(`FastEmbed startup log: ${logPath}`);
		let ended: string | undefined;
		child.stderr?.on("data", (data) => {
			this.stderr = (this.stderr + data.toString()).slice(-16_384);
			try {
				appendFileSync(logPath, data);
			} catch (error) {
				this.stderr += `\nStartup log write failed: ${error}`;
			}
			try {
				onProgress?.(data.toString().trim());
			} catch {
				/* Progress observers do not control the service. */
			}
		});
		child.on("error", (error) => {
			ended = error.message;
		});
		child.on("exit", (code, reason) => {
			ended = `exit ${code}, signal ${reason}`;
			if (this.child === child) this.child = undefined;
		});
		try {
			const deadline = Date.now() + 15 * 60_000;
			while (Date.now() < deadline) {
				signal?.throwIfAborted();
				if (ended) throw new Error(`FastEmbed service ${ended}: ${this.stderr}`);
				if (await ready()) return;
				await sleep(500, undefined, { signal });
			}
			throw new Error(`FastEmbed did not become ready within 15 minutes: ${this.stderr}`);
		} catch (error) {
			if (this.child) await this.stop();
			throw error;
		}
	}
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) throw new Error("Embedding service is externally managed or already stopped; no process was stopped");
		child.kill("SIGTERM");
		await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), sleep(5000)]);
		if (this.child === child && child.exitCode === null) child.kill("SIGKILL");
		this.child = undefined;
	}
	async close(): Promise<void> {
		if (this.child) await this.stop();
	}
}
