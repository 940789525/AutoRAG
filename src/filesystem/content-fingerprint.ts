import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";

/** Hash through one descriptor; reject a changing file or a retargeted path. Memory stays bounded. */
export async function fileSha256(path: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const canonical = await realpath(path);
	const file = await open(canonical, "r");
	try {
		const before = await file.stat();
		if (!before.isFile()) throw new Error(`Evidence source is not a regular file: ${path}`);
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(64 * 1024);
		while (true) {
			signal?.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		const after = await file.stat();
		const current = await stat(path);
		if (
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			after.ino !== current.ino ||
			after.dev !== current.dev ||
			after.size !== current.size ||
			after.mtimeMs !== current.mtimeMs ||
			after.ctimeMs !== current.ctimeMs ||
			(await realpath(path)) !== canonical
		)
			throw new Error(`Evidence source changed while reading: ${path}`);
		signal?.throwIfAborted();
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}
