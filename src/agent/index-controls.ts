import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { IndexJob, IndexJobRequest, IndexJobs } from "../indexing/jobs.ts";
import { formatIndexEvent } from "../indexing/progress.ts";

export const INDEX_TOOL_NAME = "manage_local_index";
/** Require the packaged Skill and isolate index writes from external tool results. */
export function requireIndexSkill(
	messages: readonly AgentMessage[],
	skillPath: string,
	explicitInvocation: boolean,
): void {
	const reads = new Set<string>();
	let loaded = explicitInvocation;
	let externalResult = false;
	for (const message of messages) {
		if (message.role === "user") externalResult = false;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "read" && block.arguments.path === skillPath)
					reads.add(block.id);
			}
		}
		if (message.role !== "toolResult") continue;
		if (message.toolName === "read" && reads.has(message.toolCallId)) {
			if (!message.isError) loaded = true;
		} else if (message.toolName !== INDEX_TOOL_NAME) {
			externalResult = true;
		}
	}
	if (externalResult) throw new Error("This turn read external content. Ask for a separate local indexing request.");
	if (!loaded)
		throw new Error(`Read the packaged autorag-index Skill at ${skillPath} before submitting an index operation.`);
}

export interface IndexOperations {
	jobs: IndexJobs;
	onSessionEnd?(): void;
	start(request: IndexJobRequest): IndexJob;
	activeIndex(): { embeddingProfile: string; defaultProfile: string; ready: boolean };
	fileCoverage(
		offset: number,
		signal?: AbortSignal,
	): Promise<{
		files: { id: string; status: "registered" | "unregistered" | "unknown" }[];
		total: number;
		registered: number | null;
		nextOffset?: number;
		complete: boolean;
		diagnostics: string[];
	}>;
	profiles(): readonly { id: string; kind: string; model: string }[];
	authorizeWrite(): { requestId: string; ownedJobId?: string };
}

const parameters = Type.Object({
	operation: Type.Union([
		Type.Literal("ensure"),
		Type.Literal("build"),
		Type.Literal("refresh"),
		Type.Literal("status"),
		Type.Literal("cancel"),
	]),
	embeddingProfile: Type.Optional(Type.String({ minLength: 1 })),
	jobId: Type.Optional(Type.String({ minLength: 1 })),
	localOnly: Type.Optional(Type.Boolean({ description: "Require a local embedding profile." })),
	scope: Type.Optional(Type.String({ description: "Only all configured local roots (all) are supported." })),
	includeFiles: Type.Optional(
		Type.Boolean({ description: "For status: list actual local files and their index registration." }),
	),
	fileOffset: Type.Optional(
		Type.Integer({ minimum: 0, description: "Continue an includeFiles page from nextOffset." }),
	),
});

export function createIndexTool(operations: IndexOperations): AgentTool<typeof parameters> {
	return {
		name: INDEX_TOOL_NAME,
		label: "Local Index Tasks",
		description:
			"For local library inventory, missing files, or index coverage, call status with includeFiles:true. It compares current filenames to the active index and returns per-file registration without reading bodies. For job progress alone use plain status. For an explicit local index change read the autorag-index Skill, then submit the operation it describes.",
		parameters,
		async execute(_id, input, signal) {
			if (
				(input.includeFiles || input.fileOffset !== undefined) &&
				(input.operation !== "status" || !input.includeFiles)
			)
				throw new Error("File inventory requires operation status and includeFiles:true");
			signal?.throwIfAborted();
			if (input.includeFiles) {
				const coverage = await operations.fileCoverage(input.fileOffset ?? 0, signal);
				const job = operations.jobs.status(input.jobId);
				const snapshot = {
					basis: "AutoRAG enumerated the permitted local files and checked registration in the active index journal. IDs are virtual source identifiers, not filesystem paths. For inventory/coverage answer directly from this result; do not recheck with bash or search.",
					job: job ? { jobId: job.jobId, mode: job.mode, state: job.state } : null,
					activeIndex: coverage.registered === null ? undefined : operations.activeIndex?.(),
					coverage,
				};
				return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: {} };
			}
			const active = operations.activeIndex();
			let job: IndexJob | undefined;
			if (input.operation === "status") {
				job = operations.jobs.status(input.jobId);
			} else {
				const { requestId, ownedJobId } = operations.authorizeWrite();
				if (input.scope !== undefined && input.scope !== "all")
					throw new Error("Index tasks require all configured local roots. Clarify the requested scope.");
				if (input.operation === "cancel") {
					if (!ownedJobId || (input.jobId && input.jobId !== ownedJobId))
						throw new Error("No matching index job owned by this TUI session");
					job = operations.jobs.cancel(ownedJobId);
				} else {
					if (input.jobId) throw new Error("jobId applies only to status or cancel");
					const previous = input.operation === "ensure" ? operations.jobs.forRequest(requestId) : undefined;
					const mode =
						input.operation === "ensure"
							? (previous?.mode ?? (active.ready ? "refresh" : "build"))
							: input.operation;
					const id =
						input.embeddingProfile ??
						previous?.embeddingProfile ??
						(active.ready ? active.embeddingProfile : active.defaultProfile);
					const profile = operations.profiles().find((p) => p.id === id);
					if (!profile) throw new Error(`Unknown embedding profile: ${id}`);
					if (input.localOnly && profile.kind === "api")
						throw new Error(`Profile ${id} uses a remote API; choose a local profile.`);
					if (mode === "refresh" && !active.ready)
						throw new Error("No ready index. Ask whether to build the first index.");
					if (mode === "refresh" && id !== active.embeddingProfile)
						throw new Error("Switching embedding profiles requires an explicit rebuild.");
					job = operations.start({ mode, embeddingProfile: id, requestId });
				}
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								job: job ?? null,
								scope: "all configured local roots",
								activeIndex: operations.activeIndex(),
								profiles: operations.profiles(),
							},
							null,
							2,
						),
					},
				],
				details: {},
			};
		},
	};
}

