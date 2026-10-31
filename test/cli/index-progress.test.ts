import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexProgress } from "../../src/cli/index-progress.ts";
import type { IndexEvent } from "../../src/indexing/types.ts";

afterEach(() => vi.useRealTimers());

describe("index progress", () => {
	it("reports completed batches and wait time on stderr without inventing progress", () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const progress = createIndexProgress({ stderr: (line) => lines.push(line), debug: false });
		const event: IndexEvent = {
			runId: "test",
			phase: "embed",
			state: "start",
			elapsedMs: 0,
			count: 4,
			progress: { documents: 1, chunks: 8, embedded: 0, reused: 0, unchanged: 0, deleted: 0 },
		};
		try {
			progress.onProgress({ phase: "parsed", processed: 1, total: 2, currentVirtualPath: "/docs/a.pdf" });
			progress.onIndexEvent(event);
			expect(lines.join("\n")).toContain("文件解析 1/2");
			vi.advanceTimersByTime(10_000);
			expect(lines.at(-1)).toContain("尚未收到新的完成事件");
			expect(lines.at(-1)).toContain("已向量化 0");
			progress.onIndexEvent({ ...event, state: "end", progress: { ...event.progress!, embedded: 4 } });
			expect(lines.at(-1)).toContain("已向量化 4");
			progress.onIndexEvent({ ...event, state: "error", detail: "HTTP 500: /test/provider failed" });
			expect(lines.at(-1)).toContain("HTTP 500: /test/provider failed");
		} finally {
			progress.close();
		}
		const count = lines.length;
		vi.advanceTimersByTime(30_000);
		expect(lines).toHaveLength(count);
	});
});
