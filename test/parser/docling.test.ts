import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultParserRegistry } from "../../src/parser/defaults.ts";
import { DoclingParser } from "../../src/parser/docling.ts";

afterEach(() => vi.unstubAllEnvs());

it("routes supported files explicitly and preserves compatibility parsers", () => {
	const enabled = createDefaultParserRegistry({ documentBackend: "docling", ocr: { enabled: true } });
	const disabled = createDefaultParserRegistry({ documentBackend: "docling" });
	for (const extension of ["pdf", "docx", "xlsx", "png", "jpg", "jpeg", "webp"])
		expect(enabled.getForVirtualPath(`/file.${extension}`)?.name).toBe("docling");
	expect(disabled.getForVirtualPath("/file.png")).toBeUndefined();
	expect(disabled.getForVirtualPath("/file.pdf")?.version).not.toBe(enabled.getForVirtualPath("/file.pdf")?.version);
	expect(createDefaultParserRegistry().getForVirtualPath("/file.pdf")?.name).toBe("kordoc");
	for (const extension of ["hwp", "hml", "hwpx", "hwpml", "xls"])
		expect(enabled.getForVirtualPath(`/file.${extension}`)?.name).toBe("kordoc");
	expect(enabled.getForVirtualPath("/file.pptx")?.name).toBe("pptx");
	expect(enabled.getForVirtualPath("/file.eml")?.name).toBe("eml");
	expect(() => createDefaultParserRegistry({ documentBackend: "typo" as "docling" })).toThrow("documentBackend");
});

it.skipIf(process.platform === "win32")(
	"reports the child's actual failures, kills timed-out/cancelled workers and retries independently",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-worker-contract-"));
		const launcher = join(root, "python");
		const fixture = join(root, "fake.mjs");
		const receipt = join(root, "pid");
		await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`);
		await chmod(launcher, 0o700);
		await writeFile(
			fixture,
			`
		import { writeFileSync } from "node:fs";
		import { createInterface } from "node:readline";
		for await (const line of createInterface({ input: process.stdin })) {
			const { id, filename } = JSON.parse(line);
			if (filename === "exit.pdf") { console.error("upstream stderr sentinel"); process.exit(23); }
			if (filename === "bad.pdf") { process.stdout.write("garbled\\n"); continue; }
			if (filename === "hang.pdf") { writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); continue; }
			process.stdout.write(JSON.stringify({ id, v: 1, ok: true, blocks: [{ text: "valid" }], diagnostics: [] }) + "\\n");
		}
	`,
		);
		vi.stubEnv("AUTORAG_DOCLING_PYTHON", launcher);
		vi.stubEnv("AUTORAG_DOCLING_MODELS", root);
		const task = new DoclingParser({ ocr: false, languages: ["en"], timeoutMs: 750 }).openTask();
		const input = (name: string) => ({ virtualPath: `/${name}.pdf`, bytes: new Uint8Array([1]) });
		try {
			await expect(task.parse(input("exit"))).rejects.toThrow(/code 23[\s\S]*upstream stderr sentinel/u);
			await expect(task.parse(input("bad"))).rejects.toThrow("SyntaxError");
			await expect(task.parse(input("hang"))).rejects.toThrow("750ms deadline");
			const pid = Number(await readFile(receipt, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
			const signal = new AbortController();
			const parse = task.parse(input("hang"), signal.signal);
			const timer = setTimeout(() => signal.abort(new Error("cancel sentinel")), 80);
			try {
				await expect(parse).rejects.toThrow("cancel sentinel");
			} finally {
				clearTimeout(timer);
			}
			expect((await task.parse(input("ok"))).markdown).toBe("valid\n\n");
		} finally {
			await task.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
