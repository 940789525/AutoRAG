import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import {
	type InboxCard,
	type InboxSummary,
	type ResearchBatch,
	ResearchClient,
	type ResearchOverview,
	type ResearchPaper,
	type ResearchRun,
} from "../research/client.ts";
import { errorText, TERMINAL_RUNS } from "../research/types.ts";

export const RESEARCH_STATUS_KEY = "autorag-research";
const actions = ["inbox", "topics", "papers", "runs", "batches", "scan", "seed", "status"];
const stateNames: Record<string, string> = {
	planned: "排队",
	screening: "筛选",
	reading: "研读",
	validating: "核验",
	succeeded: "完成",
	not_selected: "不相关",
	deferred: "待补读",
	needs_review: "待核查",
	failed: "失败",
	cancelled: "已取消",
	ready: "就绪",
	indexing: "索引中",
	scanning: "扫描中",
	active: "已建库",
	seeding: "待建库",
};
const stateName = (state: string) => stateNames[state] ?? state;
const priorityNames: Record<string, string> = {
	read_first: "优先阅读",
	optional: "可选阅读",
	defer: "暂缓",
	needs_review: "待核查",
};
const relevanceNames: Record<string, string> = { high: "高", medium: "中", low: "低", uncertain: "不确定" };
const comparabilityNames: Record<string, string> = {
	comparable: "可以比较",
	different_conditions: "实验条件不同",
	insufficient_evidence: "证据不足",
};

export function renderResearchBatch(batch: ResearchBatch, now = Date.now()): string {
	const progress = batch.progress;
	const stages: Record<string, string> = {
		prepare: "准备索引",
		parsed: "解析资料",
		parse: "解析资料",
		chunk: "切分文本",
		lexical: "构建关键词索引",
		cache: "检查向量缓存",
		embed: "向量化",
		write: "写入索引",
		maintain: "整理索引",
		done: "索引完成",
		minsync: "构建检索索引",
		finalizing: "完成建库",
	};
	const event = progress?.indexing;
	const details = progress
		? [
				`当前阶段：${stages[event?.phase ?? progress.phase] ?? progress.phase}`,
				...(progress.sourceFiles
					? [`已解析资料：${progress.parsedCounts?.scanned ?? 0}/${progress.sourceFiles.total}`]
					: []),
				...(event?.count === undefined
					? []
					: [
							`本批${event.state === "end" ? "已完成" : "正在处理"}：${event.count} 个${event.phase === "embed" ? "文本块" : "处理项"}`,
						]),
				`最近进展：${Math.max(0, Math.floor((now - Date.parse(progress.updatedAt)) / 1000))} 秒前`,
				...(event?.durationMs === undefined ? [] : [`最近一批耗时：${(event.durationMs / 1000).toFixed(1)} 秒`]),
				...(!progress.ownerAlive ? ["索引进程当前不在运行，请查看研读服务终端。"] : []),
				...(progress.error ? [progress.error] : []),
			]
		: [];
	return [
		`批次：${batch.id}`,
		`状态：${stateName(batch.status)}`,
		`新增论文：${batch.counts.added ?? 0} · 重复：${batch.counts.duplicates ?? 0} · 待处理：${batch.counts.pending ?? 0}`,
		...details,
		batch.error ?? "",
		"首次建库只生成检索索引，不会自动生成研读卡片。向量化按批更新，CPU 处理期间可能较长时间没有新数字。",
		"本页为当前快照；Esc 返回后重新打开可刷新进度。",
		...(batch.items?.map(
			(item) => `${item.path}\n${stateName(item.stage)}${item.error ? `\n${item.error}` : ""}`,
		) ?? ["正在发现文件，稍后查看。"]),
	].join("\n\n");
}

