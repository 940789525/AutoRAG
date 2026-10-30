/** Real-provider session experiments. No credential copying, default execution, private corpus, or simulated quality claims. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { AutoRAGAgent } from "../../src/agent/agent.ts";
import { CONTEXT_SELECTION_VERSION } from "../../src/agent/context-selection.ts";
import {
	type ContextSelectionExperiment,
	ContextSelectionProjector,
	type ContextSelectionReport,
} from "../../src/agent/context-selection-projector.ts";
import type { EvidenceLedger } from "../../src/agent/evidence-ledger.ts";
import { READ_LOCAL_EVIDENCE_TOOL_NAME } from "../../src/agent/read-local-evidence-tool.ts";
import { createEmbedderFromConfig, releaseEmbedders } from "../../src/embedding/index.ts";
import { contextSessionCases } from "./context-session-cases.ts";
import { parseReadOnlyCredential, readOnlyCodexCredentials } from "./context-session-credentials.ts";
import { summarizeContextTrials, type TrialMetrics } from "./context-session-metrics.ts";
import { ContextV1Adapter } from "./context-v1-adapter.ts";

const args = process.argv.slice(2);
let fatalProviderError: string | undefined;
const flag = (name: string, fallback: string) => {
	const at = args.indexOf(name);
	if (at < 0) return fallback;
	assert(args[at + 1] && !args[at + 1].startsWith("--"), `Missing value for ${name}`);
	return args[at + 1];
};
const split = flag("--split", "dev");
assert(split === "dev" || split === "test");
if (split === "test")
	assert(args.includes("--allow-test"), "Freeze and review the experiment before enabling test-split access");
const limit = Number(flag("--limit", "12"));
const repeats = Number(flag("--repeats", "3"));
const timeoutMs = Number(flag("--timeout-ms", "60000"));
for (const value of [limit, repeats, timeoutMs]) assert(Number.isSafeInteger(value) && value > 0);
const variants = flag("--variants", "A,B,C,D,E,F").split(",");
assert(variants.length && new Set(variants).size === variants.length && variants.every((v) => /^[A-F]$/u.test(v)));
const output = resolve(flag("--output", ".omo/evidence/context-sessions-real.json"));
const caseId = flag("--case", "");
const contextWindow = args.includes("--context-window") ? Number(flag("--context-window", "")) : undefined;
assert(contextWindow === undefined || (Number.isSafeInteger(contextWindow) && contextWindow >= 4096));
const authDir = resolve(flag("--auth-dir", process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")));
const homeConfig = join(homedir(), ".autorag", "config.json");
const hashFile = (path: string) =>
	existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const protectedPaths = [homeConfig, join(authDir, "auth.json"), join(authDir, "settings.json")];
const before = protectedPaths.map(hashFile);
const root = mkdtempSync(join(tmpdir(), "autorag-session-experiment-"));
const saved = Object.fromEntries(
	["AUTORAG_HOME", "AUTORAG_CONFIG", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
);
process.env.AUTORAG_HOME = join(root, "home");
process.env.AUTORAG_CONFIG = join(root, "config.json");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
mkdirSync(process.env.AUTORAG_HOME);
mkdirSync(process.env.PI_CODING_AGENT_DIR);
assert(process.env.AUTORAG_CONFIG.startsWith(`${root}/`));
const cases = contextSessionCases()
	.filter((c) => c.split === split && (!caseId || c.id === caseId))
	.slice(0, limit);
const trials: Record<string, unknown>[] = [];
const report: Record<string, unknown> = {
	kind: "real-provider-multiturn-context-experiment",
	version: CONTEXT_SELECTION_VERSION,
	status: "not_started",
	realGeneration: false,
	independentHumanReview: "pending",
	releaseGate: "not_evaluated",
	split,
	repeats,
	timeoutMs,
	variants,
	caseCount: cases.length,
	concurrentSuiteWorkers: Number(process.env.AUTORAG_BENCH_CONCURRENCY ?? "1"),
	experimentalContextWindow: contextWindow ?? null,
	costBasis: "Installed Pi model catalog prices applied to reported usage; not a provider billing invoice",
	datasetSha256: createHash("sha256").update(JSON.stringify(contextSessionCases())).digest("hex"),
	implementationSha256: createHash("sha256")
		.update(
			[
				"src/agent/agent.ts",
				"src/agent/pi-session.ts",
				"scripts/bench/context-session-credentials.ts",
				"src/agent/context-selection-projector.ts",
				"src/agent/context-selection.ts",
				"src/agent/read-local-evidence-tool.ts",
				"src/indexing/evidence-reader.ts",
				"src/indexing/pipeline.ts",
				"src/indexing/method.ts",
				"src/mirror/sync.ts",
				"scripts/bench/context-session-cases.ts",
				"scripts/bench/context-session-metrics.ts",
				"scripts/bench/context-v1-adapter.ts",
				"scripts/bench/historical/context-selection-projector.ts",
				"scripts/bench/historical/context-selection.ts",
				"scripts/bench/context-sessions.ts",
			]
				.map((path) => `${path}\n${readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")}`)
				.join("\n"),
		)
		.digest("hex"),
	comparison:
		"A-E exclude read_local_evidence; F adds its schema and necessary description. Only C/D/E/F use internal mechanism interventions; no product config flags.",
	grading:
		"Exact gold-term coverage is a diagnostic proxy, not factual correctness or citation support; independent semantic/human grading remains required.",
	usageScope:
		"Jev, query decomposition, rerank, web and memory embeddings are disabled in all arms. Model usage covers answer_session and actual Pi compaction. Missing usage/cost remains unavailable.",
	cacheControl:
		"Provider/shared cache is not cleared or isolated with prompt nonces. Repeated sessions are sequential warm opportunities, not proven cache hits or guaranteed cold starts.",
	trials,
};

interface BenchInternals {
	tools: readonly AgentTool[];
	contextSelection: ContextSelectionProjector;
	evidenceLedger: EvidenceLedger;
	baseSystemPromptConfig: { toolNames: readonly string[] };
}

try {
	const reviewPath = resolve(flag("--review-manifest", ".omo/evidence/context-session-review-attestation.json"));
	if (args.includes("--run-real") && existsSync(reviewPath)) {
		const review = JSON.parse(readFileSync(reviewPath, "utf8"));
		assert(
			review.datasetSha256 === report.datasetSha256 && review.implementationSha256 === report.implementationSha256,
			"Review manifest does not match the frozen dataset and implementation",
		);
		assert(
			review.reviewMethod === "single_agent_automated_authorized_by_user" && review.independentHumanReview === false,
			"Unsupported or misleading review attestation",
		);
		report.review = review;
		report.independentHumanReview = "not_performed_user_authorized_single_agent_review";
	}
	if (args.includes("--run-real") && split === "test")
		assert(report.review, "Freeze and record the authorized review method before opening the test split");
	assert(cases.length > 0, "No case matches the requested split and case ID");
	if (!args.includes("--run-real")) {
		report.status = "preflight_only";
		report.reason = "Use --run-real only with an existing authorized provider and this non-sensitive fixture corpus";
	} else {
		const settings = JSON.parse(readFileSync(join(authDir, "settings.json"), "utf8")) as {
			defaultProvider?: string;
			defaultModel?: string;
		};
		const provider = flag("--provider", settings.defaultProvider ?? "");
		const modelId = flag("--model", settings.defaultModel ?? "");
		const thinking = args.includes("--thinking") ? flag("--thinking", "") : undefined;
		assert(
			thinking === undefined || thinking === "low",
			"This experiment supports the explicitly requested low thinking override only",
		);
		assert(provider && modelId, "No explicitly selected model");
		const model = getModel(provider as never, modelId as never);
		assert(model, "Selected model is absent from the installed Pi catalog; do not silently switch providers");
		assert(
			contextWindow === undefined || contextWindow <= model.contextWindow,
			"Experimental context window must not exceed the selected model's actual window",
		);
		const modelsPath = join(authDir, "models.json");
		if (existsSync(modelsPath)) {
			const custom = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, unknown> };
			assert(
				!custom.providers?.[provider],
				"Selected provider has custom model configuration; this runner will not silently substitute the built-in endpoint",
			);
		}
		let apiKey: string | undefined;
		let piCredentials: ReturnType<typeof readOnlyCodexCredentials> | undefined;
		if (args.includes("--credential-stdin")) {
			assert(
				args.includes("--provider") && args.includes("--model") && provider === "openai-codex",
				"Read-only credential stdin requires an explicit Codex target",
			);
			const credential = parseReadOnlyCredential(readFileSync(0, "utf8"));
			piCredentials = readOnlyCodexCredentials(credential);
			report.authentication = {
				mode: "existing_codex_oauth_in_memory_no_refresh",
				sourceHash: credential.sourceHash,
			};
			report.costBasis =
				"Existing Codex subscription; Pi catalog API-equivalent estimates only, actual subscription credits/usage consumption is unavailable";
		} else {
			const auth = JSON.parse(readFileSync(join(authDir, "auth.json"), "utf8")) as Record<
				string,
				{ type?: string; key?: string }
			>;
			const credential = auth[provider];
			assert(
				credential?.type === "api_key" && typeof credential.key === "string" && credential.key.length,
				"This read-only runner needs an existing API-key credential; OAuth refresh/copy is not performed",
			);
			// Pi accepts env references; never pass an unresolved reference or a shell command as a credential.
			assert(
				!/^[A-Z][A-Z0-9_]*$/u.test(credential.key) || process.env[credential.key],
				"Credential environment reference is unavailable",
			);
			apiKey = process.env[credential.key] ?? credential.key;
			assert(!apiKey.startsWith("!") && !apiKey.includes("\n"), "Unsupported credential reference");
		}
		const embedder = createEmbedderFromConfig({});
		const health = await embedder.health();
		assert(health.alive && health.backend !== "remote", JSON.stringify(health));
		const identity = await embedder.identity();
		assert(identity.model === "Qwen/Qwen3-Embedding-0.6B" && identity.dimension === 1024, JSON.stringify(identity));
		report.embedding = { ...identity, backend: health.backend, remote: false };
		report.model = {
			provider: model.provider,
			id: model.id,
			api: model.api,
			contextWindow: model.contextWindow,
			cost: model.cost,
			maxOutputTokens: Math.min(model.maxTokens, 8192),
			thinking: thinking ?? "runtime_default",
		};
		let hasFailure = false;
		report.historicalControl = JSON.parse(
			readFileSync(new URL("./historical/provenance.json", import.meta.url), "utf8"),
		);
		report.status = "running";
		const compaction = {
			enabled: false,
			reserveTokens: Math.min(16384, Math.floor((contextWindow ?? model.contextWindow) / 4)),
			keepRecentTokens: 1,
		};
		writeFileSync(join(root, "pi/settings.json"), JSON.stringify({ compaction }));
		report.compactionSettings = compaction;
		report.compactionControl =
			"Automatic Pi compaction disabled equally in all arms; M5 manually compacts with a one-token retained tail so the short fixture has a real summary boundary. This is a lifecycle intervention, not the product default or a natural-capacity benchmark.";
		trialLoop: for (const task of cases) {
			const taskRoot = join(root, task.id);
			const docs = join(taskRoot, "docs");
			mkdirSync(docs, { recursive: true });
			const reset = () => {
				for (const doc of task.documents) writeFileSync(join(docs, doc.name), doc.text);
			};
			reset();
			const localIndex = {
				...(process.env.AUTORAG_QA_TOKENIZER_PATH ? { tokenizerPath: process.env.AUTORAG_QA_TOKENIZER_PATH } : {}),
			};
			const base = {
				embedder,
				localIndex,
				model: {
					...model,
					contextWindow: contextWindow ?? model.contextWindow,
					maxTokens: Math.min(model.maxTokens, 8192),
				},
				apiKey,
				piCredentials,
				...(thinking === "low" ? { thinking: { fast: "low" as const, final: "low" as const } } : {}),
				workspacePath: taskRoot,
				searchPaths: [docs],
				piAgentDir: join(root, "pi"),
				piSessionDir: join(root, "sessions"),
				jikji: false as const,
				everything: false as const,
				fsearch: false as const,
				webSearch: false as const,
				jev: false as const,
				rerank: false as const,
				dupey: false as const,
				filee: false as const,
				memoryEmbedder: false as const,
				excludeExactDuplicates: false,
				timeoutMs,
				permissionMode: "ask" as const,
			};
			for (let repeat = 0; repeat < repeats; repeat++) {
				// Rotate intervention order so one arm is not always the first cache user. Report residual contamination.
				const order = [...variants.slice(repeat % variants.length), ...variants.slice(0, repeat % variants.length)];
				for (const variant of order) {
					reset();
					const trialRoot = join(taskRoot, `${variant}-${repeat}`);
					const memoryPath = join(trialRoot, "memory.json");
					const agent = new AutoRAGAgent({
						...base,
						memoryPath,
						contextSelection: { mode: variant === "A" ? "off" : "adaptive", evidenceBudgetTokens: 6000 },
					});
					const internal = agent as unknown as BenchInternals;
					const selection: ContextSelectionReport[] = [];
					if (variant === "B") {
						internal.contextSelection = new ContextV1Adapter((report) => selection.push(report));
					} else if (variant !== "A") {
						const intervention: ContextSelectionExperiment = {
							deduplicate: variant !== "C",
							compact: variant === "E" || variant === "F",
							semanticSelection: false,
						};
						internal.contextSelection = new ContextSelectionProjector(
							{ mode: "adaptive", evidenceBudgetTokens: 6000 },
							(r) => selection.push(r),
							intervention,
						);
					}
					const allowed = new Set([
						"semantic_search_local_docs",
						"search_all_documents",
						...(variant === "F" ? [READ_LOCAL_EVIDENCE_TOOL_NAME] : []),
					]);
					internal.tools = internal.tools.filter((tool) => allowed.has(tool.name));
					internal.baseSystemPromptConfig.toolNames = internal.baseSystemPromptConfig.toolNames.filter((name) =>
						allowed.has(name),
					);
					const refresh = await agent.refresh(false, { methods: ["minsync"] });
					assert(refresh.minsync?.ok, JSON.stringify(refresh.minsync));
					const runtime = await agent.createPiInteractiveRuntime();
					runtime.runtime.session.setActiveToolsByName([...allowed]);
					let toolCalls = 0;
					let readCalls = 0;
					let readErrors = 0;
					const readStarted = new Map<string, number>();
					const readObservations: Record<string, unknown>[] = [];
					let budgetExceeded = false;
					const unsubscribe = agent.subscribe((event) => {
						if (event.type === "tool_execution_start") {
							toolCalls++;
							if (event.toolName === READ_LOCAL_EVIDENCE_TOOL_NAME) {
								readCalls++;
								readStarted.set(event.toolCallId, performance.now());
							}
							if (toolCalls > 24) {
								budgetExceeded = true;
								agent.abort();
							}
						}
						if (event.type === "tool_execution_end" && event.toolName === READ_LOCAL_EVIDENCE_TOOL_NAME) {
							if (event.isError) readErrors++;
							const details = event.result.details as { text?: string; complete?: boolean } | undefined;
							const started = readStarted.get(event.toolCallId);
							readStarted.delete(event.toolCallId);
							readObservations.push({
								callId: event.toolCallId,
								isError: event.isError,
								latencyMs: started === undefined ? null : performance.now() - started,
								bytes:
									!event.isError && typeof details?.text === "string"
										? Buffer.byteLength(details.text, "utf8")
										: null,
								complete: !event.isError && details?.complete === true,
								...(event.isError
									? {
											error: event.result.content
												.filter((part: { type: string; text?: string }) => part.type === "text")
												.map((part: { type: string; text?: string }) => part.text ?? "")
												.join("\n"),
										}
									: {}),
							});
						}
					});
					const turns: Record<string, unknown>[] = [];
					const started = performance.now();
					let evidenceId: string | undefined;
					try {
						for (const [turnIndex, turn] of task.turns.entries()) {
							if (budgetExceeded) {
								turns.push({ turnIndex, status: "budget_exceeded" });
								continue;
							}
							if (turn.action === "update") {
								writeFileSync(join(docs, "policy.md"), task.updatedPolicy);
								await agent.refresh(true, { methods: ["minsync"] });
							}
							if (turn.action === "compact") await runtime.runtime.session.compact();
							assert(
								!turn.question.includes("{{evidenceId}}") || evidenceId,
								"No trusted policy evidence ID was issued",
							);
							const question = turn.question.replace("{{evidenceId}}", evidenceId ?? "");
							const at = performance.now();
							const messagesBefore = runtime.runtime.session.messages.length;
							const response = await agent.searchDocuments(question);
							const answer = response.answer ?? "";
							const hasModelError =
								response.diagnostics?.some(
									(item) => item.code === "no-final-answer" || item.code === "model-request-failed",
								) ||
								runtime.runtime.session.messages
									.slice(messagesBefore)
									.some(
										(message) =>
											message.role === "assistant" &&
											(message.stopReason === "error" || message.stopReason === "aborted"),
									);
							turns.push({
								turnIndex,
								status: hasModelError ? "model_error" : "completed",
								latencyMs: performance.now() - at,
								goldTermMatches: turn.goldTerms.map((term) => ({
									term,
									present: answer.toLowerCase().includes(term.toLowerCase()),
								})),
								answer,
								results: response.results,
								evidence: internal.evidenceLedger.localReadEntries().map(({ localReadHandle, ...entry }) => ({
									...entry,
									bodySha256: localReadHandle?.bodySha256,
								})),
								resultCount: response.results.length,
								diagnostics: response.diagnostics,
							});
							if (hasModelError) hasFailure = true;
							const providerError = response.diagnostics?.find(
								(item) => item.code === "model-request-failed",
							)?.message;
							if (
								providerError &&
								/\b(?:401|402|403)\b|insufficient_balance|usage_limit|quota.{0,40}(?:exceed|reached)/iu.test(
									providerError,
								)
							) {
								fatalProviderError = providerError;
								break;
							}
							if (!evidenceId)
								evidenceId = internal.evidenceLedger
									.localReadEntries()
									.find(
										(entry) =>
											entry.content.includes("ordinary refund threshold") &&
											entry.source.endsWith("policy.md") &&
											!entry.source.endsWith("retired-policy.md"),
									)?.id;
						}
					} catch (error) {
						hasFailure = true;
						turns.push({ status: "failed", error: error instanceof Error ? error.message : String(error) });
					} finally {
						unsubscribe();
						await runtime.dispose();
					}
					const log = join(dirname(memoryPath), "logs/runs.jsonl");
					const usage = existsSync(log)
						? readFileSync(log, "utf8")
								.trim()
								.split("\n")
								.filter(Boolean)
								.map((line) => JSON.parse(line))
								.filter((event) => event.event === "model_usage")
						: [];
					const sum = (field: string) =>
						usage.length &&
						usage.every((event) => event.usageReported !== false && typeof event[field] === "number")
							? usage.reduce((n, event) => n + event[field], 0)
							: null;
					trials.push({
						caseId: task.id,
						group: task.group,
						family: task.family,
						variant,
						repeat,
						status: turns.some((t) => t.status !== "completed") ? "failed" : "completed",
						latencyMs: performance.now() - started,
						turns,
						toolCalls,
						readCalls,
						readErrors,
						readObservations,
						budgetExceeded,
						usage,
						inputTokens: sum("inputTokens"),
						cacheReadTokens: sum("cacheReadTokens"),
						cacheWriteTokens: sum("cacheWriteTokens"),
						outputTokens: sum("outputTokens"),
						cost: sum("cost"),
						usageCoverage: {
							attempts: usage.length,
							withReportedUsage: usage.filter((event) => event.usageReported).length,
						},
						selection,
						schemaSha256: createHash("sha256")
							.update(
								JSON.stringify(
									internal.tools.map(({ name, description, parameters }) => ({
										name,
										description,
										parameters,
									})),
								),
							)
							.digest("hex"),
					});
					report.realGeneration =
						usage.some((event) => event.inputTokens > 0 || event.outputTokens > 0) || report.realGeneration;
					mkdirSync(dirname(output), { recursive: true });
					writeFileSync(output, JSON.stringify(report, null, 2));
					if (fatalProviderError) {
						report.fatalProviderError = fatalProviderError;
						break trialLoop;
					}
				}
			}
		}
		report.status = fatalProviderError
			? "blocked_provider"
			: hasFailure
				? "completed_with_failures"
				: trials.some((trial) => trial.status === "blocked")
					? "completed_with_blocks"
					: "completed";
		report.releaseGate = "pending_automated_quality_cost_scoring_cache_control_unavailable";
		if (fatalProviderError) process.exitCode = 1;
	}
} catch (error) {
	report.status = "blocked_or_failed";
	report.error = error instanceof Error ? error.message : String(error);
	process.exitCode = 1;
} finally {
	report.summary = summarizeContextTrials(trials as unknown as TrialMetrics[]);
	report.expectedTrials = cases.length * repeats * variants.length;
	report.recordedTrials = trials.length;
	report.notRunTrials = cases.length * repeats * variants.length - trials.length;
	await releaseEmbedders();
	const after = protectedPaths.map(hashFile);
	report.sharedConfigUnchanged = before.every((hash, i) => hash === after[i]);
	report.protectedFileHashes = protectedPaths.map((path, i) => ({
		file: path.endsWith("auth.json") ? "Pi auth" : path.endsWith("settings.json") ? "Pi settings" : "AutoRAG config",
		before: before[i],
		after: after[i],
	}));
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
	report.cleanup = { temporaryRootRemoved: !existsSync(root), existingDaemonChanged: false };
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(report, null, 2));
	console.log(
		JSON.stringify({
			output,
			status: report.status,
			realGeneration: report.realGeneration,
			releaseGate: report.releaseGate,
			sharedConfigUnchanged: report.sharedConfigUnchanged,
		}),
	);
	if (!report.sharedConfigUnchanged) process.exitCode = 1;
}
