import { createHash } from "node:crypto";
import type { IndexChunk, TokenCounter } from "./types.ts";

export const CHUNKER_VERSION = "structure-v1";

export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Structure first; token budgets include heading context and any repeated table header. */
export function chunkMarkdown(
	markdown: string,
	tokenizer: TokenCounter,
	options: { targetTokens?: number; maxTokens?: number } = {},
): IndexChunk[] {
	const max = options.maxTokens ?? 768;
	const target = options.targetTokens ?? Math.min(512, max);
	if (!Number.isInteger(max) || max < 32 || !Number.isInteger(target) || target < 1 || target > max) {
		throw new RangeError("indexing token budgets must satisfy 1 <= targetTokens <= maxTokens and maxTokens >= 32");
	}
	const chunks: IndexChunk[] = [];
	const headings: string[] = [];
	let pending: { text: string; start: number; end: number; kind: string; context: string } | undefined;
	const context = (): string => {
		let title = headings.filter(Boolean).join(" > ");
		while (title && tokenizer.count(`${title}\n\n`) > Math.min(64, Math.floor(max / 4))) {
			title = title.slice(0, safeEnd(title, Math.floor(title.length * 0.75)));
		}
		return title ? `${title}\n\n` : "";
	};
	const emit = (text: string, start: number, end: number, kind: string, prefix: string): void => {
		if (!text.trim()) return;
		const embeddingText = `${prefix}${text}`;
		const tokens = tokenizer.count(embeddingText);
		if (tokens > max) throw new Error(`chunk exceeded ${max} tokens (${tokens}) at markdown offset ${start}`);
		chunks.push({ text, embeddingText, heading: prefix.trim(), kind, start, end, tokens });
	};
	const flush = (): void => {
		if (pending) emit(pending.text, pending.start, pending.end, pending.kind, pending.context);
		pending = undefined;
	};
	const splitLong = (text: string, start: number, kind: string, prefix: string): void => {
		let position = 0;
		while (position < text.length) {
			let low = position + 1;
			let high = text.length;
			let end = position;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const cut = safeEnd(text, middle);
				if (cut > position && tokenizer.count(`${prefix}${text.slice(position, cut)}`) <= max) {
					end = cut;
					low = middle + 1;
				} else high = middle - 1;
			}
			if (end <= position) throw new Error(`cannot fit a Unicode character in chunk at ${start + position}`);
			if (end < text.length) {
				const tail = text.slice(position, end);
				const boundaries = [...tail.matchAll(/[。！？.!?]\s*|\n/g)];
				const last = boundaries.at(-1);
				if (last && last.index + last[0].length > tail.length / 2) end = position + last.index + last[0].length;
			}
			emit(text.slice(position, end), start + position, start + end, kind, prefix);
			if (end === text.length) break;
			// Overlap only forced prose splits; normal structural boundaries do not duplicate text.
			let next = end;
			if (kind === "paragraph") {
				const overlap = Math.min(64, Math.floor(max / 8));
				while (next > position && tokenizer.count(text.slice(next, end)) < overlap) {
					const previous = safeEnd(text, next - 1);
					if (previous <= position) break;
					next = previous;
				}
			}
			position = next > position ? next : end;
		}
	};
	const add = (text: string, start: number, kind: string, prefix = context()): void => {
		if (!text.trim()) return;
		if (tokenizer.count(`${prefix}${text}`) > max) {
			flush();
			splitLong(text, start, kind, prefix);
			return;
		}
		if (
			pending &&
			pending.context === prefix &&
			pending.kind === kind &&
			tokenizer.count(`${prefix}${markdown.slice(pending.start, start + text.length)}`) <= target
		) {
			pending.text = markdown.slice(pending.start, start + text.length);
			pending.end = start + text.length;
		} else {
			flush();
			pending = { text, start, end: start + text.length, kind, context: prefix };
		}
	};
	const lines = [...markdown.matchAll(/[^\n]*\n|[^\n]+$/g)];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i][0];
		const start = lines[i].index;
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd());
		if (heading) {
			flush();
			headings.length = heading[1].length;
			headings[heading[1].length - 1] = heading[2];
			add(line, start, "heading");
			flush();
		} else if (/^\s*(`{3,}|~{3,})/.test(line)) {
			flush();
			const fence = /^\s*(`{3,}|~{3,})/.exec(line)![1];
			let block = line;
			while (++i < lines.length) {
				block += lines[i][0];
				if (lines[i][0].trimStart().startsWith(fence)) break;
			}
			add(block, start, "code");
			flush();
		} else if (/^\s*\|.*\|/.test(line)) {
			flush();
			const tableLines = [line];
			while (i + 1 < lines.length && /^\s*\|.*\|/.test(lines[i + 1][0])) tableLines.push(lines[++i][0]);
			const header =
				tableLines.length > 1 && /^\s*\|?[\s:|-]+\|/.test(tableLines[1]) ? tableLines[0] + tableLines[1] : "";
			let repeatedHeader = header;
			while (repeatedHeader && tokenizer.count(`${context()}${repeatedHeader}`) > Math.floor(max / 2)) {
				repeatedHeader = repeatedHeader.slice(0, safeEnd(repeatedHeader, Math.floor(repeatedHeader.length * 0.75)));
			}
			let offset = start;
			let block = "";
			let blockStart = start;
			const tablePrefix = () => (blockStart > start ? `${context()}${repeatedHeader}` : context());
			const flushTable = () => {
				if (block) {
					add(block, blockStart, "table", tablePrefix());
					flush();
					block = "";
				}
			};
			for (const row of tableLines) {
				if (block && tokenizer.count(`${tablePrefix()}${block}${row}`) > max) {
					flushTable();
					blockStart = offset;
				}
				if (tokenizer.count(`${tablePrefix()}${row}`) > max) {
					splitLong(row, offset, "table-row", tablePrefix());
					blockStart = offset + row.length;
				} else block += row;
				offset += row.length;
			}
			flushTable();
		} else {
			let block = line;
			while (
				i + 1 < lines.length &&
				lines[i + 1][0].trim() &&
				!/^\s*(?:#{1,6}\s|`{3,}|~{3,}|\|.*\|)/.test(lines[i + 1][0]) &&
				line.trim()
			) {
				block += lines[++i][0];
			}
			add(block, start, /^\s*(?:[-*+]\s|\d+\.\s)/.test(block) ? "list" : "paragraph");
		}
	}
	flush();
	return chunks;
}

function safeEnd(text: string, end: number): number {
	const previous = text.charCodeAt(end - 1);
	return previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end;
}
