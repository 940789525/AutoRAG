import { readFileSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseReadOnlyCredential, readOnlyCodexCredentials } from "./context-session-credentials.ts";

const credential = parseReadOnlyCredential(readFileSync(0, "utf8"));
const model = getModel("openai-codex", "gpt-6.1-sol");
const runtime = await ModelRuntime.create({ credentials: readOnlyCodexCredentials(credential), modelsPath: null });
const response = runtime.streamSimple(
	model,
	{ messages: [{ role: "user", content: "Reply with exactly OK.", timestamp: Date.now() }] },
	{
		reasoning: "low",
		maxTokens: 512,
		transport: "sse",
		signal: AbortSignal.timeout(30000),
	},
);
const result = await response.result();
if (result.stopReason === "error" || result.stopReason === "aborted")
	throw new Error(result.errorMessage ?? "Codex probe failed");
console.log(
	JSON.stringify({
		status: "connected",
		provider: model.provider,
		model: model.id,
		thinking: "low",
		api: model.api,
		stopReason: result.stopReason,
		usage: result.usage,
		text: result.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.slice(0, 64),
	}),
);
