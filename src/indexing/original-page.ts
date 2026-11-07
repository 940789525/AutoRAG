import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname } from "node:path";
import type { LocalReadHandle } from "./evidence.ts";

export async function renderOriginalPage(handle: LocalReadHandle, number: number, signal?: AbortSignal) {
	const bytes = await readFile(handle.source, { signal });
	if (createHash("sha256").update(bytes).digest("hex") !== handle.sourceSha256)
		throw new Error("Original source changed before rendering");
	const module = "pdfjs-dist/legacy/build/pdf.mjs";
	// Use the optional native canvas PDF.js already resolves for Node.
	const { createCanvas, loadImage } = createRequire(import.meta.resolve(module))(
		"@napi-rs/canvas",
	) as typeof import("@napi-rs/canvas");
	const extension = extname(handle.source).toLowerCase();
	const scale = (width: number, height: number) => Math.min(2400 / Math.max(width, height), 3);
	let canvas: import("@napi-rs/canvas").Canvas;
	let total = 1;
	if (extension === ".pdf") {
		const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = getDocument({
			data: Uint8Array.from(bytes),
			useSystemFonts: true,
			maxImageSize: 64_000_000,
		});
		const cancel = () => {
			void task.destroy().catch(() => {});
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			signal?.throwIfAborted();
			const pdf = await task.promise;
			total = pdf.numPages;
			if (number > total) throw new Error("Original page is outside the verified document");
			const page = await pdf.getPage(number);
			const size = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: scale(size.width, size.height) });
			canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
			await page.render({
				canvas: null,
				canvasContext: canvas.getContext("2d") as unknown as Parameters<typeof page.render>[0]["canvasContext"],
				viewport,
			}).promise;
		} finally {
			signal?.removeEventListener("abort", cancel);
			await task.destroy();
		}
	} else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension) && number === 1) {
		const picture = await loadImage(bytes);
		const ratio = Math.min(1, scale(picture.width, picture.height));
		canvas = createCanvas(Math.ceil(picture.width * ratio), Math.ceil(picture.height * ratio));
		canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
	} else throw new Error("Original-page rendering supports PDF, PNG, JPEG and WebP");
	signal?.throwIfAborted();
	let image = await canvas.encode("jpeg", 87);
	if (image.length > 2 * 1024 * 1024) image = await canvas.encode("jpeg", 68);
	if (image.length > 2 * 1024 * 1024) throw new Error("Original page exceeds the 2 MiB image budget");
	return { image: { type: "image" as const, mimeType: "image/jpeg", data: image.toString("base64") }, total };
}