export function parseIndexCommand(args: string): {
	operation: "build" | "refresh" | "status" | "cancel";
	embeddingProfile?: string;
	jobId?: string;
} {
	const words = args.trim().split(/\s+/u).filter(Boolean);
	const operation = words.shift() ?? "status";
	if (!["build", "refresh", "status", "cancel"].includes(operation))
		throw new Error("Use /index build [--embedding PROFILE], refresh, status [--job ID], cancel [--job ID]");
	const result = { operation } as ReturnType<typeof parseIndexCommand>;
	while (words.length) {
		const flag = words.shift();
		const value = words.shift();
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (flag === "--embedding" && (operation === "build" || operation === "refresh") && !result.embeddingProfile)
			result.embeddingProfile = value;
		else if (flag === "--job" && (operation === "status" || operation === "cancel") && !result.jobId)
			result.jobId = value;
		else throw new Error(`Unsupported /index argument ${flag}`);
	}
	return result;
}

export function createIndexControls(operations: IndexOperations): ExtensionFactory {
	return (pi) => {
		let context: ExtensionContext | undefined;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		let latest: IndexJob | undefined;
		const render = (job: IndexJob, notify = true) => {
			if (!context?.hasUI) return;
			const active = ["queued", "running", "cancelling"].includes(job.state);
			const elapsedMs = (active ? Date.now() : Date.parse(job.updatedAt)) - Date.parse(job.startedAt);
			context.ui.setWidget("autorag-index-progress", [
				`AutoRAG 索引 ${job.jobId}: ${job.state} · ${job.embeddingProfile}`,
				job.event ? formatIndexEvent(job.event) : "正在准备索引",
				job.report
					? `文档 ${job.report.documents}，向量化 ${job.report.embedded}，复用 ${job.report.reused}，未变更 ${job.report.unchanged}`
					: "",
				job.error ?? "",
				`累计 ${Math.max(0, Math.floor(elapsedMs / 1000))} 秒${active ? " · 任务尚未结束，等待下一阶段事件" : ""}`,
			]);
			if (notify && ["succeeded", "failed", "cancelled"].includes(job.state))
				context.ui.notify(
					`Index ${job.jobId}: ${job.state}${job.error ? `\n${job.error}` : ""}`,
					job.state === "failed" ? "error" : "info",
				);
		};
		pi.on("session_start", (_event, ctx) => {
			context = ctx;
			unsubscribe?.();
			unsubscribe = operations.jobs.subscribe((job) => {
				latest = job;
				render(job);
			});
			clearInterval(timer);
			timer = setInterval(() => {
				if (latest && ["queued", "running", "cancelling"].includes(latest.state)) render(latest, false);
			}, 1000);
			timer.unref();
			const job = operations.jobs.status();
			latest = job;
			if (job) render(job);
		});
		pi.on("session_shutdown", async () => {
			operations.onSessionEnd?.();
			context = undefined;
			clearInterval(timer);
			unsubscribe?.();
			unsubscribe = undefined;
			await operations.jobs.close();
		});
		pi.registerCommand("index", {
			description: "Local indexing: /index build --embedding PROFILE | refresh | status | cancel",
			handler: async (args, ctx) => {
				try {
					const input = parseIndexCommand(args);
					const job =
						input.operation === "status"
							? operations.jobs.status(input.jobId)
							: input.operation === "cancel"
								? operations.jobs.cancel(input.jobId ?? operations.jobs.status()?.jobId ?? "")
								: operations.start({ mode: input.operation, embeddingProfile: input.embeddingProfile });
					ctx.ui.notify(
						JSON.stringify(
							{ job: job ?? null, activeIndex: operations.activeIndex?.(), profiles: operations.profiles() },
							null,
							2,
						),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}
