import { basename, extname } from "node:path";

interface Cell {
	readonly text: string;
	readonly r0: number;
	readonly r1: number;
	readonly c0: number;
	readonly c1: number;
	readonly role?: "column-header" | "row-header" | "section";
}

export interface TableField {
	readonly start: number;
	readonly end: number;
	readonly column: number;
	readonly cell: number;
	readonly label: string;
}

export interface TableRow {
	readonly row: number;
	readonly group?: string;
	readonly start: number;
	readonly end: number;
	readonly fields: readonly TableField[];
}

export interface DocumentTable {
	readonly id: string;
	readonly title: string;
	readonly start: number;
	readonly end: number;
	readonly rowCount: number;
	readonly columnCount: number;
	readonly cells: readonly Cell[];
	readonly headers: readonly (readonly string[])[];
	readonly rows: readonly TableRow[];
	readonly locations: readonly TableLocation[];
}

interface TableLocation {
	readonly kind: "page" | "sheet";
	readonly number: number;
	readonly bounds: readonly number[];
	readonly origin: "TOPLEFT" | "BOTTOMLEFT";
	readonly unit: "docling-page" | "cell";
}

export interface DocumentStructure {
	readonly version: 1;
	readonly title: string;
	readonly tables: readonly DocumentTable[];
	readonly quality: {
		readonly ocrConfigured: boolean;
		readonly ocrModel?: string;
		readonly warnings: readonly string[];
	};
}

const RECORD_FIELDS =
	/^(课程(?:名称)?(?:course)?|学期(?:term)?|成绩(?:score)?|学分(?:credits?)?|course(?:name)?|term|semester|grade|score|credits?)$/iu;

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Docling object");
	return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Invalid Docling array");
	return value;
}

function integer(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
		throw new Error(`Invalid Docling table coordinate: ${String(value)}`);
	return value;
}

function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid Docling text");
	return value.normalize("NFC");
}

