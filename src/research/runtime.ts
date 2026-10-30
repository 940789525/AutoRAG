import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type CliConfig, resolveConfigReadOnly } from "../cli/config.ts";
import { AutoRAGLite } from "../core.ts";
import { readEvidenceRevision } from "../indexing/evidence-reader.ts";
import { LanceIndexStore } from "../indexing/lance-store.ts";
import { LocalIndexMethod } from "../indexing/method.ts";
import { loadMirrorIndex } from "../mirror/index-store.ts";
import { resolveSessionModel } from "../profiles/session-model.ts";
import { within } from "./discovery.ts";
import { evidenceId, noteSchema, structuredReading, validateNote } from "./reader.ts";
import {
	type AssetRevision,
	type Evidence,
	errorText,
	type ReadingInput,
	type ReadingResult,
	type Topic,
} from "./types.ts";

export interface ResearchRuntime {
	refresh(): Promise<void>;
	revision(sha256: string): Promise<Omit<AssetRevision, "id" | "paperId"> | undefined>;
	verify(revision: AssetRevision): Promise<void>;
	screen(target: AssetRevision, topic: Topic, signal: AbortSignal): Promise<boolean>;
	read(input: ReadingInput, signal: AbortSignal): Promise<ReadingResult>;
}

export interface RuntimeOptions {
	root: string;
	workspace: string;
	runtimeConfig: string;
	agentDir: string;
	allowModelProcessing: boolean;
	env?: NodeJS.ProcessEnv;
}

