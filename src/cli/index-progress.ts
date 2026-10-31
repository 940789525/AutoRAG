import type { AutoRAGRefreshProgress } from "../agent/agent.ts";
import { formatIndexEvent } from "../indexing/progress.ts";
import type { IndexEvent } from "../indexing/types.ts";
import type { CommandContext } from "./commands/types.ts";

/** Progress stays on stderr, including with --json; it never changes batching. */
export function createIndexProgress(ctx: Pick<CommandContext, "stderr" | "debug">) {
	const started = Date.now();
	let lastPrinted = 0;
	let latest: IndexEvent | undefined;
	let parsing: AutoRAGRefreshProgress | undefined;
	let current = "正在启动索引";
	const print = (text: string) => {
		ctx.stderr(`[索引 ${Math.floor((Date.now() - started) / 1000)}秒] ${text}`);
		lastPrinted = Date.now();
	};
	print(current);
	const timer = setInterval(() => {
		if (Date.now() - lastPrinted >= 10_000) print(`最近进度：${current} · 任务尚未结束，尚未收到新的完成事件`);
	}, 1000);
	timer.unref();
	return {
		onProgress(event: AutoRAGRefreshProgress) {
			parsing = event;
			const label = event.phase === "parsed" ? "解析文档" : "更新数据源";
			const text = `${label} ${event.processed}/${event.total}${event.currentVirtualPath ? ` · ${event.currentVirtualPath}` : ""}`;
			if (!latest || latest.phase === "done") current = text;
			if (event.processed === 0 || event.processed === event.total || Date.now() - lastPrinted >= 500) print(text);
		},
		onIndexEvent(event: IndexEvent) {
			const changed = latest?.phase !== event.phase;
			latest = event;
			current = formatIndexEvent(event);
			if (parsing?.phase === "parsed") current += ` · 文件解析 ${parsing.processed}/${parsing.total}`;
			if (ctx.debug) ctx.stderr(JSON.stringify(event));
			if (
				changed ||
				event.state === "error" ||
				event.phase === "done" ||
				(event.phase === "embed" && event.state === "end") ||
				Date.now() - lastPrinted >= 500
			)
				print(current);
		},
		close() {
			clearInterval(timer);
		},
	};
}
