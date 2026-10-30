import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileSha256 } from "../../src/filesystem/content-fingerprint.ts";
import { evidenceId } from "../../src/research/reader.ts";
import type { ResearchRuntime } from "../../src/research/runtime.ts";
import type { AssetRevision, ReadingInput, ReadingResult } from "../../src/research/types.ts";
import { note } from "./fixtures.ts";

export function fixtureRuntime(root: string) {
	const inputs: ReadingInput[] = [];
	let screens = 0;
	let block: (() => Promise<void>) | undefined;
	const runtime: ResearchRuntime = {
		async refresh() {},
		async revision(sha256) {
			for (const name of await readdir(root)) {
				if (!name.endsWith(".pdf")) continue;
				const path = join(root, name);
				if ((await fileSha256(path)) === sha256) {
					const text = await readFile(path, "utf8");
					return {
						sha256,
						sourceId: `/papers/${name}`,
						source: path,
						outputSha256: createHash("sha256").update(text).digest("hex"),
					};
				}
			}
			return undefined;
		},
		async verify(asset: AssetRevision) {
			if ((await fileSha256(asset.source)) !== asset.sha256)
				throw new Error(`Fixture revision changed: ${asset.source}`);
		},
		async screen() {
			screens++;
			return true;
		},
		async read(input): Promise<ReadingResult> {
			inputs.push(input);
			await block?.();
			const text = await readFile(input.target.source, "utf8");
			const evidence = [
				{
					...input.target,
					evidenceId: evidenceId(input.target.id, input.target.outputSha256, 0, text.length),
					start: 0,
					end: text.length,
					text,
				},
			];
			return {
				note: note([evidence[0].evidenceId]),
				evidence,
				coverage: { baselineWorks: input.baseline.length, retrievedWorks: 0, excerptCount: 1, partial: true },
			};
		},
	};
	return {
		runtime,
		inputs,
		get screens() {
			return screens;
		},
		setBlock(fn?: () => Promise<void>) {
			block = fn;
		},
	};
}