function line(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function serializeDocling(
	blocks: unknown,
	diagnostics: unknown,
	virtualPath: string,
	ocr: boolean,
): { markdown: string; structure: DocumentStructure } {
	const tables: DocumentTable[] = [];
	const title = basename(virtualPath);
	const warnings = list(diagnostics).map((diagnostic) => JSON.stringify(diagnostic));
	let markdown = "";
	let section = "";
	for (const block of list(blocks)) {
		const item = record(block);
		if (item.table === undefined) {
			const text = string(item.text);
			if (item.label === "title" || item.label === "section_header") {
				section = line(text);
				markdown += `## ${section}\n\n`;
			} else markdown += `${text}\n\n`;
			continue;
		}
		const table = record(item.table);
		const data = record(table.data);
		const rowCount = integer(data.num_rows, 1, 20_000);
		const columnCount = integer(data.num_cols, 1, 2_048);
		if (rowCount * columnCount > 200_000) throw new Error("Docling table grid exceeds 200000 cells");
		const grid = Array.from({ length: rowCount }, () => Array<number | undefined>(columnCount).fill(undefined));
		const cells = list(data.table_cells).map((value, index): Cell => {
			const cell = record(value);
			const r0 = integer(cell.start_row_offset_idx, 0, rowCount - 1);
			const r1 = integer(cell.end_row_offset_idx, r0 + 1, rowCount);
			const c0 = integer(cell.start_col_offset_idx, 0, columnCount - 1);
			const c1 = integer(cell.end_col_offset_idx, c0 + 1, columnCount);
			for (let r = r0; r < r1; r++) {
				for (let c = c0; c < c1; c++) {
					if (grid[r][c] !== undefined)
						throw new Error(`Overlapping Docling cells at row ${r + 1}, column ${c + 1}`);
					grid[r][c] = index;
				}
			}
			const role =
				cell.column_header === true
					? "column-header"
					: cell.row_section === true
						? "section"
						: cell.row_header === true
							? "row-header"
							: undefined;
			return { text: string(cell.text), r0, r1, c0, c1, ...(role ? { role } : {}) };
		});
		const present = (r: number) =>
			[...new Set(grid[r])].flatMap((index) => (index === undefined ? [] : [cells[index]]));
		const first = present(0);
		const second = rowCount > 1 ? present(1) : [];
		const known = (row: readonly Cell[]) => {
			const labels = new Set(
				row
					.map((cell) => cell.text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase())
					.filter((label) => RECORD_FIELDS.test(label)),
			);
			return labels.size >= 3 && labels.size / row.length >= 0.75;
		};
		const caption = line(string(table.title));
		const spanningTitle = first.length === 1 && first[0].c1 === columnCount && columnCount > 1 && known(second);
		const tableTitle = caption || (spanningTitle ? line(first[0].text) : "") || section;
		let firstData = spanningTitle ? 1 : 0;
		while (firstData < rowCount - 1) {
			const row = present(firstData);
			if (!row.length || (!row.every((cell) => cell.role === "column-header") && !known(row))) break;
			firstData++;
		}
		const headers = Array.from({ length: columnCount }, (_, column) => {
			const indexes = new Set(grid.slice(spanningTitle ? 1 : 0, firstData).map((row) => row[column]));
			return [...indexes].flatMap((index) =>
				index === undefined || !line(cells[index].text) ? [] : [line(cells[index].text)],
			);
		});
		if (headers.every((header) => !header.length))
			warnings.push(`Table ${tables.length + 1} has no verified column headers`);
		const start = markdown.length;
		if (tableTitle) markdown += `### ${tableTitle}\n\n`;
		const rows: TableRow[] = [];
		let group = "";
		for (let r = firstData; r < rowCount; r++) {
			const sectionCells = present(r);
			if (
				sectionCells.length === 1 &&
				sectionCells[0].role === "section" &&
				sectionCells[0].c0 === 0 &&
				sectionCells[0].c1 === columnCount
			) {
				group = line(sectionCells[0].text);
				if (group) markdown += `#### ${group}\n\n`;
				continue;
			}
			const rowStart = markdown.length;
			const fields: TableField[] = [];
			const seen = new Set<number>();
			for (const [column, cellIndex] of grid[r].entries()) {
				if (cellIndex === undefined || seen.has(cellIndex)) continue;
				seen.add(cellIndex);
				const cell = cells[cellIndex];
				const label = [
					...new Set(
						headers
							.slice(cell.c0, cell.c1)
							.map((path) => path.join(" / "))
							.filter(Boolean),
					),
				].join(" + ");
				const value = line(cell.text);
				if (!value && !label) continue;
				markdown += fields.length ? " | " : group ? `- [${group}] ` : "- ";
				const fieldStart = markdown.length;
				markdown += label ? `${label}: ${value}` : value;
				fields.push({ start: fieldStart, end: markdown.length, column, cell: cellIndex, label });
			}
			if (fields.length) {
				markdown += "\n";
				rows.push({ row: r, start: rowStart, end: markdown.length, fields, ...(group ? { group } : {}) });
			}
		}
		if (rows.length === 0) warnings.push(`Table ${tables.length + 1} has no indexable rows`);
		markdown += "\n";
		const sheet = extname(virtualPath).toLowerCase() === ".xlsx";
		const locations = list(table.prov).map((value): TableLocation => {
			const provenance = record(value);
			const box = record(provenance.bbox);
			const bounds = [box.l, box.t, box.r, box.b];
			if (
				!bounds.every((n): n is number => typeof n === "number" && Number.isFinite(n)) ||
				(box.coord_origin !== "TOPLEFT" && box.coord_origin !== "BOTTOMLEFT")
			)
				throw new Error("Invalid Docling table bounding box");
			return {
				kind: sheet ? "sheet" : "page",
				number: integer(provenance.page_no, 1, Number.MAX_SAFE_INTEGER),
				bounds,
				origin: box.coord_origin,
				unit: sheet ? "cell" : "docling-page",
			};
		});
		tables.push({
			id: `t${tables.length + 1}`,
			title: tableTitle,
			start,
			end: markdown.length,
			rowCount,
			columnCount,
			cells,
			headers,
			rows,
			locations,
		});
	}
	// A file-name match supplies a verified original-page locator even if OCR found no content.
	if (!markdown.trim()) markdown = `# ${line(title)}\n`;
	return {
		markdown,
		structure: {
			version: 1,
			title,
			tables,
			quality: { ocrConfigured: ocr, ...(ocr ? { ocrModel: "PP-OCRv6 multilingual small (ch/en)" } : {}), warnings },
		},
	};
}
