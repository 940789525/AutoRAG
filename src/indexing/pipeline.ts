import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileAtomic } from "../mirror/atomic-write.ts";
import { loadMirrorIndex } from "../mirror/index-store.ts";
import { CHUNKER_VERSION, chunkMarkdown, contentHash } from "./chunker.ts";
import type { LocalReadHandle } from "./evidence.ts";
import {
	type EvidenceRevision,
	evidenceHandle,
	MAX_EVIDENCE_BODY_BYTES,
	readEvidenceRevision,
	verifyEvidenceRevision,
} from "./evidence-reader.ts";
import { IndexJournal } from "./journal.ts";
import { LanceIndexStore } from "./lance-store.ts";
import { acquireIndexLease } from "./lease.ts";
import { createLexicalAnalyzer } from "./lexical.ts";
import { loadIndexTokenizer } from "./tokenizer.ts";
import type {
	IndexDocument,
	IndexEvent,
	IndexPhase,
	IndexReport,
	IndexRow,
	IndexStore,
	LexicalAnalyzer,
	LocalIndexOptions,
	TokenCounter,
} from "./types.ts";

interface Context {
	model: string;
	profile: string;
	dimension: number;
	store: IndexStore;
	tokenizer(signal?: AbortSignal): Promise<TokenCounter>;
	analyzer: LexicalAnalyzer;
	maxInputTokens: number;
	queryPrefix: string;
	passagePrefix: string;
	handlesRetries: boolean;
}

