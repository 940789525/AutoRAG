/** Synthetic fixtures + real local retrieval; offline A–F selection analysis, never an answer-quality benchmark. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { type LocalEvidenceResult, localEvidence } from "../../src/indexing/evidence.ts";

if (process.argv.includes("--sessions")) {
	await import("./context-sessions.ts");
	process.exit(process.exitCode ?? 0);
}
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(name);
	return i < 0 ? fallback : args[i + 1];
};
const split = flag("--split", "dev");
assert(split === "dev" || split === "test");
if (split === "test")
	assert(args.includes("--allow-test"), "Freeze the experiment before explicitly allowing test-split access");
const limit = Number(flag("--limit", "48"));
assert(Number.isSafeInteger(limit) && limit > 0);
const budget = Number(flag("--budget", "6000"));
assert(Number.isSafeInteger(budget) && budget > 0);
const output = resolve(flag("--output", ".omo/evidence/context-selection-analysis.json"));
const dataset = new URL("../../test/fixtures/context-selection/cases.json", import.meta.url);
const raw = readFileSync(dataset, "utf8");
const input = JSON.parse(raw) as {
	independentHumanReview: string;
	cases: {
		id: string;
		group: string;
		split: string;
		query: string;
		documents: { id: string; text: string }[];
		gold: { facts: { evidenceDocumentIds: string[] }[] };
	}[];
};
const cases = input.cases.filter((c) => c.split === split).slice(0, limit);
assert(cases.length);
const root = mkdtempSync(join(tmpdir(), "autorag-context-bench-"));
const original = Object.fromEntries(
	["AUTORAG_HOME", "AUTORAG_CONFIG", "PI_CODING_AGENT_DIR"].map((k) => [k, process.env[k]]),
);
const homeConfig = join(homedir(), ".autorag", "config.json");
const configHash = () =>
	existsSync(homeConfig) ? createHash("sha256").update(readFileSync(homeConfig)).digest("hex") : "absent";
const before = configHash();
process.env.AUTORAG_HOME = join(root, "home");
process.env.AUTORAG_CONFIG = join(root, "config.json");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
mkdirSync(process.env.AUTORAG_HOME);
console.log(`QA config: ${process.env.AUTORAG_CONFIG}`);
const report: Record<string, unknown> = {
	kind: "offline-selection-analysis",
	split,
	budget,
	datasetSha256: createHash("sha256").update(raw).digest("hex"),
	independentHumanReview: input.independentHumanReview,
	realGeneration: false,
	answerPassRate: null,
	cumulativeInputTokens: null,
	answerLatencyMs: null,
	releaseGate: "not_evaluated",
	beforeConfigHash: before,
	implementationSha256: createHash("sha256")
		.update(
			[
				"agent/context-selection.ts",
				"agent/context-selection-projector.ts",
				"agent/agent.ts",
				"agent/pi-session.ts",
				"agent/evidence-ledger.ts",
				"indexing/evidence.ts",
				"indexing/method.ts",
				"indexing/pipeline.ts",
				"indexing/lance-store.ts",
				"indexing/types.ts",
				"cli/config.ts",
				"observability/run-log.ts",
			]
				.map((p) => p + "\n" + readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8"))
				.join("\n"),
		)
		.digest("hex"),
};
let close = async () => {};
try {
	const { AutoRAGAgent } = await import("../../src/agent/agent.ts");
	const { createEmbedderFromConfig, releaseEmbedders } = await import("../../src/embedding/index.ts");
	close = releaseEmbedders;
	const { isSimpleFactQuery, selectContextCandidates } = await import("../../src/agent/context-selection.ts");
	const { estimateEvidenceTokens } = await import("../../src/agent/context-selection-projector.ts");
	const docs = join(root, "docs");
	mkdirSync(docs);
	for (const c of cases) for (const doc of c.documents) writeFileSync(join(docs, `${doc.id}.txt`), doc.text);
	writeFileSync(
		process.env.AUTORAG_CONFIG,
		JSON.stringify({ workspacePath: root, searchPaths: [docs], minSync: { autoInstall: false } }),
	);
	const embedder = createEmbedderFromConfig({});
	const health = await embedder.health();
	assert(health.alive && health.backend !== "remote", JSON.stringify(health));
	report.embedding = { ...(await embedder.identity()), backend: health.backend };
	const agent = new AutoRAGAgent({
		embedder,
		workspacePath: root,
		searchPaths: [docs],
		memoryPath: join(root, "memory.json"),
		jikji: false,
		everything: false,
		fsearch: false,
		dupey: false,
		jev: false,
		rerank: false,
		memoryEmbedder: false,
	});
	const refresh = await agent.refresh(false, { methods: ["minsync"] });
	assert.equal(refresh.minsync?.ok, true);
	const rows: unknown[] = [];
	for (const c of cases) {
		const retrieved = await agent.retrieve(c.query, { topK: 100 });
		const candidates = retrieved.map((r, rank) => {
			const data = (r as LocalEvidenceResult)[localEvidence];
			return {
				key: r.id,
				source: r.source,
				rank,
				query: data?.query ?? c.query,
				profile: data?.profile ?? "",
				cosine: data?.cosine,
				vector: data?.vector,
				tokens: estimateEvidenceTokens(`[e${rank + 1}] ${r.source}\n${r.content.replace(/\s+/gu, " ")}\n`),
				priority: 0,
			};
		});
		for (const strategy of ["A", "B", "C", "D", "E", "F"]) {
			const conservative = !isSimpleFactQuery(c.query);
			let kept: readonly string[] = [];
			let tokens = 0;
			const timings: number[] = [];
			for (let repeat = 0; repeat < 3; repeat++) {
				const started = performance.now();
				if (strategy === "A" || (conservative && strategy === "F")) {
					kept = candidates.map((v) => v.key);
					tokens = candidates.reduce((sum, v) => sum + v.tokens, 0);
				} else if (strategy === "B") {
					kept = candidates.slice(0, 8).map((v) => v.key);
					tokens = candidates.slice(0, 8).reduce((sum, v) => sum + v.tokens, 0);
				} else {
					const result = selectContextCandidates(candidates, budget, {
						gap: strategy === "D" || strategy === "F",
						mmr: strategy === "E" || strategy === "F",
					});
					kept = result.selected;
					tokens = result.tokens;
				}
				timings.push(performance.now() - started);
			}
			const selectedSources = new Set(
				candidates.filter((v) => kept.includes(v.key)).map((v) => basename(v.source, ".txt")),
			);
			rows.push({
				caseId: c.id,
				group: c.group,
				strategy,
				conservative,
				candidateCount: candidates.length,
				selectedCount: kept.length,
				selectedIds: kept,
				evidenceTokensEstimated: tokens,
				selectionDurationsMs: timings,
				documentEvidenceRetention: c.gold.facts.length
					? c.gold.facts.filter((f) => f.evidenceDocumentIds.some((id) => selectedSources.has(id))).length /
						c.gold.facts.length
					: null,
				criticalFactCoverage: null,
				note: "Document identity retention is a proxy, not span-level support or answer quality; no model request was executed.",
			});
		}
	}
	report.rows = rows;
	report.status = "pass";
} catch (error) {
	report.status = "blocked_or_failed";
	report.error = error instanceof Error ? error.stack : String(error);
	process.exitCode = 1;
} finally {
	await close();
	report.afterConfigHash = configHash();
	report.configUnchanged = before === report.afterConfigHash;
	rmSync(root, { recursive: true, force: true });
	report.cleanup = { temporaryRootRemoved: !existsSync(root), existingDaemonUntouched: true };
	for (const [k, v] of Object.entries(original)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
	assert.equal(before, report.afterConfigHash);
	console.log(JSON.stringify({ status: report.status, error: report.error, output, realGeneration: false }));
}
