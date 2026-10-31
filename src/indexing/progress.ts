import type { IndexEvent, IndexPhase } from "./types.ts";

export const INDEX_PHASE_LABELS: Record<IndexPhase, string> = {
	prepare: "准备索引",
	parse: "解析文档",
	chunk: "生成分块",
	lexical: "建立关键词索引",
	cache: "检查向量缓存",
	embed: "向量化",
	write: "写入索引",
	maintain: "整理索引",
	done: "索引结束",
};

export function formatIndexEvent(event: IndexEvent): string {
	const state = event.state === "error" ? "失败" : event.state === "end" ? "完成" : "进行中";
	const progress = event.progress;
	return [
		`${INDEX_PHASE_LABELS[event.phase]}：${state}`,
		event.source,
		event.count === undefined ? undefined : `本批 ${event.count} 项`,
		progress
			? `已处理文档 ${progress.documents}，分块 ${progress.chunks}，已向量化 ${progress.embedded}，复用 ${progress.reused}，未变更 ${progress.unchanged}`
			: undefined,
		event.durationMs === undefined ? undefined : `本阶段 ${(event.durationMs / 1000).toFixed(1)} 秒`,
		event.detail,
	]
		.filter((part) => part !== undefined && part !== "")
		.join(" · ");
}
