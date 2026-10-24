import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const KIWI_MODEL_VERSION = "0.24.1";
export const KIWI_MODEL_SHA256 = "50d163e1af817444ef21f7ec5ea07ef69fb347282d57a6b49260f2039d4dc346";
export const KIWI_MODEL_FILES = [
	"combiningRule.txt",
	"default.dict",
	"extract.mdl",
	"multi.dict",
	"cong.mdl",
	"dialect.dict",
	"nounchr.mdl",
	"sj.morph",
	"typo.dict",
] as const;

/** Only known leaf names are extracted; archive paths, links and executable entries are never used. */
export function extractKiwiModelFiles(archive: Uint8Array): Map<string, Uint8Array> {
	const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
	const files = new Map<string, Uint8Array>();
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
		const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(), 8);
		if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
			throw new Error("invalid Kiwi model archive length");
		const leaf = basename(name);
		if ((header[156] === 0 || header[156] === 48) && KIWI_MODEL_FILES.some((file) => file === leaf)) {
			files.set(leaf, new Uint8Array(tar.subarray(offset + 512, offset + 512 + size)));
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	for (const name of KIWI_MODEL_FILES) if (!files.has(name)) throw new Error(`Kiwi model archive is missing ${name}`);
	return files;
}

export async function loadKiwiModelFiles(directory: string, configured?: string): Promise<Record<string, Uint8Array>> {
	if (configured)
		return Object.fromEntries(
			KIWI_MODEL_FILES.map((name) => [name, new Uint8Array(readFileSync(join(configured, name)))]),
		);
	const modelRoot = join(directory, `kiwi-${KIWI_MODEL_VERSION}`);
	const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
	if (existsSync(join(modelRoot, "complete.json"))) {
		const checksums = JSON.parse(readFileSync(join(modelRoot, "complete.json"), "utf8")) as Record<string, string>;
		return Object.fromEntries(
			KIWI_MODEL_FILES.map((name) => {
				const data = new Uint8Array(readFileSync(join(modelRoot, name)));
				if (checksums[name] !== digest(data)) throw new Error(`cached Kiwi model checksum mismatch: ${name}`);
				return [name, data];
			}),
		);
	}
	const url = `https://github.com/bab2min/Kiwi/releases/download/v${KIWI_MODEL_VERSION}/kiwi_model_v${KIWI_MODEL_VERSION}_base.tgz`;
	const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Kiwi model download ${url}: HTTP ${response.status}: ${await response.text()}`);
	if (!response.body) throw new Error("Kiwi model response has no body");
	const pieces: Uint8Array[] = [];
	let size = 0;
	for await (const piece of response.body) {
		size += piece.length;
		if (size > 100 * 1024 * 1024) throw new Error("Kiwi model download exceeds 100 MiB");
		pieces.push(piece);
	}
	const archive = Buffer.concat(pieces, size);
	if (digest(archive) !== KIWI_MODEL_SHA256) throw new Error("Kiwi model sha256 mismatch");
	const files = extractKiwiModelFiles(archive);
	mkdirSync(modelRoot, { recursive: true });
	const checksums: Record<string, string> = {};
	for (const [name, data] of files) {
		const temporary = join(modelRoot, `${name}.${randomUUID()}.tmp`);
		writeFileSync(temporary, data);
		renameSync(temporary, join(modelRoot, name));
		checksums[name] = digest(data);
	}
	const marker = join(modelRoot, `complete.${randomUUID()}.tmp`);
	writeFileSync(marker, JSON.stringify(checksums));
	renameSync(marker, join(modelRoot, "complete.json"));
	return Object.fromEntries(files);
}
