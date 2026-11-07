import type { DocumentStructure } from "../parser/table-structure.ts";
import { chunkMarkdown } from "./chunker.ts";
import type { IndexChunk, TokenCounter } from "./types.ts";

export const TABLE_CHUNKER_VERSION = "table-rows-v1";

export function chunkStructured(
	markdown: string,
	structure: DocumentStructure,
	tokenizer: TokenCounter,
	options: { targetTokens?: number; maxTokens?: number },
	passagePrefix: string,
): IndexChunk[] {
	const max = options.maxTokens ?? 768;
	const target = options.targetTokens ?? Math.min(512, max);
	const budget = { ...tokenizer, count: (text: string) => tokenizer.count(passagePrefix + text) };
	const chunks: IndexChunk[] = [];
	const fits = (prefix: string, text: string, limit = max) =>
		Buffer.byteLength(text, "utf8") <= 64 * 1024 && budget.count(prefix + text) <= limit;
	const safeEnd = (text: string, end: number) => {
		const previous = text.charCodeAt(end - 1);
		return previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end;
	};
	const context = (value: string): string => {
		while (value && budget.count(`${value}\n`) > Math.floor(max / 3))
			value = value.slice(0, safeEnd(value, Math.floor(value.length * 0.75)));
		return value ? `${value}\n` : "";
	};
	const emit = (start: number, end: number, heading: string, kind = "table") => {
		const text = markdown.slice(start, end);
		const embeddingText = heading + text;
		if (!fits(heading, text)) throw new Error(`Structured table chunk exceeds its budget at offset ${start}`);
		chunks.push({
			start,
			end,
			text,
			embeddingText,
			heading: heading.trim(),
			kind,
			tokens: budget.count(embeddingText),
		});
	};
	let cursor = 0;
	const prose = (end: number) => {
		for (const chunk of chunkMarkdown(markdown.slice(cursor, end), tokenizer, options))
			chunks.push({ ...chunk, start: chunk.start + cursor, end: chunk.end + cursor });
	};
	for (const table of structure.tables) {
		if (
			!Number.isInteger(table.start) ||
			!Number.isInteger(table.end) ||
			table.start < cursor ||
			table.end <= table.start ||
			table.end > markdown.length
		)
			throw new Error("Invalid table Markdown range");
		prose(table.start);
		const heading = context([structure.title, table.title].filter(Boolean).join(" · "));
		let group: { start: number; end: number; label?: string } | undefined;
		const flush = () => {
			if (group) emit(group.start, group.end, heading);
			group = undefined;
		};
		let last = table.start;
		for (const row of table.rows) {
			if (
				!Number.isInteger(row.start) ||
				!Number.isInteger(row.end) ||
				row.start < last ||
				row.end <= row.start ||
				row.end > table.end
			)
				throw new Error("Invalid table row Markdown range");
			last = row.end;
			if (fits(heading, markdown.slice(row.start, row.end))) {
				if (group && group.label === row.group && fits(heading, markdown.slice(group.start, row.end), target))
					group.end = row.end;
				else {
					flush();
					group = { start: row.start, end: row.end, label: row.group };
				}
				continue;
			}
			flush();
			const first = row.fields[0];
			const anchor = first ? markdown.slice(first.start, first.end) : "";
			const fragmentHeading = context(
				`${table.id}/r${row.row + 1} · ${anchor}\n${row.group ?? ""}\n${heading.trim()}`,
			);
			let fragment: { start: number; end: number } | undefined;
			let lastField = row.start;
			const flushFields = () => {
				if (fragment) emit(fragment.start, fragment.end, fragmentHeading, "table-row-fragment");
				fragment = undefined;
			};
			for (const field of row.fields) {
				if (
					!Number.isInteger(field.start) ||
					!Number.isInteger(field.end) ||
					field.start < lastField ||
					field.end <= field.start ||
					field.end > row.end
				)
					throw new Error("Invalid table field Markdown range");
				lastField = field.end;
				const fieldText = markdown.slice(field.start, field.end);
				if (fragment && fits(fragmentHeading, markdown.slice(fragment.start, field.end))) {
					fragment.end = field.end;
					continue;
				}
				flushFields();
				if (fits(fragmentHeading, fieldText)) {
					fragment = { start: field.start, end: field.end };
					continue;
				}
				const cellHeading = context(
					`${table.id}/r${row.row + 1}c${field.column + 1} · ${field.label}\n${fragmentHeading.trim()}`,
				);
				for (let start = 0; start < fieldText.length; ) {
					let low = start + 1;
					let high = fieldText.length;
					let end = start;
					while (low <= high) {
						const mid = (low + high) >>> 1;
						const cut = safeEnd(fieldText, mid);
						if (fits(cellHeading, fieldText.slice(start, cut))) {
							end = Math.max(end, cut);
							low = mid + 1;
						} else high = mid - 1;
					}
					if (end === start) throw new Error("Cannot fit a table cell character in the embedding budget");
					emit(field.start + start, field.start + end, cellHeading, "table-cell-fragment");
					start = end;
				}
			}
			flushFields();
		}
		flush();
		cursor = table.end;
	}
	prose(markdown.length);
	return chunks;
}
