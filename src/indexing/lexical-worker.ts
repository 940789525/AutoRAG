import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { loadKiwiModelFiles } from "./kiwi-model.ts";

const { KiwiBuilder } = await import("kiwi-nlp");
const builder = await KiwiBuilder.create(fileURLToPath(new URL("./kiwi-wasm.wasm", import.meta.resolve("kiwi-nlp"))));
const kiwi = await builder.build({
	modelType: "cong",
	modelFiles: await loadKiwiModelFiles(workerData.directory, workerData.configured),
});
parentPort?.on("message", ({ id, text }: { id: number; text: string }) => {
	try {
		parentPort?.postMessage({ id, tokens: kiwi.analyze(text).tokens.map((token) => token.str) });
	} catch (error) {
		parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