/** Owns the indexing workflow. External engines only implement embedding or individual database operations. */
export class LocalDocumentIndex {
	readonly directory: string;
	private readonly options: LocalIndexOptions;
	private contextPromise: Promise<Context> | undefined;
	private lastQuery:
		| { text: string; at: number; vector: Promise<readonly number[]>; signal?: AbortSignal }
		| undefined;
	private candidateReady?: Record<string, unknown>;
	constructor(options: LocalIndexOptions) {
		const readyPath = join(options.root, ".autorag", "local-index", "ready.json");
		let generation = options.generation;
		if (generation === undefined && existsSync(readyPath)) {
			const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
				generation?: string;
				embeddingFingerprint?: string;
				semanticFingerprint?: string;
			};
			if (
				ready.embeddingFingerprint === options.embeddingFingerprint &&
				ready.semanticFingerprint === options.semanticFingerprint
			)
				generation = ready.generation;
		}
		this.options = { ...options, generation };
		if ((options.maxTokens ?? 768) + 8 > (options.maxInputTokens ?? 2048))
			throw new RangeError(
				"localIndex.maxTokens exceeds the serving runtime's maxInputTokens (including special-token reserve)",
			);
		this.directory = join(options.root, ".autorag", "local-index");
		for (const [name, value] of Object.entries({
			batchSize: options.batchSize,
			maxBatchTokens: options.maxBatchTokens,
		})) {
			if (value !== undefined && (!Number.isInteger(value) || value < 1))
				throw new RangeError(`localIndex.${name} must be a positive integer`);
		}
	}
	/** Optional read locators are derived only from verified parser metadata and exact indexed chunks. */
	async readHandles(
		hits: readonly import("./types.ts").IndexHit[],
		authorize: (source: string, sourceId: string) => boolean,
		signal?: AbortSignal,
	): Promise<ReadonlyMap<string, LocalReadHandle>> {
		const entries = loadMirrorIndex(this.options.root).entries;
		const revisions = new Map<string, Promise<EvidenceRevision | undefined>>();
		const handles = new Map<string, LocalReadHandle>();
		for (const hit of hits) {
			const entry = entries[hit.row.source_id];
			if (!entry || !hit.profile || entry.sourcePath !== hit.row.source_path) continue;
			let revision = revisions.get(entry.virtualPath);
			if (!revision) {
				revision = readEvidenceRevision(this.options.root, entry, authorize, signal);
				revisions.set(entry.virtualPath, revision);
			}
			const verified = await revision;
			const handle = verified && evidenceHandle(hit.row, hit.profile, verified);
			if (handle) handles.set(hit.row.id, handle);
		}
		return handles;
	}
	async readEvidence(
		handle: LocalReadHandle,
		authorize: (source: string, sourceId: string) => boolean,
		signal?: AbortSignal,
	) {
		signal?.throwIfAborted();
		if (!authorize(handle.source, handle.sourceId))
			throw new Error("Local evidence is outside the current search roots or scope");
		const readyText = readFileSync(join(this.directory, "ready.json"), "utf8");
		const ready = JSON.parse(readyText) as { version?: number; profile?: string };
		if (ready.version !== 1 || ready.profile !== handle.profile || this.readinessError())
			throw new Error("Local evidence index profile changed; refresh and search again");
		const revision = await verifyEvidenceRevision(this.options.root, handle, authorize, signal);
		const store =
			this.options.store ?? (await LanceIndexStore.openExisting(join(this.directory, handle.profile, "store")));
		if (!store.readChunk) throw new Error("Local index does not support exact evidence reads");
		const row = await store.readChunk(handle.sourceId, handle.chunkId);
		signal?.throwIfAborted();
		if (
			!row ||
			row.id !== handle.chunkId ||
			row.source_id !== handle.sourceId ||
			row.source_path !== loadMirrorIndex(this.options.root).entries[handle.sourceId]?.sourcePath ||
			row.text !== revision.markdown.slice(row.start, row.end) ||
			contentHash(row.text) !== handle.bodySha256
		)
			throw new Error("Local evidence chunk version is unavailable; refresh and search again");
		const bytes = Buffer.byteLength(row.text, "utf8");
		if (bytes > MAX_EVIDENCE_BODY_BYTES)
			throw new Error(`Local evidence body is ${bytes} bytes, exceeding the ${MAX_EVIDENCE_BODY_BYTES} byte limit`);
		await verifyEvidenceRevision(this.options.root, handle, authorize, signal);
		if (readFileSync(join(this.directory, "ready.json"), "utf8") !== readyText)
			throw new Error("Local evidence index changed while reading; search again");
		signal?.throwIfAborted();
		return row;
	}
	isReady(): boolean {
		return this.status() !== "configured";
	}
	/** Inventory checks committed membership only; it never initializes an embedder or index. */
	registeredSources(ids: readonly string[]): Set<string> {
		const path = join(this.directory, "ready.json");
		const pointer = readFileSync(path, "utf8");
		const readinessError = this.readinessError();
		if (readinessError) throw new Error(readinessError);
		const { profile } = JSON.parse(pointer);
		if (typeof profile !== "string" || !/^[a-f0-9]{64}$/u.test(profile))
			throw new Error(`Invalid local index profile in ${path}`);
		const registered = IndexJournal.registeredSources(join(this.directory, profile), ids);
		if (readFileSync(path, "utf8") !== pointer) throw new Error("Local index changed while checking registration");
		return registered;
	}
	/** Explain why a persisted index cannot be queried without opening or modifying its store. */
	readinessError(): string | undefined {
		const path = join(this.directory, "ready.json");
		const recovery = `run autorag refresh --method local with the same --config used for this query (${this.directory})`;
		if (!existsSync(path)) return `Local index is not ready: ready.json is missing; ${recovery}`;
		const ready = JSON.parse(readFileSync(path, "utf8")) as {
			version?: number;
			model?: string;
			dimension?: number;
			embeddingFingerprint?: string;
		};
		if (ready.version !== 1)
			return `Local index is not ready: unsupported index version ${ready.version}; ${recovery}`;
		if (
			this.options.identity &&
			(ready.model !== this.options.identity.model || ready.dimension !== this.options.identity.dimension)
		)
			return `Local index is not ready: embedding identity mismatch (indexed: ${ready.model}, ${ready.dimension} dimensions; configured: ${this.options.identity.model}, ${this.options.identity.dimension} dimensions); ${recovery}`;
		if (ready.embeddingFingerprint !== this.options.embeddingFingerprint)
			return `Local index is not ready: embedding configuration changed; ${recovery}`;
		return undefined;
	}
	status(): "configured" | "ready" | "degraded" {
		if (this.readinessError()) return "configured";
		const ready = JSON.parse(readFileSync(join(this.directory, "ready.json"), "utf8")) as {
			partial?: boolean;
			profile?: string;
		};
		if (ready.profile && existsSync(join(this.directory, ready.profile, "maintenance-needed"))) return "degraded";
		const lastReport = join(this.directory, "last-run.json");
		if (existsSync(lastReport) && (JSON.parse(readFileSync(lastReport, "utf8")) as { ok?: boolean }).ok === false)
			return "degraded";
		return ready.partial ? "degraded" : "ready";
	}
	private async context(): Promise<Context> {
		this.contextPromise ??= (async () => {
			const identity = this.options.identity ?? (await this.options.embedder.identity());
			const capabilities = await this.options.embedder.capabilities?.();
			const maxInputTokens = Math.min(this.options.maxInputTokens ?? 2048, capabilities?.maxInputTokens ?? 2048);
			if ((this.options.maxTokens ?? 768) + 8 > maxInputTokens)
				throw new Error(
					`localIndex.maxTokens exceeds the active embedding backend limit (${maxInputTokens} tokens)`,
				);
			if (!Number.isInteger(identity.dimension) || identity.dimension <= 0)
				throw new Error("embedding identity has an invalid dimension");
			const profile = contentHash(
				JSON.stringify([
					identity,
					capabilities?.passagePrefix ?? "",
					this.options.embeddingFingerprint ?? "",
					this.options.generation,
				]),
			);
			let tokenizerPromise: Promise<TokenCounter> | undefined;
			const tokenizer = async (tokenizerSignal?: AbortSignal): Promise<TokenCounter> => {
				tokenizerPromise ??= this.options.tokenizer
					? Promise.resolve(this.options.tokenizer)
					: loadIndexTokenizer({
							root: this.options.root,
							model: identity.model,
							tokenizerPath: this.options.tokenizerPath,
							signal: tokenizerSignal,
						});
				try {
					return await tokenizerPromise;
				} catch (error) {
					tokenizerPromise = undefined;
					throw error;
				}
			};
			const analyzer =
				this.options.analyzer ??
				createLexicalAnalyzer({ root: this.options.root, koreanModelPath: this.options.koreanModelPath });
			const store =
				this.options.store ??
				(await LanceIndexStore.open(join(this.directory, profile, "store"), identity.dimension));
			return {
				profile,
				model: identity.model,
				dimension: identity.dimension,
				tokenizer,
				analyzer,
				store,
				maxInputTokens,
				queryPrefix: capabilities?.queryPrefix ?? "",
				passagePrefix: capabilities?.passagePrefix ?? "",
				handlesRetries: capabilities?.handlesRetries ?? false,
			};
		})();
		try {
			return await this.contextPromise;
		} catch (error) {
			this.contextPromise = undefined;
			throw error;
		}
	}
	/** Source iterator completion certifies the complete preserved source set; failures never trigger a deletion sweep. */
	async sync(
		documents?: AsyncIterable<IndexDocument>,
		options: {
			force?: boolean;
			signal?: AbortSignal;
			onEvent?: (event: IndexEvent) => void;
			activate?: boolean;
		} = {},
	): Promise<IndexReport> {
		options.signal?.throwIfAborted();
		this.candidateReady = undefined;
		const release = acquireIndexLease(this.directory);
		const runId = randomUUID();
		const runDirectory = join(this.directory, "runs", runId);
		const started = performance.now();
		const timings: Partial<Record<IndexPhase, number>> = {};
		const events: IndexEvent[] = [];
		const failures: { path: string; stage: string; error: string }[] = [];
		let journal: IndexJournal | undefined;
		let processed = 0;
		let unchanged = 0;
		let chunkCount = 0;
		let embedded = 0;
		let reused = 0;
		let deleted = 0;
		let fatal: unknown;
		let failed = false;
		const event = (value: Omit<IndexEvent, "runId" | "elapsedMs">): void => {
			const entry: IndexEvent = {
				runId,
				elapsedMs: performance.now() - started,
				progress: { documents: processed, unchanged, chunks: chunkCount, embedded, reused, deleted },
				...value,
			};
			events.push(entry);
			try {
				this.options.onEvent?.(entry);
			} catch {
				/* Observers cannot change indexing results. */
			}
			try {
				options.onEvent?.(entry);
			} catch {
				/* Observers cannot change indexing results. */
			}
			if (
				events.length >= 64 ||
				value.state === "error" ||
				(value.state === "start" && ["prepare", "embed", "maintain"].includes(value.phase))
			)
				flushEvents();
		};
		const flushEvents = (): void => {
			if (!events.length) return;
			writeFileSync(
				join(runDirectory, "events.jsonl"),
				events
					.splice(0)
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
				{ flag: "a" },
			);
		};
		const stage = async <T>(
			phase: IndexPhase,
			run: () => Promise<T>,
			source?: string,
			count?: number,
		): Promise<T> => {
			options.signal?.throwIfAborted();
			const start = performance.now();
			event({ phase, state: "start", source, count });
			try {
				const value = await run();
				const durationMs = performance.now() - start;
				timings[phase] = (timings[phase] ?? 0) + durationMs;
				event({ phase, state: "end", source, count, durationMs });
				return value;
			} catch (error) {
				const durationMs = performance.now() - start;
				timings[phase] = (timings[phase] ?? 0) + durationMs;
				event({ phase, state: "error", source, count, durationMs, detail: errorText(error) });
				throw error;
			}
		};
		try {
			mkdirSync(runDirectory, { recursive: true });
			const context = await stage("prepare", () => this.context());
			this.lastQuery = undefined;
			journal = new IndexJournal(join(this.directory, context.profile));
			const maintenanceMarker = join(this.directory, context.profile, "maintenance-needed");
			let dirty = existsSync(maintenanceMarker);
			const markDirty = (): void => {
				if (!dirty) writeFileSync(maintenanceMarker, "", { flush: true });
				dirty = true;
			};
			if (journal.hasPending()) markDirty();
			const recovered = await stage("write", () => journal!.recover(context.store));
			const seen = new Set<string>();
			const rejected = new Set<string>();
			let pending: { id: string; fingerprint: string; rows: IndexRow[] }[] = [];
			let pendingTokens = 0;
			dirty ||= recovered > 0;
			let consecutiveFailures = 0;
			let embeddingReady = false;
			const validVector = (vector: readonly number[]): boolean =>
				vector.length === context.dimension && vector.every(Number.isFinite) && vector.some((n) => n !== 0);
			const flush = async (): Promise<void> => {
				if (!pending.length) return;
				const rows = pending.flatMap((document) => document.rows);
				const unique = new Map(rows.map((row) => [row.embedding_key, row]));
				const cached = await stage(
					"cache",
					() => context.store.findVectors([...unique.keys()]),
					undefined,
					unique.size,
				);
				const vectors = new Map(cached);
				for (const [key, vector] of vectors) if (!validVector(vector)) vectors.delete(key);
				const validCached = new Set(vectors.keys());
				const missing = [...unique.values()]
					.filter((row) => !vectors.has(row.embedding_key))
					.sort((a, b) => a.tokens - b.tokens);
				if (missing.length && !embeddingReady) {
					await stage(
						"prepare",
						async () => {
							const actual = await this.options.embedder.identity();
							if (actual.dimension !== context.dimension || actual.model !== context.model)
								throw new Error(
									`embedding identity changed: expected ${context.model}/${context.dimension}, got ${actual.model}/${actual.dimension}`,
								);
							embeddingReady = true;
						},
						"embedding-backend",
					);
				}
				const embedBatch = async (batch: readonly IndexRow[]): Promise<void> => {
					if (!batch.length) return;
					try {
						const result = await stage(
							"embed",
							async () => {
								for (let attempt = 0; ; attempt++) {
									try {
										const result = await this.options.embedder.embed(
											batch.map((row) => row.embedding_text),
											{ role: "document", signal: options.signal },
										);
										if (result.length !== batch.length || result.some((vector) => !validVector(vector)))
											throw new Error(
												`embedding returned invalid vectors (expected ${batch.length} x ${context.dimension}, finite and nonzero)`,
											);
										embedded += batch.length;
										return result;
									} catch (error) {
										options.signal?.throwIfAborted();
										if (
											context.handlesRetries ||
											attempt >= 2 ||
											!/HTTP (?:429|5\d\d)|ECONNRESET|fetch failed/i.test(errorText(error))
										)
											throw error;
										event({
											phase: "embed",
											state: "start",
											detail: `retry ${attempt + 1}: ${errorText(error)}`,
											count: batch.length,
										});
										await sleep(100 * 2 ** attempt, undefined, { signal: options.signal });
									}
								}
							},
							undefined,
							batch.length,
						);
						batch.forEach((row, index) => {
							vectors.set(row.embedding_key, result[index]);
						});
						consecutiveFailures = 0;
					} catch (error) {
						options.signal?.throwIfAborted();
						if (batch.length > 1) {
							const middle = Math.floor(batch.length / 2);
							await embedBatch(batch.slice(0, middle));
							await embedBatch(batch.slice(middle));
						} else {
							for (const row of rows.filter((row) => row.embedding_key === batch[0].embedding_key)) {
								rejected.add(row.source_id);
								failures.push({ path: row.source_id, stage: "embed", error: errorText(error) });
							}
							if (++consecutiveFailures >= 3) throw error;
						}
					}
				};
				const batchSize = this.options.debug ? 1 : (this.options.batchSize ?? 32);
				const tokenBudget = this.options.maxBatchTokens ?? 8192;
				let batch: IndexRow[] = [];
				for (const row of missing) {
					if (row.tokens + 8 > tokenBudget)
						throw new RangeError(
							`localIndex.maxBatchTokens (${tokenBudget}) is smaller than one embedding input (${row.tokens} tokens plus special-token reserve)`,
						);
					if (batch.length && (batch.length >= batchSize || (batch.length + 1) * (row.tokens + 8) > tokenBudget)) {
						await embedBatch(batch);
						batch = [];
					}
					batch.push(row);
				}
				await embedBatch(batch);
				const complete = pending.filter((document) => !rejected.has(document.id));
				const completedRows = complete.flatMap((document) =>
					document.rows.map((row) => ({ ...row, vector: [...vectors.get(row.embedding_key)!] })),
				);
				reused +=
					completedRows.length -
					new Set(
						completedRows.filter((row) => !validCached.has(row.embedding_key)).map((row) => row.embedding_key),
					).size;
				if (complete.length) {
					await stage(
						"write",
						() => {
							markDirty();
							return journal!.replace(context.store, complete, completedRows);
						},
						undefined,
						completedRows.length,
					);
				}
				pending = [];
				pendingTokens = 0;
			};
			let loadedTokenizer: TokenCounter | undefined;
			for await (const document of documents ?? mirrorDocuments(this.options.root)) {
				options.signal?.throwIfAborted();
				if (seen.has(document.virtualPath)) continue;
				seen.add(document.virtualPath);
				processed++;
				if (document.parseDurationMs !== undefined) {
					timings.parse = (timings.parse ?? 0) + document.parseDurationMs;
					event({
						phase: "parse",
						state: "end",
						source: document.virtualPath,
						durationMs: document.parseDurationMs,
					});
				}
				loadedTokenizer ??= await stage("prepare", () => context.tokenizer(options.signal), "tokenizer");
				const tokenizer = loadedTokenizer;
				const fingerprint = contentHash(
					JSON.stringify([
						document.updatedAt,
						document.outputPath,
						document.sourcePath,
						CHUNKER_VERSION,
						tokenizer.fingerprint,
						context.analyzer.fingerprint,
						this.options.targetTokens ?? 512,
						this.options.maxTokens ?? 768,
					]),
				);
				if (!options.force && journal.unchanged(document.virtualPath, fingerprint)) {
					unchanged++;
					continue;
				}
				let documentStage = "chunk";
				try {
					const chunks = await stage(
						"chunk",
						async () => chunkMarkdown(await readFile(document.outputPath, "utf8"), tokenizer, this.options),
						document.virtualPath,
					);
					chunkCount += chunks.length;
					const occurrences = new Map<string, number>();
					const rows: IndexRow[] = [];
					documentStage = "lexical";
					const lexical = await stage(
						"lexical",
						() =>
							Promise.all(
								chunks.map((chunk) =>
									context.analyzer.analyze(`${chunk.heading}\n${chunk.text}`, options.signal),
								),
							),
						document.virtualPath,
						chunks.length,
					);
					documentStage = "chunk";
					for (const [position, chunk] of chunks.entries()) {
						const tokens = tokenizer.count(`${context.passagePrefix}${chunk.embeddingText}`);
						if (tokens + 8 > context.maxInputTokens)
							throw new Error(
								`document embedding input exceeds backend limit (${tokens} tokens plus special-token reserve)`,
							);
						const hash = contentHash(chunk.embeddingText);
						const occurrence = occurrences.get(hash) ?? 0;
						occurrences.set(hash, occurrence + 1);
						rows.push({
							id: contentHash(`${document.virtualPath}\0${CHUNKER_VERSION}\0${hash}\0${occurrence}`),
							source_id: document.virtualPath,
							source_path: document.sourcePath,
							text: chunk.text,
							embedding_text: chunk.embeddingText,
							embedding_key: hash,
							lexical_text: lexical[position],
							heading: chunk.heading,
							kind: chunk.kind,
							start: chunk.start,
							end: chunk.end,
							tokens,
							vector: [],
						});
					}
					pending.push({ id: document.virtualPath, fingerprint, rows });
					pendingTokens += chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
					if (pendingTokens >= 8192 || pending.length >= 8 || this.options.debug) await flush();
				} catch (error) {
					options.signal?.throwIfAborted();
					// Storage/systemic failures must abort rather than being mislabeled as a bad document.
					if (pending.some((candidate) => candidate.id === document.virtualPath)) throw error;
					failures.push({ path: document.virtualPath, stage: documentStage, error: errorText(error) });
					event({
						phase: documentStage === "lexical" ? "lexical" : "chunk",
						state: "error",
						source: document.virtualPath,
						detail: errorText(error),
					});
				}
			}
			await flush();
			const removed = journal.sources().filter((id) => !seen.has(id));
			if (removed.length) {
				await stage(
					"write",
					() => {
						markDirty();
						return journal!.replace(
							context.store,
							removed.map((id) => ({ id, fingerprint: null })),
							[],
						);
					},
					undefined,
					removed.length,
				);
				deleted = removed.length;
				dirty = true;
			}
			if (dirty || this.status() !== "ready") await stage("maintain", () => context.store.maintain());
			const ready = {
				version: 1,
				profile: context.profile,
				runId,
				model: context.model,
				dimension: context.dimension,
				embeddingFingerprint: this.options.embeddingFingerprint,
				partial: failures.length > 0,
				embeddingProfile: this.options.embeddingProfile,
				semanticFingerprint: this.options.semanticFingerprint,
				generation: this.options.generation,
			};
			if (!failures.length) this.candidateReady = ready;
			if (options.activate !== false && (!failures.length || journal.sources().length > 0))
				writeFileAtomic(join(this.directory, "ready.json"), JSON.stringify(ready));
			rmSync(maintenanceMarker, { force: true });
		} catch (error) {
			failed = true;
			fatal = error;
			failures.push({ path: "index", stage: "run", error: errorText(error) });
		} finally {
			try {
				journal?.close();
				const report: IndexReport = {
					runId,
					backend: "autorag",
					ok: !failures.length,
					durationMs: performance.now() - started,
					timings,
					documents: processed,
					unchanged,
					chunks: chunkCount,
					embedded,
					reused,
					deleted,
					failures,
					reportPath: join(runDirectory, "report.json"),
				};
				event({
					phase: "done",
					state: report.ok ? "end" : "error",
					detail: failures.map((failure) => failure.error).join("\n") || undefined,
				});
				flushEvents();
				writeFileAtomic(report.reportPath, JSON.stringify(report, null, 2));
				writeFileAtomic(join(this.directory, "last-run.json"), JSON.stringify(report, null, 2));
			} finally {
				release();
			}
		}
		if (failed) throw fatal;
		return JSON.parse(readFileSync(join(runDirectory, "report.json"), "utf8")) as IndexReport;
	}
	/** Candidate builds never replace the active pointer until a query smoke test succeeds. */
	async activateCandidate(signal?: AbortSignal): Promise<void> {
		if (!this.candidateReady) throw new Error("Candidate index is incomplete; active index was kept");
		const context = await this.context();
		const sample = await context.store.sampleRow?.();
		if (sample) {
			const text = sample.text.slice(0, 160);
			const [vector] = await this.options.embedder.embed([text], { role: "query", signal });
			const hits = await context.store.search({ text, vector, mode: "hybrid", topK: 5 });
			if (!hits.length) throw new Error("Candidate index query smoke test returned no hits; active index was kept");
		} else if (context.store.sampleRow && (await context.store.countRows()))
			throw new Error("Candidate index could not read a sample row");
		signal?.throwIfAborted();
		writeFileAtomic(join(this.directory, "ready.json"), JSON.stringify(this.candidateReady));
		this.candidateReady = undefined;
	}
	async search(
		query: string,
		options: {
			mode?: "vector" | "bm25" | "hybrid";
			topK?: number;
			scope?: string;
			sourceIds?: readonly string[];
			signal?: AbortSignal;
		} = {},
	) {
		options.signal?.throwIfAborted();
		if (options.sourceIds?.length === 0) return [];
		const readinessError = this.readinessError();
		if (readinessError) throw new Error(readinessError);
		// Pin the activation pointer before the first await so an in-flight query can finish on its generation.
		const ready = JSON.parse(readFileSync(join(this.directory, "ready.json"), "utf8")) as { profile: string };
		const context = await this.context();
		if (ready.profile !== context.profile)
			throw new Error("Local index embedding identity changed; refresh before searching");
		if ((await context.store.countRows()) === 0) return [];
		const mode = options.mode ?? "hybrid";
		let vector: readonly number[] | undefined;
		if (mode !== "bm25") {
			const tokenizer = await context.tokenizer(options.signal);
			if (tokenizer.count(`${context.queryPrefix}${query}`) + 8 > context.maxInputTokens)
				throw new Error(`query embedding input exceeds backend limit (${context.maxInputTokens} tokens)`);
			if (
				!this.lastQuery ||
				this.lastQuery.text !== query ||
				Date.now() - this.lastQuery.at > 10_000 ||
				this.lastQuery.signal !== options.signal
			) {
				const pending = this.options.embedder
					.embed([query], { role: "query", signal: options.signal })
					.then((vectors) => vectors[0]);
				this.lastQuery = { text: query, at: Date.now(), vector: pending, signal: options.signal };
				void pending.catch(() => {
					if (this.lastQuery?.vector === pending) this.lastQuery = undefined;
				});
			}
			vector = await this.lastQuery.vector;
		}
		if (
			mode !== "bm25" &&
			(!vector ||
				vector.length !== context.dimension ||
				!vector.every(Number.isFinite) ||
				!vector.some((value) => value !== 0))
		)
			throw new Error("query embedding has invalid dimensions or values");
		const hits = await context.store.search({
			text: mode === "vector" ? "" : await context.analyzer.analyze(query, options.signal),
			vector,
			mode,
			topK: options.topK ?? 50,
			scope: options.scope,
			sourceIds: options.sourceIds,
		});
		options.signal?.throwIfAborted();
		return hits.map((hit) => ({ ...hit, profile: context.profile }));
	}
}

async function* mirrorDocuments(root: string): AsyncIterable<IndexDocument> {
	for (const entry of Object.values(loadMirrorIndex(root).entries)) yield entry;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
