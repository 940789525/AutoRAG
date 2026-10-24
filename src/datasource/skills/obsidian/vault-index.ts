import { basename, extname, join } from "node:path";
import { createEmbedderFromConfig, type Embedder } from "../../../embedding/index.ts";
import { LocalDocumentIndex } from "../../../indexing/pipeline.ts";
import type { IndexDocument, LocalIndexOptions } from "../../../indexing/types.ts";
import type { MinSyncVectorMethodOptions } from "../../../minsync/method.ts";
import { runWorkspaceQuery, runWorkspaceSync } from "../../../minsync/workspace-lock.ts";
import type { RetrievalResult } from "../../../retrieval/types.ts";
import { boundDiagnosticText } from "../../connector.ts";
import type { DatasourceDiagnostic, DatasourceDiagnosticCode } from "../../types.ts";
import {
	OBSIDIAN_DATASOURCE_ID,
	obsidianMinSyncWorkspace,
	obsidianNoteSource,
	obsidianStagingStatePath,
} from "./paths.ts";
import { listVaultNotes, loadStagingState, stageNotes, VaultUnavailableError } from "./staging.ts";

/** Embedding settings shared with the local index; legacy binary options remain accepted. */
export type ObsidianMinSyncOptions = Pick<
	MinSyncVectorMethodOptions,
	"binaryPath" | "autoInstall" | "installer" | "embedder" | "maxChunkSize"
> & { readonly sharedEmbedder?: Embedder; readonly localIndex?: Omit<LocalIndexOptions, "root" | "embedder"> };

export interface ObsidianVaultIndexOptions {
	readonly instanceId: string;
	readonly vaultPath: string | undefined;
	readonly workspaceRoot: string | undefined;
	readonly minSync?: ObsidianMinSyncOptions;
}

export type ObsidianSearchMode = "bm25" | "semantic";

export interface ObsidianSearchOptions {
	readonly topK?: number;
	readonly scope?: string;
	readonly signal?: AbortSignal;
}

export type VaultSyncOutcome =
	| { readonly ok: true; readonly notes: number; readonly diagnostics: readonly DatasourceDiagnostic[] }
	| { readonly ok: false; readonly code: DatasourceDiagnosticCode; readonly message: string };

const DEFAULT_TOP_K = 20;
/**
 * One vault indexed by the AutoRAG native pipeline. Staging retains unreadable notes;
 * vector and BM25 results keep source-native identities rather than filesystem paths.
 */
export class ObsidianVaultIndex {
	private readonly instanceId: string;
	private readonly vaultPath: string | undefined;
	private readonly workspaceRoot: string | undefined;
	private readonly minSync: ObsidianMinSyncOptions;
	private nativeIndex: LocalDocumentIndex | undefined;

	private native(workspace: string): LocalDocumentIndex {
		const configured = this.minSync.embedder;
		const local =
			!this.minSync.sharedEmbedder &&
			configured?.baseUrl === undefined &&
			(configured?.id === undefined || configured.id.startsWith("native:"));
		this.nativeIndex ??= new LocalDocumentIndex({
			...this.minSync.localIndex,
			root: workspace,
			embedder: this.minSync.sharedEmbedder ?? createEmbedderFromConfig({ embedder: this.minSync.embedder }),
			identity:
				this.minSync.localIndex?.identity ??
				(local
					? {
							provider: "minsync",
							model: configured?.id?.slice("native:".length) ?? "Qwen/Qwen3-Embedding-0.6B",
							dimension: configured?.dimension ?? 1024,
						}
					: undefined),
			embeddingFingerprint: JSON.stringify({
				id: configured?.id,
				baseUrl: configured?.baseUrl,
				passagePrefix: configured?.passagePrefix,
				revision: this.minSync.localIndex?.embeddingFingerprint,
			}),
		});
		return this.nativeIndex;
	}

	constructor(options: ObsidianVaultIndexOptions) {
		this.instanceId = options.instanceId;
		this.vaultPath = options.vaultPath;
		this.workspaceRoot = options.workspaceRoot;
		this.minSync = options.minSync ?? {};
	}

	/** Stage the vault's notes and run the AutoRAG index pipeline. Never throws except on abort. */
	sync(signal?: AbortSignal): Promise<VaultSyncOutcome> {
		const { vaultPath, workspaceRoot } = this;
		if (vaultPath === undefined) {
			return Promise.resolve(
				failure("datasource-unavailable", "no vaultPath is configured for this Obsidian datasource"),
			);
		}
		if (workspaceRoot === undefined) {
			return Promise.resolve(
				failure("datasource-unavailable", "no workspace is configured to hold the vault index"),
			);
		}
		const workspace = obsidianMinSyncWorkspace(workspaceRoot, this.instanceId);
		// The whole run holds the workspace, listing included, so a query issued while it runs is refused
		// instead of reading notes that are half staged.
		return runWorkspaceSync(workspace, () => this.syncLocked(vaultPath, workspaceRoot, workspace, signal));
	}