export function renderResearchCard(card: InboxCard): string {
	const note = card.payload;
	const sections = (
		[
			["方法", note.method],
			["实验", note.experiments],
			["发现", note.findings],
			["局限", note.limitations],
			["与旧论文的关系", note.relationship],
		] as const
	).map(([title, claim]) => `${title}\n${claim.text}\n依据：${claim.evidenceIds.join(", ")}`);
	return [
		note.title,
		`阅读优先级：${priorityNames[note.priority]} · 相关性：${relevanceNames[note.relevance]} · 证据状态：${card.validity}`,
		"本卡片基于有限摘录，不代表全文精读。",
		...(card.verificationError ? [`核验提示：${card.verificationError}`] : []),
		...sections,
		`可比较性：${comparabilityNames[note.comparability]}`,
		`阅读建议\n${note.readingAdvice}`,
		"原始证据（解析 Markdown 的 UTF-16 区间，不是 PDF 页码）",
		...card.evidence.map(
			(entry) =>
				`${entry.evidenceId}\n${entry.source}\n区间 ${entry.start}–${entry.end} · 文件 SHA256 ${entry.sha256}\n${entry.text}`,
		),
	].join("\n\n");
}

/** Read-only, scrollable display: paper excerpts never enter the chat/model transcript. */
export async function showResearchText(ctx: ExtensionContext, title: string, body: string): Promise<void> {
	await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
		const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
		const text = new Text(clean(body), 0, 0);
		let offset = 0;
		let height = 20;
		return {
			invalidate() {
				text.invalidate();
			},
			render(width) {
				const header = new Text(clean(title), 0, 0).render(width);
				const footer = new Text(`↑↓ / PgUp PgDn 翻阅 · Esc / q 返回`, 0, 0).render(width);
				height = Math.max(1, tui.terminal.rows - header.length - footer.length - 2);
				const lines = text.render(width);
				offset = Math.min(Math.max(0, offset), Math.max(0, lines.length - height));
				return [...header, ...lines.slice(offset, offset + height), ...footer];
			},
			handleInput(data) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
					done();
					return;
				}
				if (matchesKey(data, Key.up)) offset--;
				if (matchesKey(data, Key.down)) offset++;
				if (matchesKey(data, Key.pageUp)) offset -= height;
				if (matchesKey(data, Key.pageDown)) offset += height;
				if (matchesKey(data, Key.home)) offset = 0;
				if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
				tui.requestRender();
			},
		};
	});
}