export async function createResearchRuntime(options: RuntimeOptions): Promise<ResearchRuntime> {
	await mkdir(options.workspace, { recursive: true });
	const root = await realpath(options.root);
	const workspace = await realpath(options.workspace);
	if (within(root, workspace) || within(workspace, root))
		throw new Error("Research workspace and PDF root must be separate directories");
	const env = {
		...(options.env ?? process.env),
		AUTORAG_HOME: join(workspace, ".research-home"),
		AUTORAG_CONFIG: options.runtimeConfig,
	};
	const base = resolveConfigReadOnly({ flags: { config: options.runtimeConfig }, cwd: workspace, env });
	const config: CliConfig = {
		...base,
		searchPaths: [root],
		workspacePath: workspace,
		memoryPath: join(workspace, ".research-home", "memory.json"),
		datasources: {},
		webSearch: { enabled: false },
		everything: false,
		fsearch: false,
		jikji: false,
		jev: false,
		dupey: { enabled: false },
	};
	const lite = new AutoRAGLite(config);
	const method = lite.getRetrievalEngine().getMethodRegistry().get("minsync");
	if (!(method instanceof LocalIndexMethod)) throw new Error("Research requires the built-in local index");
	const index = method.index;
	let store: LanceIndexStore | undefined;
	const authorized = (path: string) => within(root, path);
	const revision = async (asset: AssetRevision, signal?: AbortSignal) => {
		const entry = loadMirrorIndex(workspace).entries[asset.sourceId];
		if (!entry) throw new Error(`Paper mirror is unavailable: ${asset.source}`);
		const result = await readEvidenceRevision(workspace, entry, authorized, signal);
		if (
			!result ||
			result.source !== asset.source ||
			result.sourceSha256 !== asset.sha256 ||
			result.outputSha256 !== asset.outputSha256
		)
			throw new Error(`Paper revision changed or is unavailable: ${asset.source}`);
		return result.markdown;
	};
	const modelOptions = async () => {
		if (!options.allowModelProcessing)
			throw new Error(
				"Paper model processing requires allowModelProcessing=true in the trusted research configuration",
			);
		return {
			cwd: workspace,
			agentDir: options.agentDir,
			env,
			model: await resolveSessionModel(config, env, workspace, options.agentDir),
		};
	};
	return {
		async refresh() {
			const result = await lite.refresh(false, { methods: ["parsed", "minsync"], retrySkipped: true });
			if (result.minsync?.ok === false) throw new Error(result.minsync.reason ?? "Research index refresh failed");
			const ready = JSON.parse(await readFile(join(index.directory, "ready.json"), "utf8")) as { profile: string };
			store = await LanceIndexStore.openExisting(join(index.directory, ready.profile, "store"));
		},
		async revision(sha256) {
			if (index.readinessError()) return undefined;
			if (!store) {
				const ready = JSON.parse(await readFile(join(index.directory, "ready.json"), "utf8")) as {
					profile: string;
				};
				store = await LanceIndexStore.openExisting(join(index.directory, ready.profile, "store"));
			}
			for (const entry of Object.values(loadMirrorIndex(workspace).entries)) {
				if (entry.sourceSha256 !== sha256) continue;
				const result = await readEvidenceRevision(workspace, entry, authorized);
				if (result && (await store.hasSource(entry.virtualPath)))
					return { sha256, sourceId: entry.virtualPath, source: result.source, outputSha256: result.outputSha256 };
			}
			return undefined;
		},
		async verify(asset) {
			await revision(asset);
		},
		async screen(target, topic, signal) {
			const head = (await revision(target, signal)).slice(0, 6000);
			const schema = Type.Object(
				{ relevant: Type.Boolean(), reason: Type.String({ maxLength: 800 }) },
				{ additionalProperties: false },
			);
			return (
				await structuredReading(
					await modelOptions(),
					JSON.stringify({
						task: "Screen title/abstract only. Is this relevant to the topic?",
						topic,
						excerpt: head,
					}),
					schema,
					(value) => {
						if (!Value.Check(schema, value)) throw new Error("Invalid screening result");
						return value;
					},
					signal,
				)
			).relevant;
		},
		async read({ target, topic, baseline }, signal) {
			const allowed = baseline.filter(
				(asset) => asset.paperId !== target.paperId && asset.id !== target.id && asset.sourceId !== target.sourceId,
			);
			const evidence: Evidence[] = [];
			const diagnostics: string[] = [];
			const tokenizer = getEncoding("cl100k_base");
			let tokens = 0;
			const add = (asset: AssetRevision, markdown: string, start: number, end: number) => {
				const text = markdown.slice(start, end);
				const size = tokenizer.encode(text, [], []).length;
				if (!text.trim() || tokens + size > 10000 || evidence.length >= 12) return;
				const id = evidenceId(asset.id, asset.outputSha256, start, end);
				if (evidence.some((entry) => entry.evidenceId === id)) return;
				tokens += size;
				evidence.push({ ...asset, evidenceId: id, start, end, text });
			};
			const markdown = await revision(target, signal);
			// Deterministic coverage across the paper, preserving exact markdown offsets.
			for (const start of [
				...new Set([
					0,
					Math.floor(markdown.length / 3),
					Math.floor((markdown.length * 2) / 3),
					Math.max(0, markdown.length - 3500),
				]),
			])
				add(target, markdown, start, Math.min(start + 3500, markdown.length));
			const oldWorks = new Set<string>();
			for (const query of [topic.question, ...topic.focus].slice(0, 3)) {
				if (!allowed.length) break;
				const hits = await index.search(query, {
					mode: "hybrid",
					topK: 12,
					sourceIds: allowed.map((asset) => asset.sourceId),
					signal,
				});
				for (const hit of hits) {
					const asset = allowed.find((item) => item.sourceId === hit.row.source_id);
					if (!asset || (!oldWorks.has(asset.paperId) && oldWorks.size >= 3)) continue;
					let body: string;
					try {
						body = await revision(asset, signal);
					} catch (error) {
						signal.throwIfAborted();
						diagnostics.push(errorText(error));
						continue;
					}
					if (body.slice(hit.row.start, hit.row.end) !== hit.row.text)
						throw new Error(`Indexed excerpt changed: ${asset.source}`);
					oldWorks.add(asset.paperId);
					add(asset, body, hit.row.start, hit.row.end);
				}
			}
			const prompt = JSON.stringify({
				task: "Read the new paper against the frozen local baseline. These are partial excerpts, not a complete literature review. Mark unsupported sections as evidence insufficient; do not fabricate experiments or limitations. relationship compares only this local baseline. Priorities are reading advice. If no old evidence exists, comparability must be insufficient_evidence.",
				topic,
				targetAssetId: target.id,
				evidence,
			});
			if (tokenizer.encode(prompt, [], []).length > 12000) throw new Error("Research input exceeds 12000 tokens");
			let usage: ReadingResult["usage"];
			const note = await structuredReading(
				await modelOptions(),
				prompt,
				noteSchema,
				(value) => {
					validateNote(value, evidence, target.id);
					return value;
				},
				signal,
				(value) => {
					usage = value;
				},
			);
			return {
				note,
				evidence,
				usage,
				diagnostics: [...new Set(diagnostics)],
				coverage: {
					baselineWorks: new Set(allowed.map((asset) => asset.paperId)).size,
					retrievedWorks: oldWorks.size,
					excerptCount: evidence.length,
					partial: true,
				},
			};
		},
	};
}