	private async syncLocked(
		vaultPath: string,
		workspaceRoot: string,
		workspace: string,
		signal: AbortSignal | undefined,
	): Promise<VaultSyncOutcome> {
		try {
			signal?.throwIfAborted();
			const listing = await listVaultNotes(vaultPath);
			// A vault that lists nothing is far more likely moved, unmounted, or unreadable than emptied on
			// purpose; syncing it would wipe the index, so the previous one is kept.
			if (listing.notes.size === 0) {
				return failure("datasource-empty", "the Obsidian vault has no markdown notes; the previous index was kept");
			}
			const staged = stageNotes(
				join(workspace, "files"),
				obsidianStagingStatePath(workspaceRoot, this.instanceId),
				listing,
			);
			const state = loadStagingState(obsidianStagingStatePath(workspaceRoot, this.instanceId));
			const instanceId = this.instanceId;
			async function* documents(): AsyncIterable<IndexDocument> {
				for (const [path, note] of Object.entries(state.entries))
					yield {
						virtualPath: obsidianNoteSource(instanceId, path),
						sourcePath: note.sourcePath,
						outputPath: join(workspace, "files", path),
						updatedAt: `${note.mtimeNs}:${note.size}`,
					};
			}
			const result = await this.native(workspace).sync(documents(), { signal });
			if (!result.ok)
				return failure(
					"datasource-index-failed",
					result.failures.map((item) => `${item.path}: ${item.error}`).join("\n"),
				);
			const diagnostics: DatasourceDiagnostic[] = [];
			const warn = (message: string): void => {
				diagnostics.push({
					code: "datasource-index-partial",
					severity: "warning",
					message: boundDiagnosticText(message),
					instanceId: this.instanceId,
					source: OBSIDIAN_DATASOURCE_ID,
				});
			};
			if (listing.unreadableFolders.length > 0) {
				warn(
					`${listing.unreadableFolders.length} vault folder(s) could not be read; their notes keep their previous index`,
				);
			}
			if (listing.collisions.length > 0) {
				warn(`${listing.collisions.length} note(s) share a normalized path with another note and were not indexed`);
			}
			if (staged.failed.length > 0) warn(`${staged.failed.length} note(s) could not be copied for indexing`);
			return { ok: true, notes: staged.staged, diagnostics };
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof VaultUnavailableError) {
				return failure("datasource-unavailable", error.message);
			}
			return failure("datasource-index-failed", error instanceof Error ? error.message : String(error));
		}
	}

	/** Search the indexed vault. Rejects, with the reason, when the vault was never indexed or a sync is running. */
	async query(
		mode: ObsidianSearchMode,
		text: string,
		options: ObsidianSearchOptions = {},
	): Promise<RetrievalResult[]> {
		const query = text.trim();
		if (query.length === 0) return [];
		const workspaceRoot = this.workspaceRoot;
		if (workspaceRoot === undefined) throw new Error("no workspace is configured to hold the vault index");
		const workspace = obsidianMinSyncWorkspace(workspaceRoot, this.instanceId);
		return runWorkspaceQuery(workspace, () => this.queryLocked(mode, query, options, workspaceRoot, workspace));
	}

	private async queryLocked(
		mode: ObsidianSearchMode,
		query: string,
		options: ObsidianSearchOptions,
		workspaceRoot: string,
		workspace: string,
	): Promise<RetrievalResult[]> {
		const index = this.native(workspace);
		if (!index.isReady())
			throw new Error(
				`The Obsidian vault "${this.instanceId}" is not indexed yet: run autorag refresh --method datasources first.`,
			);
		const state = loadStagingState(obsidianStagingStatePath(workspaceRoot, this.instanceId));
		const bySource = new Map(
			Object.entries(state.entries).map(([path, note]) => [
				obsidianNoteSource(this.instanceId, path),
				{ path, note },
			]),
		);
		const hits = await index.search(query, {
			mode: mode === "semantic" ? "vector" : "bm25",
			topK: options.topK ?? DEFAULT_TOP_K,
			scope: options.scope,
			signal: options.signal,
		});
		return hits.flatMap(({ row, score }) => {
			const entry = bySource.get(row.source_id);
			if (!entry) return [];
			return [
				{
					id: `obsidian:${this.instanceId}:${row.id}`,
					content: row.text,
					source: row.source_id,
					score,
					metadata: {
						method: `obsidian-${mode}`,
						datasourceId: OBSIDIAN_DATASOURCE_ID,
						instanceId: this.instanceId,
						mode,
						file: entry.path,
						title: basename(entry.path, extname(entry.path)),
						path: entry.note.sourcePath,
						indexBackend: "autorag",
					},
				},
			];
		});
	}
}

function failure(code: DatasourceDiagnosticCode, message: string): VaultSyncOutcome {
	return { ok: false, code, message: boundDiagnosticText(message) };
}
