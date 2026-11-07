import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contentHash } from "../../src/indexing/chunker.ts";
import { LocalDocumentIndex } from "../../src/indexing/pipeline.ts";
import { chunkStructured } from "../../src/indexing/table-chunker.ts";
import { saveMirrorIndex } from "../../src/mirror/index-store.ts";
import { readStructure, writeStructuredMirror } from "../../src/mirror/structured.ts";
import { serializeDocling } from "../../src/parser/table-structure.ts";

function cell(
	r0: number,
	c0: number,
	text: string,
	options: { rows?: number; columns?: number; header?: boolean } = {},
) {
	return {
		text,
		start_row_offset_idx: r0,
		end_row_offset_idx: r0 + (options.rows ?? 1),
		start_col_offset_idx: c0,
		end_col_offset_idx: c0 + (options.columns ?? 1),
		column_header: options.header ?? false,
	};
}
const counter = { fingerprint: "test-codepoints", count: (text: string) => [...text].length };
const make = () =>
	serializeDocling(
		[
			{ label: "title", text: "Report" },
			{
				table: {
					title: "成绩记录",
					prov: [],
					data: {
						num_rows: 4,
						num_cols: 4,
						table_cells: [
							cell(0, 0, "课程", { rows: 2, header: true }),
							cell(0, 1, "结果", { columns: 2, header: true }),
							cell(0, 3, "备注", { rows: 2, header: true }),
							cell(1, 1, "学期", { header: true }),
							cell(1, 2, "成绩", { header: true }),
							cell(2, 0, "体育"),
							cell(2, 1, "春季", { rows: 2 }),
							cell(2, 2, "88"),
							cell(2, 3, ""),
							cell(3, 0, "体育"),
							cell(3, 2, "91"),
							cell(3, 3, "说明😀。".repeat(100)),
						],
					},
				},
			},
			{
				table: {
					title: "",
					prov: [],
					data: { num_rows: 2, num_cols: 1, table_cells: [cell(0, 0, "原记录"), cell(1, 0, "下一页表格")] },
				},
			},
			{ label: "text", text: "After the tables" },
		],
		[],
		"/fixture.pdf",
		true,
	);

it("keeps multirow headers and merges while splitting oversized rows into exact offsets", () => {
	const { structure, markdown } = make();
	const table = structure.tables[0];
	expect(table.headers[2]).toEqual(["结果", "成绩"]);
	expect(table.rows.map((row) => row.fields[1].cell)).toEqual([6, 6]);
	expect(markdown).toContain("课程: 体育 | 结果 / 学期: 春季 | 结果 / 成绩: 88 | 备注: ");
	const chunks = chunkStructured(markdown, structure, counter, { targetTokens: 60, maxTokens: 80 }, "pre:");
	for (const chunk of chunks) {
		expect(chunk.text).toBe(markdown.slice(chunk.start, chunk.end));
		expect(counter.count("pre:" + chunk.embeddingText)).toBeLessThanOrEqual(80);
		expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
	}
	expect(chunks.some((chunk) => chunk.kind === "table-row-fragment" && chunk.embeddingText.includes("r4"))).toBe(true);
	const long = chunks.filter((chunk) => chunk.kind === "table-cell-fragment");
	expect(long.length).toBeGreaterThan(1);
	expect(long.map((chunk) => chunk.text).join("")).toBe("备注: " + "说明😀。".repeat(100));
	expect(chunks.some((chunk) => chunk.text.includes("88") && chunk.text.includes("91"))).toBe(false);
	expect(chunks.some((chunk) => chunk.text.includes("91") && chunk.text.includes("下一页"))).toBe(false);
	expect(structure.tables[1].headers).toEqual([[]]);
	expect(chunks.at(-1)?.text).toContain("After the tables");
});

it("rejects a corrupted or missing companion without changing the prior immutable pair", async () => {
	const root = await mkdtemp(join(tmpdir(), "autorag-structure-test-"));
	try {
		const { markdown, structure } = make();
		const revision = {
			virtualPath: "/fixture.pdf",
			sourceSha256: "a".repeat(64),
			outputSha256: contentHash(markdown),
			parserVersion: "one",
		};
		const old = { ...revision, ...writeStructuredMirror(root, revision, markdown, structure) };
		const nextRevision = { ...revision, parserVersion: "two" };
		const next = { ...nextRevision, ...writeStructuredMirror(root, nextRevision, markdown, structure) };
		expect(old.outputPath).not.toBe(next.outputPath);
		const sidecar = next.outputPath.replace(/\.md$/u, ".json");
		await rm(sidecar);
		await expect(readStructure(root, next, markdown)).rejects.toThrow("ENOENT");
		await writeFile(sidecar, "{}");
		await expect(readStructure(root, next, markdown)).rejects.toThrow("SHA-256");
		expect(await readStructure(root, old, await readFile(old.outputPath, "utf8"))).toEqual(structure);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("keeps the active Lance generation when a refresh stops after writing to its candidate", async () => {
	const root = await mkdtemp(join(tmpdir(), "autorag-table-generation-"));
	try {
		const index = new LocalDocumentIndex({
			root,
			parserBackend: "docling",
			tokenizer: counter,
			debug: true,
			embedder: {
				identity: async () => ({ provider: "test", model: "fixture", dimension: 2 }),
				embed: async (texts) => texts.map(() => [1, 0]),
			},
		});
		const sourcePath = join(root, "grades.pdf");
		const virtualPath = "/grades.pdf";
		const stage = async (text: string) => {
			await writeFile(sourcePath, text);
			const { markdown, structure } = serializeDocling([{ text }], [], virtualPath, true);
			const revision = {
				virtualPath,
				sourceSha256: contentHash(text),
				outputSha256: contentHash(markdown),
				parserVersion: "one",
			};
			const entry = {
				...revision,
				...writeStructuredMirror(root, revision, markdown, structure),
				sourcePath,
				parserName: "docling",
				updatedAt: text,
				sourceMtimeNs: 0,
				sourceSizeBytes: text.length,
			};
			saveMirrorIndex(root, { version: 1, entries: { [virtualPath]: entry } }, "docling");
			return entry;
		};
		await stage("Original score");
		expect((await index.sync()).ok).toBe(true);
		const readyPath = join(index.directory, "ready.json");
		const originalReady = await readFile(readyPath, "utf8");
		expect((await index.sync()).unchanged).toBe(1);
		expect(await readFile(readyPath, "utf8")).toBe(originalReady);
		const changed = await stage("Revised score");
		await expect(
			index.sync(
				(async function* () {
					yield changed;
					throw new Error("interrupted after candidate write");
				})(),
			),
		).rejects.toThrow("interrupted after candidate write");
		expect(await readFile(readyPath, "utf8")).toBe(originalReady);
		expect((await index.search("original", { mode: "bm25" }))[0]?.row.text).toContain("Original score");
		expect(await index.search("revised", { mode: "bm25" })).toEqual([]);
		expect((await index.sync()).ok).toBe(true);
		expect((await index.search("revised", { mode: "bm25" }))[0]?.row.text).toContain("Revised score");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