export function createResearchInbox(options: { baseUrl: string; client?: ResearchClient }): ExtensionFactory {
	const client = options.client ?? new ResearchClient(options.baseUrl);
	return (pi: ExtensionAPI) => {
		let generation = 0;
		let timer: NodeJS.Timeout | undefined;
		let controller: AbortController | undefined;
		let menuOpen = false;
		let polling = false;
		const refresh = async (ctx: ExtensionContext, mine: number) => {
			if (polling) return;
			polling = true;
			try {
				const overview = await client.overview(controller?.signal);
				if (mine !== generation) return;
				const active = overview.runs.filter((run) => !TERMINAL_RUNS.includes(run.state)).length;
				const importing = overview.batches.some((batch) =>
					["planned", "scanning", "indexing"].includes(batch.status),
				);
				ctx.ui.setStatus(
					RESEARCH_STATUS_KEY,
					`/research · ${overview.unread} 未读${active ? ` · ${active} 最近任务进行中` : ""}${importing ? " · 导入中" : ""}`,
				);
			} catch {
				if (mine === generation) ctx.ui.setStatus(RESEARCH_STATUS_KEY, "论文收件箱：未连接 · /research");
			} finally {
				polling = false;
			}
		};
		pi.on("session_start", (_event, ctx) => {
			generation++;
			controller?.abort();
			clearInterval(timer);
			if (!ctx.hasUI) return;
			controller = new AbortController();
			const mine = generation;
			void refresh(ctx, mine);
			timer = setInterval(() => {
				void refresh(ctx, mine);
			}, 3000);
			timer.unref();
		});
		pi.on("session_shutdown", () => {
			generation++;
			controller?.abort();
			clearInterval(timer);
			timer = undefined;
		});

		async function choosePage<T>(
			ctx: ExtensionContext,
			title: string,
			path: string,
			label: (row: T) => string,
		): Promise<T | undefined> {
			let offset = 0;
			while (true) {
				const rows = await client.request<T[]>(`${path}?limit=20&offset=${offset}`);
				const labels = rows.map((row, i) => `${i + 1}. ${label(row)}`);
				const choice = await ctx.ui.select(`${title} · 第 ${offset / 20 + 1} 页`, [
					...labels,
					...(offset > 0 ? ["上一页"] : []),
					...(rows.length === 20 ? ["下一页"] : []),
					"返回",
				]);
				if (choice === "下一页") {
					offset += 20;
					continue;
				}
				if (choice === "上一页") {
					offset = Math.max(0, offset - 20);
					continue;
				}
				return rows[labels.indexOf(choice ?? "")];
			}
		}
		async function inbox(ctx: ExtensionContext) {
			const summary = await choosePage<InboxSummary>(
				ctx,
				"研读收件箱",
				"/inbox",
				(row) =>
					`${row.review_state === "unread" ? "●" : "○"} ${row.title} · ${priorityNames[row.priority] ?? row.priority}`,
			);
			if (!summary) return;
			let card = await client.request<InboxCard>(`/inbox/${summary.id}`);
			await showResearchText(ctx, card.payload.title, renderResearchCard(card));
			while (true) {
				const choice = await ctx.ui.select(card.payload.title, [
					"再次阅读",
					"标为已读",
					"稍后阅读",
					"有用",
					"无用",
					"相关",
					"不相关",
					"返回",
				]);
				if (!choice || choice === "返回") return;
				if (choice === "再次阅读") {
					card = await client.request(`/inbox/${summary.id}`);
					await showResearchText(ctx, card.payload.title, renderResearchCard(card));
					continue;
				}
				const feedback: Record<string, { kind: string; value: string }> = {
					标为已读: { kind: "reading_state", value: "read" },
					稍后阅读: { kind: "reading_state", value: "later" },
					有用: { kind: "usefulness", value: "useful" },
					无用: { kind: "usefulness", value: "not_useful" },
					相关: { kind: "relevance", value: "relevant" },
					不相关: { kind: "relevance", value: "not_relevant" },
				};
				await client.request(`/inbox/${summary.id}/feedback`, feedback[choice]);
				ctx.ui.notify("已保存反馈", "info");
			}
		}
		async function scan(ctx: ExtensionContext, overview: ResearchOverview, seed: boolean) {
			let library = overview.libraries[0];
			if (!library) library = await client.request("/libraries", { name: "我的论文库" });
			if (!seed && library.state === "seeding") {
				ctx.ui.notify("请先选择“首次建库”，为现有论文建立基线。", "warning");
				return;
			}
			const batch = await client.request<ResearchBatch>(`/libraries/${library.id}/scans`, {
				mode: seed ? "seed" : "incremental",
			});
			ctx.ui.notify(
				`${seed ? "首次建库" : "增量扫描"}已提交。可在“导入进度”中查看；首次建库不调用研读模型。批次 ${batch.id.slice(0, 8)}`,
				"info",
			);
		}
		async function topics(ctx: ExtensionContext, overview: ResearchOverview) {
			const labels = overview.topics.map(
				(topic) => `${topic.active ? "●" : "○"} ${topic.title} · v${topic.revision}`,
			);
			const choice = await ctx.ui.select("研究主题", ["新增主题", ...labels, "返回"]);
			if (choice !== "新增主题") {
				const topic = overview.topics[labels.indexOf(choice ?? "")];
				if (topic)
					await showResearchText(
						ctx,
						topic.title,
						`${topic.question}\n\n关注：${topic.focus.join("、")}\n排除：${topic.exclusions.join("、")}\n\n新主题仅处理未来导入的论文；历史论文可从“论文库与补读”手动发起。`,
					);
				return;
			}
			const library = overview.libraries[0];
			if (!library) {
				ctx.ui.notify("请先首次建库。", "warning");
				return;
			}
			const title = await ctx.ui.input("主题名称");
			if (!title?.trim()) return;
			const question = await ctx.ui.input("你希望研究什么具体问题？");
			if (!question?.trim()) return;
			const focus = await ctx.ui.input("关注维度（用中文或英文逗号分隔，可留空）");
			if (focus === undefined) return;
			const exclusions = await ctx.ui.input("排除内容（用逗号分隔，可留空）");
			if (exclusions === undefined) return;
			const split = (text: string) =>
				text
					.split(/[,，]/u)
					.map((part) => part.trim())
					.filter(Boolean);
			await client.request("/topics", {
				libraryId: library.id,
				title: title.trim(),
				question: question.trim(),
				focus: split(focus),
				exclusions: split(exclusions),
			});
			ctx.ui.notify("主题已创建；历史论文可手动补读。", "info");
		}
		async function papers(ctx: ExtensionContext, overview: ResearchOverview) {
			if (!overview.modelProcessingEnabled) {
				ctx.ui.notify("研读配置尚未启用模型处理。", "warning");
				return;
			}
			const paper = await choosePage<ResearchPaper>(
				ctx,
				"论文库与补读",
				"/papers",
				(row) => `${row.title}（${row.assets.some((asset) => asset.state === "ready") ? "可研读" : "索引未就绪"}）`,
			);
			if (!paper) return;
			const assets = paper.assets.filter((asset) => asset.state === "ready");
			if (!assets.length) {
				const action = await ctx.ui.select(`${paper.title}：索引尚未就绪，暂时不能研读；本次未创建研读任务。`, [
					"查看导入进度",
					"返回收件箱",
				]);
				if (action === "查看导入进度") await batches(ctx, await client.overview());
				return;
			}
			const assetLabels = assets.map((asset) => `${asset.source_path ?? "论文版本"} · ${asset.id.slice(0, 8)}`);
			const assetChoice = await ctx.ui.select("选择要研读的版本", assetLabels);
			const asset = assets[assetLabels.indexOf(assetChoice ?? "")];
			if (!asset) return;
			const topicLabels = overview.topics.map((topic, index) => `${index + 1}. ${topic.title}`);
			const topicChoice = await ctx.ui.select("选择研究主题", topicLabels);
			const topic = overview.topics[topicLabels.indexOf(topicChoice ?? "")];
			if (!topic) return;
			const run = await client.request<ResearchRun>(`/papers/${paper.id}/analyses`, {
				assetId: asset.id,
				topicId: topic.id,
			});
			const action = await ctx.ui.select(`研读任务 ${run.id.slice(0, 8)} 已提交`, ["查看任务进度", "返回收件箱"]);
			if (action === "查看任务进度") await viewRun(ctx, run.id);
		}
		async function runs(ctx: ExtensionContext, overview: ResearchOverview) {
			const labels = overview.runs.map(
				(run) => `${stateName(run.state)} · ${run.topic_snapshot.title} · ${run.id.slice(0, 8)}`,
			);
			const choice = await ctx.ui.select("最近研读任务", [...labels, "返回"]);
			const selected = overview.runs[labels.indexOf(choice ?? "")];
			if (!selected) return;
			await viewRun(ctx, selected.id);
		}
		async function viewRun(ctx: ExtensionContext, runId: string) {
			while (true) {
				const run = await client.request<ResearchRun>(`/runs/${runId}`);
				const retry = ["failed", "cancelled", "needs_review", "deferred", "not_selected"].includes(run.state);
				const action = await ctx.ui.select(`${stateName(run.state)} · ${run.topic_snapshot.title}`, [
					"查看详情",
					"刷新",
					...(!TERMINAL_RUNS.includes(run.state) ? ["取消任务"] : []),
					...(retry ? ["重新研读"] : []),
					"返回",
				]);
				if (!action || action === "返回") return;
				if (action === "查看详情")
					await showResearchText(
						ctx,
						"研读任务",
						`任务：${run.id}\n状态：${stateName(run.state)}\n主题：${run.topic_snapshot.question}\n\n${run.error ?? ""}\n${JSON.stringify(run.result ?? {}, null, 2)}`,
					);
				if (action === "取消任务") {
					await client.request(`/runs/${run.id}/cancel`, {});
					ctx.ui.notify("已请求取消", "info");
				}
				if (action === "重新研读") {
					const next = await client.request<ResearchRun>(`/runs/${run.id}/retry`, {});
					ctx.ui.notify(`已提交新任务 ${next.id.slice(0, 8)}`, "info");
					return;
				}
			}
		}
		async function batches(ctx: ExtensionContext, overview: ResearchOverview) {
			const labels = overview.batches.map(
				(batch) =>
					`${batch.kind === "seed" ? "首次建库" : "增量导入"} · ${stateName(batch.status)} · ${batch.id.slice(0, 8)}`,
			);
			const choice = await ctx.ui.select("导入进度", [...labels, "返回"]);
			const selected = overview.batches[labels.indexOf(choice ?? "")];
			if (!selected) return;
			const batch = await client.request<ResearchBatch>(`/batches/${selected.id}`);
			await showResearchText(ctx, "导入进度", renderResearchBatch(batch));
		}
		pi.registerCommand("research", {
			description: "论文研读收件箱：建库、主题、阅读卡片、进度与反馈",
			getArgumentCompletions: (prefix) =>
				actions.filter((action) => action.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				if (!ctx.hasUI || menuOpen) return;
				menuOpen = true;
				const mine = generation;
				try {
					let action = args.trim();
					while (mine === generation) {
						const overview = await client.overview();
						if (!action) {
							const choices = [
								"查看研读卡片",
								"研究主题",
								"论文库与补读",
								"研读任务",
								"导入进度",
								...(overview.libraries[0]?.state === "active"
									? ["扫描新增论文"]
									: ["首次建库（只登记现有论文）"]),
								"返回",
							];
							const choice = await ctx.ui.select(`论文研读收件箱 · ${overview.unread} 未读`, choices);
							if (!choice || choice === "返回") return;
							action = (
								{
									查看研读卡片: "inbox",
									研究主题: "topics",
									论文库与补读: "papers",
									研读任务: "runs",
									导入进度: "batches",
									扫描新增论文: "scan",
									"首次建库（只登记现有论文）": "seed",
								} as Record<string, string>
							)[choice];
						}
						if (action === "inbox") await inbox(ctx);
						else if (action === "topics") await topics(ctx, overview);
						else if (action === "papers") await papers(ctx, overview);
						else if (action === "runs") await runs(ctx, overview);
						else if (action === "batches") await batches(ctx, overview);
						else if (action === "scan" || action === "seed") await scan(ctx, overview, action === "seed");
						else if (action === "status")
							await showResearchText(
								ctx,
								"收件箱状态",
								`${overview.libraries[0]?.root_path ?? "尚未建库"}\n主题：${overview.topics.length}\n未读：${overview.unread}\n模型研读：${overview.modelProcessingEnabled ? "已启用" : "未启用"}`,
							);
						else ctx.ui.notify("请使用 /research 打开菜单。", "warning");
						if (args.trim()) return;
						action = "";
					}
				} catch (error) {
					if (mine === generation)
						ctx.ui.notify(
							`无法完成收件箱操作：${errorText(error)}。请确认完整调试启动项中的研读服务正在运行。`,
							"error",
						);
				} finally {
					menuOpen = false;
					if (mine === generation) await refresh(ctx, mine);
				}
			},
		});
	};
}
