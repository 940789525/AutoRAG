import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { contentHash } from "../indexing/chunker.ts";
import { type LocalEvidenceResult, type LocalReadHandle, localEvidence } from "../indexing/evidence.ts";
import { renderOriginalPage } from "../indexing/original-page.ts";
import type { LocalDocumentIndex } from "../indexing/pipeline.ts";
import type { EvidenceLedger } from "./evidence-ledger.ts";
import { IMAGE_OMITTED_NOTE } from "./request-limits.ts";

export const READ_LOCAL_TABLE_TOOL_NAME = "read_local_table";
const schema = Type.Object(
	{
		evidenceId: Type.String({ pattern: "^e[1-9][0-9]*$" }),
		view: Type.Union([Type.Literal("rows"), Type.Literal("image")]),
		cursor: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,6}\\.[a-f0-9]{64}$" })),
	},
	{ additionalProperties: false },
);
const HEADER = "AutoRAG verified table read ";

export function localVisionError(model?: Model<Api>): string | undefined {
	if (!model?.input.includes("image")) return "The current answer model does not accept images";
	try {
		const url = new URL(model.baseUrl);
		if (["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
			return undefined;
	} catch {}
	return "Original-page images require a local loopback answer model";
}

export function createReadLocalTableTool(
	ledger: EvidenceLedger,
	read: (
		handle: LocalReadHandle,
		rows: boolean,
		signal?: AbortSignal,
	) => ReturnType<LocalDocumentIndex["readTableSource"]>,
	model: () => Model<Api> | undefined,
): AgentTool {
	return {
		name: READ_LOCAL_TABLE_TOOL_NAME,
		label: "Read Local Table",
		description:
			"Page through all indexed tables in the verified source of an [eN] anchor, including rows outside search topK. For missing or uncertain OCR use image to inspect whole original PDF pages in order, including pages with no detected table. Pass nextCursor with the same anchor and view until exhausted. No paths are accepted.",
		parameters: schema,
		async execute(_callId, params, signal) {
			if (!Value.Check(schema, params))
				throw new Error("Expected evidenceId, rows or image view, and optional nextCursor");
			const entry = ledger.localReadEntry(params.evidenceId);
			const handle = entry?.localReadHandle;
			if (!entry || !handle || entry.source !== handle.source || entry.retrievalResultId !== handle.chunkId)
				throw new Error("No verified local evidence locator in this session branch; search again");
			if (!handle.structureSha256) throw new Error("This evidence has no structured mirror; search a Docling index");
			const cursor = (offset: number) =>
				`${offset}.${contentHash(JSON.stringify([entry.id, entry.key, handle, params.view, offset]))}`;
			const offset = params.cursor ? Number(params.cursor.split(".")[0]) : 0;
			if (params.cursor && params.cursor !== cursor(offset))
				throw new Error("Table cursor belongs to another anchor, view or index version; search again");
			if (params.view === "image") {
				const error = localVisionError(model());
				if (error) throw new Error(error);
			}
			const source = await read(handle, params.view === "rows", signal);
			const check = async () => {
				await source.check();
				const current = ledger.localReadEntry(entry.id);
				if (current?.key !== entry.key || JSON.stringify(current.localReadHandle) !== JSON.stringify(handle))
					throw new Error("Table evidence session branch changed while reading");
				signal?.throwIfAborted();
			};
			if (params.view === "image") {
				const page = offset + 1;
				const { image, total } = await renderOriginalPage(handle, page, signal);
				await check();
				const details = {
					source: handle.source,
					sourceId: handle.sourceId,
					evidenceId: entry.id,
					view: "image",
					page,
					totalPages: total,
					exhausted: page === total,
					nextCursor: page < total ? cursor(page) : undefined,
					imageSha256: contentHash(image.data),
				};
				return { content: [{ type: "text", text: `${HEADER}${JSON.stringify(details)}` }, image], details };
			}
			const ordered = source.chunks.sort(
				(a, b) => a.row.start - b.row.start || a.row.end - b.row.end || a.row.id.localeCompare(b.row.id),
			);
			if (offset >= ordered.length && params.cursor) throw new Error("Table cursor is past the indexed row groups");
			const selected: typeof ordered = [];
			let bytes = 0;
			for (const item of ordered.slice(offset, offset + 12)) {
				const size = Buffer.byteLength(item.row.text);
				if (size > 16_384)
					throw new Error("A table chunk exceeds the 16 KiB page budget; inspect the original page");
				if (bytes + size > 16_384) break;
				selected.push(item);
				bytes += size;
			}
			const end = offset + selected.length;
			const tables = source.structure.tables;
			const logicalRows = tables.flatMap((table) => table.rows);
			const through = (limit: number) => {
				const ranges: { start: number; end: number }[] = [];
				for (const { row } of ordered.slice(0, limit)) {
					const last = ranges.at(-1);
					if (last && row.start <= last.end) last.end = Math.max(last.end, row.end);
					else ranges.push({ start: row.start, end: row.end });
				}
				let i = 0;
				return logicalRows.filter((row) =>
					row.fields.every((field) => {
						while (ranges[i] && ranges[i].end <= field.start) i++;
						return ranges[i] && ranges[i].start <= field.start && ranges[i].end >= field.end;
					}),
				).length;
			};
			const indexedRows = through(ordered.length);
			await check();
			const text = selected
				.map(({ row, handle }) => {
					const table = tables.find((value) => row.start >= value.start && row.end <= value.end)!;
					const result: LocalEvidenceResult = {
						id: row.id,
						source: handle.source,
						content: row.text,
						score: 0,
						metadata: { method: READ_LOCAL_TABLE_TOOL_NAME, evidenceLocation: table.id },
						[localEvidence]: { query: "", profile: handle.profile, vector: [], readHandle: handle },
					};
					const id = ledger.registerResult(READ_LOCAL_TABLE_TOOL_NAME, result);
					const rowIds = table.rows.filter((r) => r.start < row.end && r.end > row.start).map((r) => r.row + 1);
					const locations = table.locations.map(({ kind, number }) => `${kind} ${number}`).join(", ");
					return `[${id}] table=${table.id} rows=${rowIds.join(",")} kind=${row.kind}${locations ? ` (${locations})` : ""}\n${row.text}`;
				})
				.join("\n");
			const details = {
				source: handle.source,
				sourceId: handle.sourceId,
				evidenceId: entry.id,
				view: "rows",
				tableCount: tables.length,
				coveredRows: through(end),
				totalRows: logicalRows.length,
				unindexedRows: logicalRows.length - indexedRows,
				exhausted: end === ordered.length,
				nextCursor: end < ordered.length ? cursor(end) : undefined,
				requiresOriginalReview:
					tables.length === 0 ||
					source.structure.quality.warnings.length > 0 ||
					indexedRows !== logicalRows.length,
				bodySha256: contentHash(text),
			};
			return { content: [{ type: "text", text: `${HEADER}${JSON.stringify(details)}\n${text}` }], details };
		},
	};
}

export function assertTableReads(
	messages: readonly AgentMessage[],
	authorize: (source: string, sourceId: string) => boolean,
	model: Model<Api>,
): void {
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== READ_LOCAL_TABLE_TOOL_NAME || message.isError) continue;
		const first = message.content[0];
		if (first?.type !== "text" || !first.text.startsWith(HEADER))
			throw new Error("Table evidence was truncated before model dispatch");
		const [header, ...body] = first.text.split("\n");
		const meta = JSON.parse(header.slice(HEADER.length));
		if (!authorize(meta.source, meta.sourceId)) throw new Error("Table source is outside the current scope");
		if (meta.view === "rows") {
			if (contentHash(body.join("\n")) !== meta.bodySha256)
				throw new Error("Table rows were truncated before model dispatch");
		} else {
			const image = message.content[1];
			if (image?.type === "text" && image.text === IMAGE_OMITTED_NOTE) continue;
			const error = localVisionError(model);
			if (error) throw new Error(error);
			if (image?.type !== "image" || contentHash(image.data) !== meta.imageSha256)
				throw new Error("Original page is missing or altered in the model request");
		}
	}
}
