import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSha256 } from "../../src/filesystem/content-fingerprint.ts";
import { createEmbedderFromConfig, defaultEmbeddingConfig } from "../../src/embedding/index.ts";
import { releaseEmbedders } from "../../src/embedding/index.ts";
import { createResearchRuntime } from "../../src/research/runtime.ts";
import { AutoRAGLite } from "../../src/core.ts";
import { resolveConfigReadOnly } from "../../src/cli/config.ts";

// A synthetic, valid PDF keeps the live smoke independent of the user's corpus.
function pdf(text: string): Buffer {
	const stream = `BT /F1 12 Tf 30 700 Td (${text.replace(/[()\\]/gu, "\\$&")}) Tj ET`;
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const xref = Buffer.byteLength(body);
	body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body);
}

const qaRoot = await mkdtemp(join(tmpdir(), "autorag-research-live-"));
const realConfig = process.env.AUTORAG_RESEARCH_QA_SHARED_CONFIG;
const hash = async () => realConfig && existsSync(realConfig) ? createHash("sha256").update(await readFile(realConfig)).digest("hex") : "absent";
const before = await hash();
const oldHome = process.env.AUTORAG_HOME;
const oldConfig = process.env.AUTORAG_CONFIG;
process.env.AUTORAG_HOME = join(qaRoot, "home");
process.env.AUTORAG_CONFIG = join(qaRoot, "runtime.json");
try {
	const root = join(qaRoot, "papers"); const workspace = join(qaRoot, "workspace"); const agentDir = join(qaRoot, "agent");
	await mkdir(root); await mkdir(agentDir); await mkdir(process.env.AUTORAG_HOME);
	await writeFile(join(root, "baseline.pdf"), pdf("Research baseline: retrieval experiments require reproducible evaluation and source evidence."));
	const embedding=defaultEmbeddingConfig();
	if(process.env.AUTORAG_QA_EMBED_ENDPOINT)embedding.profiles["local-qwen3"].baseUrl=process.env.AUTORAG_QA_EMBED_ENDPOINT;
	if(process.env.AUTORAG_QA_TOKENIZER)embedding.profiles["local-qwen3"].manifest!.tokenizerPath=process.env.AUTORAG_QA_TOKENIZER;
	await writeFile(process.env.AUTORAG_CONFIG, JSON.stringify({ embedding, searchPaths: [root], workspacePath: workspace, memoryPath: join(qaRoot, "home", "memory.json"), languages: ["en"], ...(process.env.AUTORAG_RESEARCH_QA_TOKENIZER ? { localIndex: { tokenizerPath: process.env.AUTORAG_RESEARCH_QA_TOKENIZER } } : {}), jev: false, dupey: { enabled: false } }));
	assert(process.env.AUTORAG_CONFIG.startsWith(qaRoot));
	const daemon = await createEmbedderFromConfig({embedding}).health();
	assert(daemon.alive, "A local FastEmbed Qwen service must already be running; this smoke never starts or stops it");
	const runtime = await createResearchRuntime({ root, workspace, runtimeConfig: process.env.AUTORAG_CONFIG, agentDir, allowModelProcessing: false });
	await runtime.refresh();
	const revision = await runtime.revision(await fileSha256(join(root, "baseline.pdf")));
	assert(revision, "PDF must be parsed, hashed and present in the actual local index");
	await runtime.verify({ ...revision, id: "fixture", paperId: "fixture" });
	const config = resolveConfigReadOnly({ flags: { config: process.env.AUTORAG_CONFIG }, cwd: workspace, env: process.env });
	const lite = new AutoRAGLite({ ...config, searchPaths: [root], workspacePath: workspace });
	const result = await lite.searchSelected("How should retrieval experiments be evaluated?", { methods: ["hybrid"] }, { topK: 3, sourceIds: [revision.sourceId] });
	assert(result.results.some((hit) => hit.source === revision.source));
	assert.equal(result.unsearched.length, 0, JSON.stringify(result.diagnostics));
	await assert.rejects(runtime.screen({ ...revision, id: "fixture", paperId: "fixture" }, { id: "topic", library_id: "library", title: "Evaluation", question: "evaluation", focus: [], exclusions: [], revision: 1, active: true }, new AbortController().signal), /allowModelProcessing/);
	assert.equal(await hash(), before);
	console.log(JSON.stringify({ ok: true, backend: daemon.backend, model: embedding.profiles["local-qwen3"].model, dimension: 1024, parsed: true, semanticHit: true, sourceReadable: existsSync(revision.source), modelOptInEnforced: true, sharedConfigBefore: before, sharedConfigAfter: await hash(), cleanup: "only this run's temporary root" }, null, 2));
} finally {
	await releaseEmbedders();
	if (oldHome === undefined) delete process.env.AUTORAG_HOME; else process.env.AUTORAG_HOME = oldHome;
	if (oldConfig === undefined) delete process.env.AUTORAG_CONFIG; else process.env.AUTORAG_CONFIG = oldConfig;
	await rm(qaRoot, { recursive: true, force: true });
}
