import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { IndexJob, IndexJobRequest, IndexJobs } from "../indexing/jobs.ts";
import { formatIndexEvent } from "../indexing/progress.ts";

export const INDEX_TOOL_NAME = "manage_local_index";
export interface IndexOperations {
	jobs: IndexJobs;
	start(request: IndexJobRequest): IndexJob;
	activeIndex?(): { embeddingProfile: string; ready: boolean };
	profiles(): readonly { id: string; kind: string; model: string }[];
	canWriteFromModel(operation: "build" | "refresh" | "cancel"): boolean;
}

const parameters = Type.Object({
	operation: Type.Union([
		Type.Literal("build"),
		Type.Literal("refresh"),
		Type.Literal("status"),
		Type.Literal("cancel"),
	]),
	embeddingProfile: Type.Optional(Type.String({ minLength: 1 })),
	jobId: Type.Optional(Type.String({ minLength: 1 })),
});

export function createIndexTool(operations: IndexOperations): AgentTool<typeof parameters> {
	return {
		name: INDEX_TOOL_NAME,
		label: "Local Index Tasks",
		description:
			"Only when the user explicitly requests indexing: build configured local document roots, refresh the active index, inspect progress or cancel this session's task. Select only a configured embeddingProfile. Switching profiles requires build. Never change configuration or authorize remote sending. Returns jobId immediately; work continues in this TUI. Use status to inspect it, not repeated builds. No filesystem path or credential arguments. Status also lists configured profiles.",
		parameters,
		async execute(_id, input) {
			if (input.operation !== "status" && !operations.canWriteFromModel(input.operation))
				throw new Error("Index writes require an explicit TUI indexing request; use /index");
			const job =
				input.operation === "status"
					? operations.jobs.status(input.jobId)
					: input.operation === "cancel"
						? operations.jobs.cancel(input.jobId ?? operations.jobs.status()?.jobId ?? "")
						: operations.start({ mode: input.operation, embeddingProfile: input.embeddingProfile });
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ job: job ?? null, activeIndex: operations.activeIndex?.(), profiles: operations.profiles() },
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

/** Conservative intent routing; ordinary retrieval never creates an index. */
export function indexWriteOperations(text: string): ReadonlySet<"build" | "refresh" | "cancel"> {
	const allowed = new Set<"build" | "refresh" | "cancel">();
	if (/^(?:如何|怎么|怎样|how\b|explain\b)/iu.test(text.trim())) return allowed;
	if (
		/(?:建立|创建|构建|重建).{0,24}(?:索引|向量化)|(?:请|帮我|使用|用).{0,30}向量化|^(?:build|create|index)\b/iu.test(
			text,
		)
	)
		allowed.add("build");
	if (/(?:更新|刷新).{0,24}(?:索引|向量化)|^refresh\b/iu.test(text)) allowed.add("refresh");
	if (/(?:取消|停止).{0,24}(?:索引|向量化)|(?:索引|向量化).{0,12}(?:取消|停止)|^cancel\b/iu.test(text))
		allowed.add("cancel");
	return allowed;
}
export function isIndexOperationInput(text: string): boolean {
	return (
		indexWriteOperations(text).size > 0 ||
		/(?:查看|显示|检查).{0,18}(?:索引|向量化)|(?:索引|向量化).{0,12}(?:进度|状态)|^(?:show|check)\b.{0,40}(?:index|progress|status)/iu.test(
			text,
		)
	);
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
