import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Table } from "@lancedb/lancedb";
import { reciprocalRankFusion } from "../datasource/sidecar/fusion.ts";
import { normalizeVirtualPathScope, virtualPathScopeToRegExp } from "../retrieval/scope.ts";
import type { IndexEvidenceChunk, IndexHit, IndexRow, IndexStore } from "./types.ts";

export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function scopePredicate(value?: string): string {
	const scope = normalizeVirtualPathScope(value);
	if (!scope) return "true";
	if (scope.includes("*"))
		return `regexp_like(source_id, ${sqlString(virtualPathScopeToRegExp(scope).source.replaceAll("\\/", "/"))})`;
	if (/\.[^/.]+$/u.test(scope)) return `source_id = ${sqlString(scope)}`;
	return `(source_id = ${sqlString(scope)} OR starts_with(source_id, ${sqlString(`${scope}/`)}))`;
}

/** Every embedding, write, search and maintenance operation is explicit in the caller. */
export class LanceIndexStore implements IndexStore {
	private readonly table: Table;
	private constructor(table: Table) {
		this.table = table;
	}
	close(): void {
		this.table.close();
	}
	/** Opens only an existing table: no schema creation, maintenance, or embedding runtime. */
	static async openExisting(directory: string): Promise<LanceIndexStore> {
		if (!existsSync(join(directory, "chunks.lance")))
			throw new Error(`Local evidence index is missing: ${directory}`);
		const lance = await import("@lancedb/lancedb");
		const db = await lance.connect(directory, { readConsistencyInterval: 0 });
		return new LanceIndexStore(await db.openTable("chunks"));
	}
	async readChunk(sourceId: string, chunkId: string): Promise<IndexEvidenceChunk | undefined> {
		const rows = await this.table
			.query()
			.where(`source_id = ${sqlString(sourceId)} AND id = ${sqlString(chunkId)}`)
			.select(["id", "source_id", "source_path", "text", "heading", "kind", "start", "end", "tokens"])
			.limit(1)
			.toArray();
		return rows[0] as IndexEvidenceChunk | undefined;
	}
	async sourceChunkCount(sourceId: string): Promise<number> {
		return this.table.countRows(`source_id = ${sqlString(sourceId)}`);
	}
	async hasSource(sourceId: string): Promise<boolean> {
		return (
			(
				await this.table
					.query()
					.where(`source_id = ${sqlString(sourceId)}`)
					.select(["id"])
					.limit(1)
					.toArray()
			).length > 0
		);
	}
	static async open(directory: string, dimension: number): Promise<LanceIndexStore> {
		const [lance, arrow] = await Promise.all([import("@lancedb/lancedb"), import("apache-arrow")]);
		const db = await lance.connect(directory, { readConsistencyInterval: 0 });
		let table: Table;
		try {
			table = await db.openTable("chunks");
		} catch (error) {
			if ((await db.tableNames()).includes("chunks")) throw error;
			const fields: import("apache-arrow").Field[] = [
				"id",
				"source_id",
				"source_path",
				"text",
				"embedding_text",
				"embedding_key",
				"lexical_text",
				"heading",
				"kind",
			].map((name) => new arrow.Field(name, new arrow.Utf8(), false));
			fields.push(...["start", "end", "tokens"].map((name) => new arrow.Field(name, new arrow.Int32(), false)));
			fields.push(
				new arrow.Field(
					"vector",
					new arrow.FixedSizeList(dimension, new arrow.Field("item", new arrow.Float32(), false)),
					false,
				),
			);
			table = await db.createEmptyTable("chunks", new arrow.Schema(fields));
		}
		return new LanceIndexStore(table);
	}
	async countRows(): Promise<number> {
		return this.table.countRows();
	}
	async sampleRow(): Promise<IndexRow | undefined> {
		const [row] = await this.table.query().limit(1).toArray();
		return row ? decodeRow(row) : undefined;
	}
	async findVectors(keys: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
		const vectors = new Map<string, readonly number[]>();
		for (let offset = 0; offset < keys.length; offset += 256) {
			const batch = keys.slice(offset, offset + 256);
			const rows = await this.table
				.query()
				.where(`embedding_key IN (${batch.map(sqlString).join(",")})`)
				.select(["embedding_key", "vector"])
				.toArray();
			for (const row of rows) vectors.set(String(row.embedding_key), Array.from(row.vector));
		}
		return vectors;
	}
	async replace(sourceIds: readonly string[], rows: readonly IndexRow[]): Promise<void> {
		if (sourceIds.length === 0) return;
		const predicate = `source_id IN (${sourceIds.map(sqlString).join(",")})`;
		if (rows.length === 0) {
			await this.table.delete(predicate);
			return;
		}
		await this.table
			.mergeInsert("id")
			.whenMatchedUpdateAll()
			.whenNotMatchedInsertAll()
			.whenNotMatchedBySourceDelete({ where: predicate })
			.execute([...rows]);
	}
	async search(options: Parameters<IndexStore["search"]>[0]): Promise<readonly IndexHit[]> {
		if (options.sourceIds?.length === 0) return [];
		if ((await this.table.countRows()) === 0) return [];
		const where = `(${scopePredicate(options.scope)})${options.sourceIds === undefined ? "" : ` AND source_id IN (${options.sourceIds.map(sqlString).join(",")})`}`;
		const pool = Math.max(1, options.topK);
		const rankings: IndexHit[][] = [];
		if (options.vector) {
			const result = await this.table
				.vectorSearch([...options.vector])
				.where(where)
				.distanceType("cosine")
				.nprobes(32)
				.ef(Math.max(100, pool * 4))
				.refineFactor(4)
				.limit(pool)
				.toArray();
			rankings.push(
				result.map((row) => ({
					row: decodeRow(row),
					score: 1 - Number(row._distance),
					cosine: 1 - Number(row._distance),
				})),
			);
		}
		if (options.mode !== "vector" && options.text.trim()) {
			// The field contains analyzed tokens, not source-position-preserving phrases.
			const { MatchQuery } = await import("@lancedb/lancedb");
			const terms = [...new Set(options.text.split(/\s+/u).filter(Boolean))];
			const query = new MatchQuery(terms.join(" "), "lexical_text");
			const result = await this.table.query().fullTextSearch(query).where(where).limit(pool).toArray();
			rankings.push(result.map((row) => ({ row: decodeRow(row), score: Number(row._score) })));
		}
		if (rankings.length < 2) return rankings[0] ?? [];
		const byId = new Map(rankings.flat().map((hit) => [hit.row.id, hit.row]));
		const cosines = new Map(
			rankings
				.flat()
				.filter((hit) => hit.cosine !== undefined)
				.map((hit) => [hit.row.id, hit.cosine]),
		);
		return reciprocalRankFusion(rankings.map((hits) => hits.map((hit) => hit.row.id)))
			.slice(0, pool)
			.map((hit) => ({ row: byId.get(hit.key)!, score: hit.score, cosine: cosines.get(hit.key) }));
	}
	async maintain(): Promise<void> {
		if ((await this.table.countRows()) === 0) return;
		const { Index } = await import("@lancedb/lancedb");
		const indices = await this.table.listIndices();
		const indexed = (column: string) => indices.some((index) => index.columns.includes(column));
		for (const column of ["id", "source_id", "embedding_key"]) {
			if (!indexed(column)) await this.table.createIndex(column, { config: Index.btree() });
		}
		if (!indexed("lexical_text"))
			await this.table.createIndex("lexical_text", {
				config: Index.fts({
					baseTokenizer: "whitespace",
					stem: false,
					removeStopWords: false,
					asciiFolding: false,
					maxTokenLength: 256,
				}),
			});
		if (!indexed("vector") && (await this.table.countRows()) >= 10_000) {
			await this.table.createIndex("vector", { config: Index.hnswSq({ distanceType: "cosine" }) });
		}
		// One end-of-run maintenance, never a compact/reindex for every source file.
		await this.table.optimize({ cleanupOlderThan: new Date(Date.now() - 24 * 60 * 60 * 1000) });
	}
}

function decodeRow(value: Record<string, unknown>): IndexRow {
	return { ...value, vector: Array.from(value.vector as Iterable<number>) } as IndexRow;
}
