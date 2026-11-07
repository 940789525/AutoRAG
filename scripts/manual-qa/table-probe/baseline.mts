import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { createDefaultParserRegistry } from "../../../src/parser/defaults.ts";

const root = resolve(process.argv[2]);
const registry = createDefaultParserRegistry({
	languages: ["zh-hans", "en"],
	ocr: { enabled: true, cachePath: resolve(root, "models/tessdata") },
});
for await (const line of createInterface({ input: process.stdin })) {
	let id: string | undefined;
	try {
		const request = JSON.parse(line);
		id = request.id;
		const source = resolve(root, "fixtures", request.file);
		if (request.v !== 1 || !source.startsWith(`${resolve(root, "fixtures")}${sep}`)) {
			throw new Error("invalid fixture request");
		}
		const parsed = await registry.getForVirtualPath(source)?.parse({
			virtualPath: `/${request.file}`,
			sourcePath: source,
			bytes: await readFile(source),
		});
		if (!parsed) throw new Error(`No parser for ${source}`);
		const reply = JSON.stringify({ v: 1, id, ok: true, status: "success", markdown: parsed.markdown, diagnostics: parsed.diagnostics });
		if (Buffer.byteLength(reply) > 4 * 1024 * 1024) throw new Error("baseline output exceeds 4 MiB");
		process.stdout.write(`${reply}\n`);
	} catch (error) {
		console.error(error);
		process.stdout.write(`${JSON.stringify({ v: 1, id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	}
}
