import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { EvidenceLedger } from "../../src/agent/evidence-ledger.ts";
import { assertTableReads, createReadLocalTableTool } from "../../src/agent/read-local-table-tool.ts";
import { contentHash } from "../../src/indexing/chunker.ts";
import { type LocalEvidenceResult, type LocalReadHandle, localEvidence } from "../../src/indexing/evidence.ts";
import { serializeDocling } from "../../src/parser/table-structure.ts";

const vision = { input: ["text", "image"], baseUrl: "http://127.0.0.1:11434" } as Model<Api>;
function register(ledger: EvidenceLedger, handle: LocalReadHandle, text: string) {
	const result: LocalEvidenceResult = {
		id: handle.chunkId,
		source: handle.source,
		content: text,
		score: 1,
		metadata: {},
		[localEvidence]: { query: "", profile: handle.profile, vector: [], readHandle: handle },
	};
	return ledger.registerResult("fixture", result);
}
function handle(source: string, id: string, text: string): LocalReadHandle {
	return {
		version: 1,
		source,
		sourceId: "/doc",
		chunkId: id,
		profile: contentHash("profile"),
		bodySha256: contentHash(text),
		structureSha256: contentHash("structure"),
		outputSha256: contentHash("output"),
		sourceSha256: contentHash("source"),
	};
}

it("reads rows beyond topK, resumes the same cursor and rejects a cursor for another branch anchor", async () => {
	const ledger = new EvidenceLedger();
	const source = "/local/test.pdf";
	const { structure, markdown } = serializeDocling(
		[
			{
				table: {
					title: "",
					prov: [],
					data: {
						num_rows: 15,
						num_cols: 1,
						table_cells: Array.from({ length: 15 }, (_, i) => ({
							start_row_offset_idx: i,
							end_row_offset_idx: i + 1,
							start_col_offset_idx: 0,
							end_col_offset_idx: 1,
							column_header: i === 0,
							text: i === 0 ? "Course" : i === 14 ? "Outside topK" : "Identical record",
						})),
					},
				},
			},
		],
		[],
		source,
		true,
	);
	const chunks = structure.tables[0].rows.map((range, i) => {
		const text = markdown.slice(range.start, range.end);
		const loc = handle(source, String(i), text);
		return {
			handle: loc,
			row: {
				id: String(i),
				source_id: "/doc",
				source_path: source,
				text,
				heading: "",
				kind: "table",
				tokens: 3,
				start: range.start,
				end: range.end,
			},
		};
	});
	const evidenceId = register(ledger, chunks[0].handle, chunks[0].row.text);
	const read = async () => ({ structure, chunks, check: async () => {} });
	const tool = createReadLocalTableTool(ledger, read, () => vision);
	const first = await tool.execute("first", { evidenceId, view: "rows" });
	expect(first.details).toMatchObject({ coveredRows: 12, totalRows: 14, exhausted: false });
	const cursor = (first.details as { nextCursor: string }).nextCursor;
	const entries = ledger.takeUnsaved();
	const resumed = new EvidenceLedger();
	resumed.restore(entries);
	const afterResume = createReadLocalTableTool(resumed, read, () => vision);
	const last = await afterResume.execute("last", { evidenceId, view: "rows", cursor });
	expect(last.details).toMatchObject({ coveredRows: 14, totalRows: 14, exhausted: true, unindexedRows: 0 });
	expect(last.content[0]).toMatchObject({ text: expect.stringContaining("Outside topK") });
	expect(new Set(entries.map((entry) => entry.id)).size).toBe(12);
	const other = register(resumed, chunks[13].handle, chunks[13].row.text);
	await expect(afterResume.execute("bad", { evidenceId: other, view: "rows", cursor })).rejects.toThrow(
		"another anchor",
	);
	resumed.clear();
	await expect(afterResume.execute("bad", { evidenceId, view: "rows", cursor })).rejects.toThrow("session branch");
});

it("emits verified original image bytes and blocks a text-only or remote answer model", async () => {
	const root = await mkdtemp(join(tmpdir(), "autorag-table-image-"));
	try {
		const source = join(root, "fixture.png");
		const { createCanvas } = await import("@napi-rs/canvas");
		const canvas = createCanvas(24, 24);
		const bytes = await canvas.encode("png");
		await writeFile(source, bytes);
		const locator = {
			...handle(source, "c", "fixture"),
			sourceSha256: createHash("sha256").update(bytes).digest("hex"),
		};
		const ledger = new EvidenceLedger();
		const evidenceId = register(ledger, locator, "fixture");
		const read = async () => ({
			structure: serializeDocling([], [], source, true).structure,
			chunks: [],
			check: async () => {},
		});
		const tool = createReadLocalTableTool(ledger, read, () => vision);
		const result = await tool.execute("call", { evidenceId, view: "image" });
		expect(result.details).toMatchObject({ page: 1, totalPages: 1, exhausted: true });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "call",
			toolName: tool.name,
			content: result.content,
			timestamp: 0,
			isError: false,
		};
		assertTableReads([message], () => true, vision);
		expect(() => assertTableReads([message], () => false, vision)).toThrow("scope");
		expect(() => assertTableReads([message], () => true, { ...vision, input: ["text"] })).toThrow("does not accept");
		expect(() => assertTableReads([message], () => true, { ...vision, baseUrl: "https://example.com" })).toThrow(
			"loopback",
		);
		await writeFile(source, "changed");
		await expect(tool.execute("changed", { evidenceId, view: "image" })).rejects.toThrow("changed before rendering");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
