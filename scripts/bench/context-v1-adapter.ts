import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ContextSelectionProjector, type ContextSelectionReport } from "../../src/agent/context-selection-projector.ts";
import type { RetrievalResult } from "../../src/retrieval/types.ts";
import { ContextSelectionProjector as HistoricalProjector } from "./historical/context-selection-projector.ts";

/** Benchmark-only bridge; the recovered v1 algorithm never calls v2 projection or commits a v2 view. */
export class ContextV1Adapter extends ContextSelectionProjector {
	private readonly historical: HistoricalProjector;
	private memoryText = "";
	constructor(report: (report: ContextSelectionReport) => void) {
		super({ mode: "adaptive", evidenceBudgetTokens: 6000 });
		this.historical = new HistoricalProjector({ mode: "adaptive", evidenceBudgetTokens: 6000 }, report);
	}
	override begin(query: string, rerank = false): void {
		this.memoryText = "";
		this.historical.begin(query, rerank);
	}
	override clear(): void {
		this.memoryText = "";
		this.historical.clear();
	}
	override invalidate(_reason: string): void {}
	override setMemoryContext(text: string): void {
		this.memoryText = text;
	}
	override registerResult(id: string, result: RetrievalResult): void {
		this.historical.registerResult(id, result);
	}
	override registerPrompt(prompt: string): string {
		return this.historical.registerPrompt(prompt);
	}
	override registerToolResult(id: string, name: string, content: readonly { type: string; text?: string }[]): void {
		this.historical.registerToolResult(id, name, content);
	}
	override project(messages: AgentMessage[], model?: Model<Api>, overhead = 0, bypass?: string): AgentMessage[] {
		const withMemory: AgentMessage[] = this.memoryText
			? [
					{
						role: "user",
						content: [{ type: "text", text: `<memory_context>\n${this.memoryText}\n</memory_context>` }],
						timestamp: 0,
					},
					...messages,
				]
			: messages;
		return this.historical.project(withMemory, model, overhead, bypass);
	}
	override observePrepared(messages: AgentMessage[]): void {
		this.historical.observePrepared(messages);
	}
	override finalize(messages: AgentMessage[]): AgentMessage[] {
		return messages;
	}
	override dispatch(_messages: readonly AgentMessage[]): void {}
	override settle(_success: boolean): void {}
}
