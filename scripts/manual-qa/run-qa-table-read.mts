import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import { EvidenceLedger } from "../../src/agent/evidence-ledger.ts";
import { assertTableReads, createReadLocalTableTool } from "../../src/agent/read-local-table-tool.ts";
import { createEmbedderFromConfig } from "../../src/embedding/index.ts";
import { defaultEmbeddingConfig } from "../../src/embedding/config.ts";
import { LocalIndexMethod } from "../../src/indexing/method.ts";
import { syncParsedMirrors } from "../../src/mirror/sync.ts";
import { loadActiveMirrorIndex } from "../../src/mirror/index-store.ts";
import { terminateProcessTree } from "../../src/process/terminate-tree.ts";
import modelLock from "../../src/embedding/qwen-model.json" with { type: "json" };

const [folder, cache, ...paths] = process.argv.slice(2);
assert(folder && cache && paths.length > 0);
assert(process.env.AUTORAG_HOME && process.env.AUTORAG_CONFIG?.startsWith(process.env.AUTORAG_HOME + "/"));
assert.equal((await readFile("/proc/net/route", "utf8")).trim().split("\n").length, 1, "Use an isolated --network none container");
const root = resolve(folder);
const docs = join(root, "docs");
const models = join(root, "qwen");
await mkdir(docs, { recursive: true, mode: 0o700 });
await mkdir(join(models, "onnx"), { recursive: true, mode: 0o700 });
const keepExisting = (error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; };
for (const path of paths) await copyFile(path, join(docs, basename(path)), constants.COPYFILE_EXCL).catch(keepExisting);
for (const file of Object.keys(modelLock.files)) await symlink(resolve(cache, file), join(models, file)).catch(keepExisting);
const socket = createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const address = socket.address();
assert(address && typeof address !== "string");
socket.close();
await once(socket, "close");
const endpoint = `http://127.0.0.1:${address.port}`;
const service = spawn("/opt/autorag-embedding/bin/python", ["src/embedding/service.py", "--offline",
	"--model-dir", models, "--cache-dir", root, "--port", String(address.port), "--threads", "4"],
	{ detached: true, stdio: ["ignore", "ignore", "inherit"] });
const closed = once(service, "close");
const report: Record<string, unknown> = { realVisionModel: false };
try {
	const deadline = Date.now() + 120_000;
	for (;;) {
		try {
			const data = await fetch(endpoint + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
			assert(data.ready && data.dimension === 1024);
			break;
		} catch (error) {
			if (service.exitCode !== null || Date.now() >= deadline) throw error;
			await wait(200);
		}
	}
	const embedding = defaultEmbeddingConfig();
	const profile = embedding.profiles[embedding.defaultProfile];
	profile.baseUrl = endpoint;
	profile.manifest!.tokenizerPath = models;
	const embedder = createEmbedderFromConfig({ embedding, workspaceRoot: root });
	const authorize = (source: string, id: string) => paths.some((path) => source === join(docs, basename(path))) && id.endsWith("/" + basename(source));
	const method = new LocalIndexMethod({ root, embedder, mode: "hybrid", parserBackend: "docling",
		tokenizerPath: models, canReadSource: authorize });
	const settings = { root, searchPaths: [docs], parserOptions: { documentBackend: "docling" as const, languages: ["zh-hans", "en"] as const, ocr: { enabled: true } } };
	const start = performance.now();
	const cold = await syncParsedMirrors(settings);
	assert.equal(cold.skipped, 0);
	assert((await method.index.sync()).ok);
	report.buildMs = Math.round(performance.now() - start);
	report.parsedDocuments = cold.written;
	const entries = Object.values(loadActiveMirrorIndex(root).entries);
	const ledger = new EvidenceLedger();
	const model = { input: ["text", "image"], baseUrl: endpoint } as Model<Api>;
	const tool = createReadLocalTableTool(ledger, (handle, rows, signal) => method.index.readTableSource(handle, authorize, rows, signal), () => model);
	const sources = [];
	const query = "所有体育成绩";
	const initial = await method.retrieve(query, { topK: 8 });
	for (const entry of entries) {
		const hit = initial.find((result) => result.source === entry.sourcePath);
		assert(hit, "Real source was not recalled in the initial query");
		const evidenceId = ledger.registerResult("qa", hit);
		const rows = await tool.execute("qa-rows", { evidenceId, view: "rows" });
		const coverage = rows.details as { totalRows: number; requiresOriginalReview: boolean };
		let cursor: string | undefined;
		let pages = 0;
		do {
			const result = await tool.execute("qa-page", { evidenceId, view: "image", cursor });
			assertTableReads([{ role: "toolResult", toolCallId: "qa-page", toolName: tool.name, isError: false, timestamp: Date.now(), content: result.content }], authorize, model);
			const image = result.content.find((part) => part.type === "image");
			assert(image);
			pages++;
			await writeFile(join(root, `${basename(entry.sourcePath)}-page-${pages}.jpg`), Buffer.from(image.data, "base64"), { mode: 0o600 });
			cursor = (result.details as { nextCursor?: string }).nextCursor;
		} while (cursor);
		sources.push({ tablesIndexedRows: coverage.totalRows, requiresOriginalReview: coverage.requiresOriginalReview, pages });
	}
	report.sources = sources;
	const warm = await syncParsedMirrors(settings);
	assert.equal(warm.written, 0);
	assert.equal((await method.index.sync()).embedded, 0);
	report.warmEmbedded = 0;
	report.transportGuard = "PASS";
} finally {
	terminateProcessTree(service);
	await closed;
	report.memoryPeakBytes = Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim());
	report.memoryEvents = await readFile("/sys/fs/cgroup/memory.events", "utf8");
	await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
}
