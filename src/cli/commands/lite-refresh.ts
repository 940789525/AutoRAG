import { createAutoRAGLite } from "../../core.ts";
import { ConfigError } from "../config.ts";
import { createIndexProgress } from "../index-progress.ts";
import { renderError } from "../output.ts";
import { parseMethodFlag } from "./refresh.ts";
import type { CommandContext } from "./types.ts";

/**
 * `autorag lite refresh` — model-free index refresh using AutoRAGLite.
 *
 * Delegates to the agent's refresh pipeline (parsed mirrors, local index,
 * datasources, Jikji) without requiring any model configuration.
 *
 * Exit codes: 0 on success, 2 on config error, 1 on runtime error.
 */
export async function runLiteRefresh(ctx: CommandContext): Promise<number> {
	let progress: ReturnType<typeof createIndexProgress> | undefined;
	try {
		const lite = createAutoRAGLite({ flags: { ...ctx.flags, ...(ctx.debug ? { debug: true } : {}) }, cwd: ctx.cwd });
		const methods = parseMethodFlag(ctx.flags.method);
		const force = ctx.flags.force === true || ctx.flags.full === true;
		progress = createIndexProgress(ctx);
		const options = {
			onIndexEvent: progress.onIndexEvent,
			onProgress: progress.onProgress,
			...(methods ? { methods } : {}),
			...(ctx.flags["retry-failed"] === true ? { retrySkipped: true } : {}),
		};
		const result = await lite.refresh(force, options);
		const { renderRefresh } = await import("../output.ts");
		ctx.stdout(renderRefresh(result, { json: ctx.json, debug: ctx.debug }));
		return result.minsync?.ok === false ? 1 : 0;
	} catch (error) {
		ctx.stderr(renderError(error, { json: ctx.json, debug: ctx.debug }));
		return error instanceof ConfigError ? 2 : 1;
	} finally {
		progress?.close();
	}
}
