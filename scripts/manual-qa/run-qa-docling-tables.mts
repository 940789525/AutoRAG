import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { AutoRAGAgent, defaultEmbeddingConfig, releaseEmbedders } from "../../src/index.ts";
import type { LocalIndexMethod } from "../../src/indexing/method.ts";
import { loadIndexTokenizer } from "../../src/indexing/tokenizer.ts";
import { loadActiveMirrorIndex } from "../../src/mirror/index-store.ts";
import { readStructure } from "../../src/mirror/structured.ts";
import { terminateProcessTree } from "../../src/process/terminate-tree.ts";
import qwen from "../../src/embedding/qwen-model.json" with { type: "json" };

const probe = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
assert(process.env.AUTORAG_HOME && process.env.AUTORAG_CONFIG?.startsWith(process.env.AUTORAG_HOME + "/"));
assert.equal((await readFile("/proc/net/route", "utf8")).trim().split("\n").length, 1, "QA requires --network none");
const work = await mkdtemp(join(evidence, "work-"));
const docs = join(work, "docs");
const fixtures = join(probe, "fixtures");
const manifest = JSON.parse(await readFile(join(fixtures, "manifest.json"), "utf8")) as {
	version: number;
	cases: { id: string; file: string; headers: string[]; expected: string[][] }[];
};
await cp(fixtures, docs, { recursive: true, filter: (source) => basename(source) !== "manifest.json" });
await writeFile(join(docs, "体育说明.md"), "# 体育课程\n课程安排和成绩查询流程以教学通知为准。\n");
const modelDir = join(work, "qwen");
await mkdir(join(modelDir, "onnx"), { recursive: true });
for (const file of Object.keys(qwen.files)) await symlink(join(probe, "models/qwen", file), join(modelDir, file));
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
server.close();
await once(server, "close");
const endpoint = `http://127.0.0.1:${address.port}`;
const child = spawn("/opt/autorag-embedding/bin/python",
	["src/embedding/service.py", "--offline", "--port", String(address.port), "--model-dir", modelDir, "--cache-dir", join(work, "cache"), "--threads", "4"],
	{ detached: true, stdio: ["ignore", "inherit", "inherit"] });
const childClosed = once(child, "close");
const embedding = defaultEmbeddingConfig();
const profile = embedding.profiles[embedding.defaultProfile];
profile.baseUrl = endpoint;
profile.manifest!.tokenizerPath = modelDir;
const options = {
	searchPaths: [docs], workspacePath: join(work, "workspace"), memoryPath: join(work, "memory.json"),
	embedding, localIndex: { targetTokens: 100, maxTokens: 140 }, languages: ["zh-hans", "en"] as const,
	jikji: false as const, fsearch: false as const, everything: false as const, dupey: false as const,
	filee: false as const, jev: false as const, webSearch: false as const, excludeExactDuplicates: false,
};
let agent: AutoRAGAgent | undefined;
const ranks: unknown[] = [];
const jobs: unknown[] = [];
const readyPath = join(options.workspacePath, ".autorag/local-index/ready.json");
const report: Record<string, unknown> = { fixtureVersion: manifest.version, ranks, jobs };
const index = () => (agent!.getMethodRegistry().get("minsync") as LocalIndexMethod).index;
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
function matchesRecord(text: string, headers: string[], record: string[]): boolean {
	return text.split("\n").some((line) => {
		const values = new Map(line.replace(/^- /u, "").split(" | ").map((field) => {
			const colon = field.indexOf(":");
			return [normalize(field.slice(0, colon)), normalize(field.slice(colon + 1))];
		}));
		return record.every((expected, column) => {
			const actual = values.get(normalize(headers[column]));
			return actual === normalize(expected) || (column >= 2 && actual && Number(actual) === Number(expected));
		});
	});
}
async function job(mode: "build" | "refresh") {
	const { jobId } = agent!.startIndexJob({ mode });
	for (let i = 0; i < 4800; i++) {
		const state = agent!.indexJobs.status(jobId)!;
		if (!["queued", "running", "cancelling"].includes(state.state)) {
			jobs.push({ mode, state: state.state, error: state.error, report: state.report });
			console.log(mode, state.state, state.report?.documents, state.report?.chunks, state.error ?? "");
			return state;
		}
		await wait(100);
	}
	throw new Error(`Index job ${jobId} did not finish`);
}

