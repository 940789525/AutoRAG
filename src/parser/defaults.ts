import { join } from "node:path";
import { DEFAULT_LANGUAGES, type LanguageTag } from "../language.ts";
import { DOCLING_DOCUMENT_EXTENSIONS, DoclingParser } from "./docling.ts";
import { EmlParser } from "./eml.ts";
import { KORDOC_EXTENSIONS, KordocParser, type KordocParserOptions } from "./kordoc.ts";
import { BUILTIN_OCR_LANGUAGES, createTesseractOcrProvider, type OcrOptions } from "./ocr-engines.ts";
import { PptxParser } from "./office.ts";
import { PlainTextParser } from "./plain-text.ts";
import { ParserRegistry } from "./registry.ts";

export type DocumentBackend = "kordoc" | "docling";

export interface DefaultParserRegistryOptions {
	readonly documentBackend?: DocumentBackend;
	readonly ocr?: OcrOptions;
	readonly kordoc?: KordocParserOptions;
	/** Global document languages; selects the OCR engine when OCR is enabled. */
	readonly languages?: readonly LanguageTag[];
	/**
	 * Hard per-file parse deadline in milliseconds (default 120000). kordoc, pptx and eml parse in a worker
	 * thread during a refresh; a parse still running at the deadline has its worker terminated and the file
	 * is skipped as `parser-failed`. A synchronous spin cannot be interrupted any other way.
	 */
	readonly fileTimeoutMs?: number;
	/** V8 old-generation heap limit in MB for the parse worker. An out-of-memory parse becomes a `parser-failed` skip. */
	readonly maxHeapMb?: number;
}

/** Workspace-relative directory for Tesseract traineddata, so models never land in the process working directory. */
export function tesseractCachePathFor(workspacePath: string): string {
	return join(workspacePath, ".autorag", "models", "tessdata");
}

/**
 * Merges the globally configured document languages into registry options.
 * An explicit `parserOptions.languages` wins over the global setting. When a
 * workspace is known, Tesseract's model cache is pinned under it unless the
 * caller set `ocr.cachePath`.
 */
export function resolveParserOptions(
	parserOptions: DefaultParserRegistryOptions | undefined,
	languages: readonly LanguageTag[],
	workspacePath?: string,
): DefaultParserRegistryOptions {
	const resolved = { ...parserOptions, languages: parserOptions?.languages ?? languages };
	documentBackend(resolved);
	if (workspacePath === undefined || parserOptions?.ocr === undefined || parserOptions.ocr.cachePath !== undefined) {
		return resolved;
	}
	return { ...resolved, ocr: { ...parserOptions.ocr, cachePath: tesseractCachePathFor(workspacePath) } };
}

export function documentBackend(options?: DefaultParserRegistryOptions): DocumentBackend {
	const backend = options?.documentBackend;
	if (backend === undefined) return "kordoc";
	if (backend !== "docling" && backend !== "kordoc")
		throw new Error(`parserOptions.documentBackend must be kordoc or docling, received ${String(backend)}`);
	return backend;
}

/**
 * `ocr.enabled` is the single opt-in. Off: image files are not parsed and
 * scanned pages are left unrecognized; kordoc gets an explicit `ocr: false`,
 * because omitting it lets kordoc auto-OCR whenever its built-in model is
 * already cached. On: kordoc owns both, and the configured languages pick the
 * engine. kordoc's built-in PP-OCRv5 model is used only when every language is
 * one it reads reliably; otherwise Tesseract is injected as kordoc's OCR
 * provider. An explicit `kordoc.ocr` always wins.
 */
export function createDefaultParserRegistry(options: DefaultParserRegistryOptions = {}): ParserRegistry {
	const languages = options.languages ?? DEFAULT_LANGUAGES;
	const ocrEnabled = options.ocr?.enabled === true;
	const docling = documentBackend(options) === "docling";
	const builtinCovers = languages.every((language) => BUILTIN_OCR_LANGUAGES.has(language));
	const kordocOptions: KordocParserOptions = {
		...options.kordoc,
		images: ocrEnabled,
		...(options.kordoc?.ocr === undefined
			? {
					ocr: !ocrEnabled
						? false
						: builtinCovers
							? true
							: createTesseractOcrProvider({
									languages,
									timeoutMs: options.ocr?.timeoutMs,
									cachePath: options.ocr?.cachePath,
								}),
				}
			: {}),
	};

	return new ParserRegistry([
		new PlainTextParser(),
		new KordocParser(
			kordocOptions,
			docling
				? KORDOC_EXTENSIONS.filter(
						(extension) => !(DOCLING_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension),
					)
				: undefined,
		),
		...(docling
			? [new DoclingParser({ ocr: ocrEnabled, languages, timeoutMs: options.fileTimeoutMs ?? 120_000 })]
			: []),
		new PptxParser(),
		new EmlParser(),
	]);
}
