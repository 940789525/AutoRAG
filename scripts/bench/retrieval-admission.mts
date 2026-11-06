/** Offline T-02 diagnostic: can raw cosine reject an entire irrelevant pool without losing required evidence? */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { defaultEmbeddingConfig, releaseEmbedders } from "../../src/embedding/index.ts";
import { type LocalEvidenceResult, localEvidence } from "../../src/indexing/evidence.ts";

const endpoint = process.env.AUTORAG_QA_EMBED_ENDPOINT;
const tokenizerPath = process.env.AUTORAG_QA_TOKENIZER;
assert(endpoint && tokenizerPath && ["127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname),
	"Use an owned loopback FastEmbed service and its matching tokenizer.");
const fixture = readFileSync(new URL("../../test/fixtures/retrieval-admission/score-probe.json", import.meta.url), "utf8");
type Row = [language: string, id: string, document: string, positive: string, negative: string];
const data = JSON.parse(fixture) as { calibration: Row[]; validation: Row[]; independentHumanReview: string };
const configPath = join(homedir(), ".autorag", "config.json");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const configHash = () => existsSync(configPath) ? hash(readFileSync(configPath)) : "absent";
const before = configHash();
const root = mkdtempSync(join(tmpdir(), "autorag-admission-probe-"));
process.env.AUTORAG_HOME = join(root, "home");
process.env.AUTORAG_CONFIG = join(root, "home", "config.json");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
mkdirSync(process.env.AUTORAG_HOME);
console.log("Isolated config:", process.env.AUTORAG_CONFIG);
const defaults = defaultEmbeddingConfig();
const profile = { ...defaults.profiles[defaults.defaultProfile], baseUrl: endpoint };

async function measure(split: "calibration" | "validation") {
	const workspace = join(root, split);
	const docs = join(workspace, "documents");
	mkdirSync(docs, { recursive: true });
	for (const [, id, body] of data[split]) writeFileSync(join(docs, id + ".txt"), body);
	const agent = new AutoRAGAgent({
		workspacePath: workspace, searchPaths: [docs], memoryPath: join(workspace, "memory.json"),
		embedding: { defaultProfile: defaults.defaultProfile, profiles: { [defaults.defaultProfile]: profile } },
		localIndex: { tokenizerPath }, jikji: false, fsearch: false, everything: false,
		dupey: false, webSearch: false, jev: false, rerank: false, memoryEmbedder: false,
	});
	try {
		const refresh = await agent.refresh(false, { methods: ["minsync"] });
		assert.equal(refresh.minsync?.ok, true, JSON.stringify(refresh.minsync));
		const method = agent.getMethodRegistry().get("local-vector")!;
		const rows = [];
		for (const [language, id, , positive, negative] of data[split]) {
			for (const [kind, query] of [["positive", positive], ["negative", negative]] as const) {
				const hits = await method.retrieve(query, { topK: 100 });
				const scores = hits.map((hit) => {
					const signal = (hit as LocalEvidenceResult)[localEvidence];
					assert(signal?.query === query && signal.profile && Number.isFinite(signal.cosine) && Math.abs(signal.cosine!) <= 1);
					return { id: basename(hit.source, ".txt"), cosine: signal.cosine!, profile: signal.profile };
				});
				assert(scores.length > 0);
				const relevant = scores.filter((s) => s.id === id);
				assert(kind === "negative" || relevant.length > 0, "required document not retrieved: " + id);
				rows.push({ language, id, kind, profile: scores[0].profile, rawCount: scores.length,
					score: Math.max(...(kind === "positive" ? relevant : scores).map((s) => s.cosine)) });
			}
		}
		return rows;
	} finally {
		await agent.indexJobs.close();
	}
}
try {
	const calibration = await measure("calibration");
	// With four positive families per language, even one miss is below 95%. Freeze before measuring validation.
	const thresholds = Object.fromEntries(["en", "zh"].map((language) => {
		const positives = calibration.filter((r) => r.language === language && r.kind === "positive");
		assert.equal(positives.length, 4);
		return [language, Math.min(...positives.map((r) => r.score))];
	}));
	const validation = await measure("validation");
	assert.equal(new Set([...calibration, ...validation].map((r) => r.profile)).size, 1,
		"Do not transfer a threshold across different retrieval profiles");
	const results = ["en", "zh"].map((language) => {
		const rows = validation.filter((r) => r.language === language);
		const fraction = (kind: string) => {
			const matching = rows.filter((r) => r.kind === kind);
			return matching.filter((r) => r.score >= thresholds[language]).length / matching.length;
		};
		const lowestRequired = Math.min(...rows.filter((r) => r.kind === "positive").map((r) => r.score));
		const highestDistractor = Math.max(...rows.filter((r) => r.kind === "negative").map((r) => r.score));
		return { language, threshold: thresholds[language], requiredRetention: fraction("positive"),
			unanswerableWithBody: fraction("negative"), lowestRequired, highestDistractor,
			// Four samples per class: 95% retention and <=5% false injection require perfect separation here.
			sampleSeparable: highestDistractor < lowestRequired };
	});
	console.log(JSON.stringify({ fixtureSha256: hash(fixture), independentHumanReview: data.independentHumanReview,
		calibration, validation, results, answerModelCalls: 0, remoteModelCalls: 0, kind: "forced-local-retrieval-probe",
		meetsSampleGates: results.every((r) => r.requiredRetention >= 0.95 && r.unanswerableWithBody <= 0.05),
		note: "Forced retrieval; this does not measure end-to-end injection rate, answer quality or provider cost." }));
} finally {
	try {
		await releaseEmbedders();
	} finally {
		rmSync(root, { recursive: true, force: true });
		assert.equal(configHash(), before);
		console.log("Removed owned workspace; real config hash unchanged:", before);
	}
}