try {
	const deadline = Date.now() + 120_000;
	while (true) {
		try {
			const health = await fetch(endpoint + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
			assert(health.ready && health.dimension === 1024);
			report.health = health;
			break;
		} catch (error) {
			if (child.exitCode !== null || Date.now() >= deadline) throw error;
			await wait(200);
		}
	}
	agent = new AutoRAGAgent({ ...options, parserOptions: { documentBackend: "docling", ocr: { enabled: true } } });
	const cold = await job("build");
	assert.equal(cold.state, "succeeded", cold.error);
	assert.equal(cold.report?.documents, manifest.cases.length + 1);
	const mirror = loadActiveMirrorIndex(options.workspacePath);
	assert.equal(mirror.backend, "docling");
	const tokenizer = await loadIndexTokenizer({ root: work, model: profile.model, tokenizerPath: profile.manifest!.tokenizerPath });
	const modes = ["bm25", "vector", "hybrid"] as const;
	let deletedHandle: Parameters<ReturnType<typeof index>["readEvidence"]>[0] | undefined;
	for (const fixture of manifest.cases) {
		const entry = Object.values(mirror.entries).find((item) => basename(item.sourcePath) === fixture.file);
		assert(entry?.structureSha256, fixture.file);
		const markdown = await readFile(entry.outputPath, "utf8");
		const structure = await readStructure(options.workspacePath, entry, markdown);
		assert(structure?.tables.length, fixture.file);
		for (const [course, term, score, credits] of fixture.expected) {
			const query = course.startsWith("PE ") ? `Find the semester and score for ${course}` : `查询 ${course} 的学期和成绩`;
			for (const mode of modes) {
				const hits = await index().search(query, { mode, topK: 3, sourceIds: [entry.virtualPath] });
				const rank = hits.findIndex(({ row }) => matchesRecord(row.text, fixture.headers, [course, term, score, credits])) + 1;
				ranks.push({ case: fixture.id, course, mode, rank });
				assert(rank > 0, `${fixture.id} ${course} ${mode}: ${hits.map((hit) => hit.row.text).join("\\n")}`);
				const hit = hits[rank - 1];
				assert.equal(hit.row.text, markdown.slice(hit.row.start, hit.row.end));
				assert(tokenizer.count(profile.manifest!.passagePrefix + hit.row.embedding_text) <= options.localIndex.maxTokens);
				const handles = await index().readHandles([hit], () => true);
				const handle = handles.get(hit.row.id);
				assert.equal(handle?.structureSha256, entry.structureSha256);
				if (mode === "hybrid" && course === fixture.expected[0][0]) {
					assert.equal((await index().readEvidence(handle!, () => true)).text, hit.row.text);
					if (fixture === manifest.cases[0]) deletedHandle = handle;
				}
			}
		}
	}
	const warm = await job("refresh");
	assert.equal(warm.state, "succeeded", warm.error);
	assert.equal(warm.report?.embedded, 0);
	const saved = await readFile(readyPath, "utf8");
	const damaged = join(docs, "damaged.pdf");
	await writeFile(damaged, "%PDF- invalid synthetic input");
	const failed = await job("build");
	assert.equal(failed.state, "failed");
	assert.match(failed.error ?? "", /Docling|PDF/u);
	assert.equal(await readFile(readyPath, "utf8"), saved);
	await rm(damaged);
	const extra = join(docs, "cancel-probe.pdf");
	await cp(join(fixtures, manifest.cases[0].file), extra);
	const cancel = agent.startIndexJob({ mode: "refresh" });
	await wait(1200);
	agent.indexJobs.cancel(cancel.jobId);
	for (let i = 0; i < 200 && agent.indexJobs.status(cancel.jobId)?.state !== "cancelled"; i++) await wait(100);
	assert.equal(agent.indexJobs.status(cancel.jobId)?.state, "cancelled");
	assert.equal(await readFile(readyPath, "utf8"), saved);
	report.cancelled = true;
	await rm(extra);
	await agent.indexJobs.close();
	agent = new AutoRAGAgent({ ...options, parserOptions: { documentBackend: "docling", ocr: { enabled: true } } });
	assert((await index().search("体育一", { mode: "hybrid", topK: 3 })).length);
	report.restarted = true;
	const source = Object.values(mirror.entries).find((entry) => basename(entry.sourcePath) === manifest.cases[0].file)!;
	await rm(source.sourcePath);
	const deleted = await job("refresh");
	assert.equal(deleted.state, "succeeded", deleted.error);
	assert.equal(deleted.report?.deleted, 1);
	assert.deepEqual(await index().search("体育一", { mode: "bm25", sourceIds: [source.virtualPath] }), []);
	assert.equal(loadActiveMirrorIndex(options.workspacePath).entries[source.virtualPath], undefined);
	assert(deletedHandle);
	await assert.rejects(index().readEvidence(deletedHandle, () => true));
	await agent.indexJobs.close();
	agent = new AutoRAGAgent({ ...options, parserOptions: { documentBackend: "kordoc" } });
	const rollback = await job("build");
	assert.equal(rollback.state, "succeeded", rollback.error);
	const legacy = loadActiveMirrorIndex(options.workspacePath);
	assert.equal(legacy.backend, "kordoc");
	assert(Object.values(legacy.entries).every((entry) => !entry.structureSha256));
	const english = Object.values(legacy.entries).find((entry) => basename(entry.sourcePath) === "en-dual-native.pdf");
	assert(english);
	assert((await index().search("PE Alpha", { mode: "bm25", sourceIds: [english.virtualPath], topK: 3 }))
		.some((hit) => hit.row.text.includes("PE Alpha")));
	report.rollback = true;
	report.result = "PASS";
} finally {
	await agent?.indexJobs.close();
	await releaseEmbedders();
	terminateProcessTree(child);
	await childClosed;
	report.memoryPeakBytes = Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim());
	report.memoryEvents = await readFile("/sys/fs/cgroup/memory.events", "utf8");
	await mkdir(evidence, { recursive: true });
	await writeFile(join(evidence, "result.json"), JSON.stringify(report, null, 2) + "\n");
	await rm(work, { recursive: true, force: true });
}
