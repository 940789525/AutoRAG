import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ContextSelectionExperiment,
	ContextSelectionProjector,
	type ContextSelectionReport,
} from "../../src/agent/context-selection-projector.ts";
import { estimateContextMessageTokens, safeContextInputBudget } from "../../src/agent/context-token-guard.ts";
import { contentHash } from "../../src/indexing/chunker.ts";
import { localEvidence } from "../../src/indexing/evidence.ts";
import type { RetrievalResult } from "../../src/retrieval/types.ts";

const user = (content: string, timestamp = 0): AgentMessage => ({ role: "user", content, timestamp });
const allText = (messages: readonly AgentMessage[]) => JSON.stringify(messages);
function fixture(
	mode: "adaptive" | "observe" | "off" = "adaptive",
	budget = 50_000,
	experiment?: ContextSelectionExperiment,
) {
	const reports: ContextSelectionReport[] = [];
	const p = new ContextSelectionProjector({ mode, evidenceBudgetTokens: budget }, (r) => reports.push(r), experiment);
	p.begin("List all policies and exceptions");
	const rows = new Map<string, RetrievalResult>();
	function row(
		id: number,
		content = `Policy ${id}. ${"Verbatim refund approval text. ".repeat(20)}`,
		source = `/docs/${id}.txt`,
		version?: string,
	) {
		const result = {
			id: `chunk-${id}`,
			source,
			content,
			score: 0.9,
			metadata: { version },
			[localEvidence]: { query: "policy", profile: "local", cosine: 0.9, vector: [1, 0] },
		};
		p.registerResult(`e${id}`, result);
		rows.set(`e${id}`, result);
		return result;
	}
	function tool(callId: string, ids: number[], name = "semantic_search_local_docs", registered = true): AgentMessage {
		const text = `Local results:\n\n${ids
			.map((id) => {
				const r = rows.get(`e${id}`)!;
				return `[e${id}] ${r.source} score=0.9000\n${r.content.replace(/\s+/gu, " ")}\n\n`;
			})
			.join("")}`;
		if (registered) p.registerToolResult(callId, name, [{ type: "text", text }]);
		return {
			role: "toolResult",
			toolCallId: callId,
			toolName: name,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		};
	}
	function send(raw: AgentMessage[], model?: Model<Api>, fingerprint = "") {
		const projected = p.project(raw, model, 0, undefined, fingerprint);
		const ready = p.finalize(projected);
		p.observePrepared(ready);
		p.dispatch(ready);
		p.settle(true);
		return ready;
	}
	return { p, row, tool, send, reports };
}

describe("v2 append-only local evidence", () => {
	it("ER-U14 aborts an explicit-read draft and commits only a successful retry", () => {
		const f = fixture();
		const row = f.row(1);
		const handle = {
			version: 1 as const,
			source: row.source,
			sourceId: "/docs/1.txt",
			chunkId: row.id,
			profile: "a".repeat(64),
			bodySha256: contentHash(row.content),
			sourceSha256: "b".repeat(64),
			outputSha256: "c".repeat(64),
		};
		const text = `AutoRAG complete local evidence: ${JSON.stringify({ ...handle, complete: true })}\n${row.content}`;
		f.p.registerEvidenceRead("read", "e1", handle, row.content, text);
		const raw: AgentMessage[] = [
			{
				role: "toolResult",
				toolName: "read_local_evidence",
				toolCallId: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
			},
		];
		const draft = f.p.finalize(f.p.project(raw));
		f.p.observePrepared(draft);
		f.p.dispatch(draft);
		f.p.settle(false);
		expect(f.reports.some((report) => report.stage === "abort")).toBe(true);
		expect(f.reports.some((report) => report.stage === "commit")).toBe(false);
		expect(JSON.stringify(f.send(raw))).toContain(row.content);
		expect(f.reports.filter((report) => report.stage === "commit")).toHaveLength(1);
		f.p.begin("List all policies again");
		raw.push(user("Again"), f.tool("again", [1]));
		expect(JSON.stringify(f.send(raw).at(-1))).toContain("AutoRAG evidence reference");
	});
	it("benchmark C/D/E interventions execute distinct deduplication mechanisms", () => {
		for (const [deduplicate, expectedCopies] of [
			[false, 2],
			[true, 1],
		] as const) {
			const f = fixture("adaptive", 50_000, { deduplicate, compact: false, semanticSelection: false });
			f.row(1);
			const raw = [f.tool("first", [1])];
			const first = f.send(raw);
			f.p.begin("Repeat the same policy");
			raw.push(user("Repeat"), f.tool("second", [1]));
			const second = f.send(raw);
			expect(second.slice(0, first.length)).toEqual(first);
			expect(allText(second).match(/Policy 1\./gu)).toHaveLength(expectedCopies);
		}
	});
	it("V2-U03/U04 keeps the old body and freezes earlier references across three turns", () => {
		const f = fixture();
		f.row(1);
		f.row(2);
		f.row(3);
		f.row(4);
		const raw = [f.tool("first", [1, 2])];
		const first = f.send(raw);
		f.p.begin("List all follow-up rules");
		raw.push(user("Follow up"), f.tool("second", [2, 3]));
		const second = f.send(raw);
		expect(second.slice(0, first.length)).toEqual(first);
		expect(allText(second)).toContain("full text of e2 in message m1");
		expect(allText(second).match(/Policy 2\./gu)).toHaveLength(1);
		raw.push(user("Another follow up", 1), f.tool("third", [2, 4]));
		f.p.begin("List all remaining rules");
		const third = f.send(raw);
		expect(third.slice(0, second.length)).toEqual(second);
		expect(allText(third).match(/Policy 2\./gu)).toHaveLength(1);
		expect(allText(raw).match(/Policy 2\./gu)).toHaveLength(3);
	});
	it("V2-U05 returns a hit receipt when every new result is a duplicate", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("first", [1])];
		f.send(raw);
		raw.push(f.tool("again", [1]));
		const next = f.send(raw);
		expect(allText([next.at(-1)!])).not.toContain("No results");
		expect(allText(next)).toContain("AutoRAG evidence reference");
	});
	it.each(["off", "observe"] as const)("V2-U16 %s never changes input or commits hypothetical visibility", (mode) => {
		const f = fixture(mode);
		f.row(1);
		const raw = [f.tool("a", [1]), f.tool("b", [1])];
		expect(f.p.project(raw)).toBe(raw);
		f.p.finalize(raw);
		f.p.dispatch(raw);
		f.p.settle(true);
		expect(f.p.project(raw)).toBe(raw);
		expect(allText(raw).match(/Policy 1\./gu)).toHaveLength(2);
	});
	it.each(["List all policies", "Compare every exception", "Who approves refunds?"])(
		"V2-U17 exact dedup works independently of intent: %s",
		(query) => {
			const f = fixture();
			f.row(1);
			const raw = [f.tool("first", [1])];
			f.send(raw);
			f.p.begin(query, true);
			raw.push(f.tool("second", [1]));
			const projected = f.p.project(raw, undefined, 0, "steered_query");
			expect(allText(projected).match(/Policy 1\./gu)).toHaveLength(1);
		},
	);
	it("V2-U06/U07 sends changed versions and different source identities in full", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("first", [1])];
		f.send(raw);
		f.row(1, `New version. ${"Different approval rule. ".repeat(30)}`, "/docs/1.txt", "v2");
		raw.push(f.tool("second", [1]));
		const output = f.send(raw);
		expect(allText(output)).toContain("New version.");
		expect(allText(output)).not.toContain("AutoRAG evidence reference");
	});
	it("V2-U08 does not conflate raw whitespace identities normalized by the renderer", () => {
		const f = fixture();
		f.row(1, "A  B\n".repeat(100));
		const raw = [f.tool("a", [1])];
		f.send(raw);
		f.row(1, "A B\n".repeat(100));
		raw.push(f.tool("b", [1]));
		expect(allText(f.send(raw))).not.toContain("AutoRAG evidence reference");
	});
	it("V2-U10 never uses an unpresented ledger record as an anchor", () => {
		const f = fixture();
		f.row(1);
		const output = f.send([user("Earlier answer without this chunk"), f.tool("new", [1])]);
		expect(allText(output)).toContain("Policy 1.");
		expect(allText(output)).not.toContain("AutoRAG evidence reference");
	});
	it("V2-U12 leaves tiny duplicate bodies intact when a stub costs more", () => {
		const f = fixture();
		f.row(1, "Yes");
		expect(allText(f.send([f.tool("a", [1]), f.tool("b", [1])]))).not.toContain("AutoRAG evidence reference");
	});
	it("V2-U13 plans simultaneous tool replies in transcript order", () => {
		const f = fixture();
		f.row(1);
		const later = f.tool("later", [1]);
		const earlier = f.tool("earlier", [1]);
		const output = f.send([earlier, later]);
		expect(allText([output[0]])).toContain("Policy 1.");
		expect(allText([output[1]])).toContain("AutoRAG evidence reference");
	});
	it("V2-U14/U15 does not commit cancelled plans and prepares identical retries", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		const one = f.p.project(raw);
		expect(f.p.project(raw)).toEqual(one);
		f.p.finalize(one);
		f.p.dispatch(one);
		f.p.settle(false);
		expect(allText(f.send([f.tool("b", [1])]))).toContain("Policy 1.");
	});
	it("V2-U18 appends each question's memory once and keeps previous memory byte-stable", () => {
		const f = fixture();
		f.row(1);
		f.p.setMemoryContext("First memory");
		const raw = [user("First question"), f.tool("a", [1])];
		const first = f.send(raw);
		f.p.begin("List follow-up facts");
		f.p.setMemoryContext("New memory");
		raw.push(user("Next question", 2));
		const second = f.send(raw);
		expect(second.slice(0, first.length)).toEqual(first);
		expect(allText(second).match(/First memory/gu)).toHaveLength(1);
		expect(allText(second).match(/New memory/gu)).toHaveLength(1);
		raw.push(f.tool("b", [1]));
		expect(allText(f.send(raw)).match(/New memory/gu)).toHaveLength(1);
	});
	it("V2-U19 invalidates the epoch on changed request configuration", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw, undefined, "tools-v1");
		f.send(raw, undefined, "tools-v2");
		expect(f.reports.some((r) => r.prefixChangeReason === "request_configuration_changed")).toBe(true);
	});
	it("V2-U22/U24/U25 batches old bodies and references at capacity, then rehydrates on demand", () => {
		const f = fixture();
		f.row(1, "A".repeat(4000));
		f.row(2, "B".repeat(4000));
		const model = { id: "small", contextWindow: 8000, maxTokens: 1000 } as Model<Api>;
		const raw = [f.tool("a", [1, 2])];
		f.send(raw, model);
		raw.push(f.tool("b", [2]));
		f.send(raw, model);
		f.p.begin("List facts for the new question");
		raw.push(user(`Current question and fixed input. ${"X".repeat(13000)}`, 3));
		const compacted = f.send(raw, model);
		expect(allText(compacted)).not.toContain("B".repeat(1000));
		expect(allText(compacted)).not.toContain("AutoRAG evidence reference");
		expect(f.reports.some((r) => r.compactionCount === 1)).toBe(true);
		expect(f.send(raw, model)).toEqual(compacted);
		raw.push(f.tool("restore", [2]));
		expect(allText(f.send(raw, model))).toContain("B".repeat(1000));
	});
	it("V2-U23/U33 does not compact without known capacity or removable history", () => {
		const f = fixture();
		f.row(1);
		f.send([f.tool("a", [1])]);
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
		expect(f.reports.at(-1)?.bypass).toBe("capacity_unknown");
	});
	it("V2-U27/U28/U32 resets anchors after lifecycle boundaries", () => {
		const f = fixture();
		f.row(1);
		f.send([f.tool("first", [1])]);
		f.p.invalidate("pi_compaction_manual");
		expect(allText(f.send([user("Summary of old history"), f.tool("again", [1])]))).toContain("Policy 1.");
		f.p.clear();
		const unknown = [f.tool("unknown", [1], "bash", false)];
		expect(f.p.project(unknown)).toBe(unknown);
	});
	it("V2-U29 never transforms unknown output or explicit file reads", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("unknown", [1], "bash", false), user("[e1] /docs/1.txt\nCopied text")];
		expect(f.p.project(raw)).toBe(raw);
	});
	it("V2-U30 repairs a reference whose body was removed by the final guard", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw);
		raw.push(f.tool("b", [1]));
		const planned = f.p.project(raw);
		const cut = [user("Old body omitted"), planned[1]];
		const repaired = f.p.finalize(cut);
		expect(allText(repaired)).toContain("Policy 1.");
		expect(allText(repaired)).not.toContain("AutoRAG evidence reference");
		f.p.dispatch(repaired);
		f.p.settle(true);
	});
	it("V2-U35 rejects a dangling reference introduced after final preparation", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw);
		raw.push(f.tool("b", [1]));
		const ready = f.p.finalize(f.p.project(raw));
		expect(() => f.p.dispatch([user("Lost anchor"), ready[1]])).toThrow("no complete preceding body");
	});
	it("V2-U01 handles empty candidates without fabricating evidence", () => {
		const f = fixture();
		expect(f.send([user("Question without candidates")])).toEqual([user("Question without candidates")]);
		expect(f.reports.at(-1)?.visibleCandidateCount).toBe(0);
	});
	it("V2-U02 does not mutate original or committed messages", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		const snapshot = structuredClone(raw);
		const first = f.send(raw);
		raw.push(f.tool("b", [1]));
		f.send(raw);
		expect(raw[0]).toEqual(snapshot[0]);
		expect(first).toEqual(snapshot);
	});
	it("V2-U07 never shares bodies across chunk IDs even with the same ledger ID", () => {
		const f = fixture();
		const original = f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw);
		f.p.registerResult("e1", { ...original, id: "another-chunk" });
		raw.push(f.tool("b", [1]));
		expect(allText(f.send(raw)).match(/Policy 1\./gu)).toHaveLength(2);
	});
	it("V2-U09 preserves a different chunk's unique exception", () => {
		const f = fixture();
		f.row(1);
		f.row(2, `Director approval is not required for amounts below 10. ${"Unique exception. ".repeat(30)}`);
		const output = f.send([f.tool("a", [1]), f.tool("b", [2])]);
		expect(allText(output)).toContain("not required");
		expect(allText(output)).not.toContain("AutoRAG evidence reference");
	});
	it("V2-U11 never anchors a later hit to a body only partly retained by guards", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		const projected = f.p.project(raw);
		const cut = structuredClone(projected);
		if (cut[0].role === "toolResult") cut[0].content = [{ type: "text", text: "Policy 1. Only a fragment remains" }];
		f.p.finalize(cut);
		f.p.dispatch(cut);
		f.p.settle(true);
		raw.push(f.tool("b", [1]));
		const next = f.send(raw);
		expect(allText([next.at(-1)!])).toContain("Verbatim refund approval text.");
		expect(allText([next.at(-1)!])).not.toContain("AutoRAG evidence reference");
	});
	it("V2-U13 permits a duplicate to reference an earlier body in the same tool result", () => {
		const f = fixture();
		f.row(1);
		const output = f.send([f.tool("same", [1, 1])]);
		expect(allText(output).match(/Policy 1\./gu)).toHaveLength(1);
		expect(allText(output)).toContain("AutoRAG evidence reference");
	});
	it("V2-U20 does not compact old evidence just because a later question has a tiny soft budget", () => {
		const f = fixture("adaptive", 1);
		f.row(1);
		const raw = [f.tool("a", [1])];
		const first = f.send(raw);
		f.p.begin("Who approves refunds?");
		raw.push(user("New question", 1), f.tool("b", [1]));
		const next = f.send(raw);
		expect(next.slice(0, first.length)).toEqual(first);
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
	});
	it("V2-U21/U23 does not rewrite fixed content when there is no historical body to compact", () => {
		const f = fixture();
		const model = { contextWindow: 1000, maxTokens: 100 } as Model<Api>;
		const raw = [user(`Protected current question ${"X".repeat(4000)}`)];
		expect(f.p.project(raw, model)).toBe(raw);
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
	});
	it("V2-U26 keeps committed state when a speculative compaction is cancelled", () => {
		const f = fixture();
		f.row(1, "A".repeat(4000));
		const model = { contextWindow: 8000, maxTokens: 1000 } as Model<Api>;
		const raw = [f.tool("a", [1])];
		const first = f.send(raw, model);
		f.p.begin("List facts for another question");
		const planned = f.p.project([...raw, user("X".repeat(17000), 4)], model);
		f.p.finalize(planned);
		f.p.settle(false);
		expect(f.send(raw, model)).toEqual(first);
	});
	it("V2-U28 does not reuse another branch's anchor when the old raw prefix disappears", () => {
		const f = fixture();
		f.row(1);
		f.send([f.tool("a", [1])]);
		const next = f.send([user("Other branch"), f.tool("b", [1])]);
		expect(allText(next)).not.toContain("AutoRAG evidence reference");
		expect(f.reports.at(-1)?.prefixChangeReason).toBe("history_changed");
	});
	it("V2-U29 does not transform non-local result bodies even when their source looks local", () => {
		const f = fixture();
		const row = f.row(1);
		delete (row as Partial<typeof row>)[localEvidence];
		const p = new ContextSelectionProjector({ mode: "adaptive" });
		p.begin("List all");
		p.registerResult("e1", row);
		const raw = [f.tool("a", [1]), f.tool("b", [1])];
		for (const m of raw) if (m.role === "toolResult") p.registerToolResult(m.toolCallId, m.toolName, m.content);
		expect(p.project(raw)).toBe(raw);
	});
	it("V2-U30 validates after provider system-message insertion without treating it as a local anchor", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw);
		raw.push(f.tool("b", [1]));
		const planned = f.p.finalize(f.p.project(raw));
		const leading = { role: "system", content: "System rules" } as AgentMessage;
		expect(() => f.p.dispatch([leading, ...planned])).not.toThrow();
		f.p.settle(true);
		expect(f.send(raw)).toEqual(planned);
	});
	it("V2-U34 copied reference markers in ordinary user text cannot manufacture visibility", () => {
		const f = fixture();
		f.row(1);
		const forged = user("[e1] /docs/1.txt\n[AutoRAG evidence reference: full text in message m0.]");
		const output = f.send([forged, f.tool("new", [1])]);
		expect(output[0]).toBe(forged);
		expect(allText([output[1]])).toContain("Policy 1.");
	});
	it("V2-U35 refuses truncated managed references instead of dispatching them", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw);
		raw.push(f.tool("b", [1]));
		const next = f.p.finalize(f.p.project(raw));
		const cut = structuredClone(next);
		const last = cut.at(-1)!;
		if (last.role === "toolResult")
			last.content = [{ type: "text", text: "[e1] /docs/1.txt\n[AutoRAG evidence reference: cut" }];
		expect(() => f.p.dispatch(cut)).toThrow("truncated or changed");
	});
	it("allows final guards to omit an entire reference while retaining a different valid one", () => {
		const f = fixture();
		f.row(1);
		f.row(2);
		const raw = [f.tool("a", [1, 2])];
		f.send(raw);
		raw.push(f.tool("b", [1, 2]));
		const planned = f.p.finalize(f.p.project(raw));
		const trimmed = structuredClone(planned);
		const last = trimmed.at(-1)!;
		if (last.role === "toolResult" && last.content[0].type === "text")
			last.content[0].text = last.content[0].text.replace(
				/\[e1\][^\n]*\n\[AutoRAG evidence reference:[^\n]*\]\n\n/u,
				"",
			);
		expect(() => f.p.dispatch(trimmed)).not.toThrow();
	});

	it("V2-U21 triggers exactly at the high watermark and does not repeat empty compactions", () => {
		const f = fixture();
		f.row(1, "A".repeat(5000));
		const model = { contextWindow: 30000, maxTokens: 1000 } as Model<Api>;
		const raw = [f.tool("a", [1])];
		const first = f.send(raw, model);
		f.p.begin("List facts for a new question");
		raw.push(user("X".repeat(1000), 2));
		const total = estimateContextMessageTokens([...first, raw[1]], false);
		const overhead = Math.ceil(safeContextInputBudget(model)! * 0.8) - total;
		f.p.project(raw, model, overhead - 1);
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
		const planned = f.p.project(raw, model, overhead);
		expect(f.reports.at(-1)?.compactionCount).toBe(1);
		const ready = f.p.finalize(planned);
		f.p.dispatch(ready);
		f.p.settle(true);
		f.p.project(raw, model, overhead);
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
	});
	it("V2-U31 shares the question's soft budget and reports explicit supplementation instead of resetting it", () => {
		const f = fixture("adaptive", 300);
		f.row(1);
		f.row(2);
		f.row(3);
		f.p.begin("Who approves refunds?");
		const raw = [f.tool("a", [1])];
		const first = f.send(raw);
		raw.push(f.tool("b", [2]));
		const second = f.send(raw);
		expect(second.slice(0, first.length)).toEqual(first);
		expect(f.reports.at(-1)?.efficiencyBudgetExceeded).toBe(true);
		f.p.begin("Who owns the next policy?");
		raw.push(f.tool("c", [3]));
		f.send(raw);
		expect(f.reports.at(-1)?.efficiencyBudgetExceeded).toBe(false);
	});
	it("V2-U18 repairs old references even when a later registration error takes the fallback path", () => {
		const f = fixture();
		f.row(1);
		const raw = [f.tool("a", [1])];
		f.send(raw);
		raw.push(f.tool("b", [1]));
		f.send(raw);
		f.p.registerResult("e999", {
			get content() {
				throw new Error("index /qa/row unavailable");
			},
			[localEvidence]: { query: "q", profile: "local", vector: [1] },
		} as unknown as RetrievalResult);
		raw.push(user("New question", 5));
		const planned = f.p.project(raw);
		expect(f.reports.at(-1)?.error).toBe("index /qa/row unavailable");
		const cut = [user("Old body omitted"), ...planned.slice(1)];
		const ready = f.p.finalize(cut);
		expect(allText(ready)).toContain("Policy 1.");
		expect(() => f.p.dispatch(ready)).not.toThrow();
	});
	it("protects evidence already used within the active question during capacity planning", () => {
		const f = fixture();
		f.row(1, "A".repeat(4000));
		const model = { contextWindow: 8000, maxTokens: 1000 } as Model<Api>;
		const raw = [f.tool("a", [1])];
		f.send(raw, model);
		raw.push(user(`Current-step constraints: ${"X".repeat(15000)}`, 2));
		const next = f.p.project(raw, model);
		expect(allText(next)).toContain("A".repeat(1000));
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
	});
	it("protects an older body explicitly referenced by the new user question", () => {
		const f = fixture();
		f.row(1, "A".repeat(4000));
		const model = { contextWindow: 8000, maxTokens: 1000 } as Model<Api>;
		const raw = [f.tool("a", [1])];
		f.send(raw, model);
		f.p.begin("Explain evidence e1");
		raw.push(user(`Explain [e1]. ${"X".repeat(15000)}`, 2));
		expect(allText(f.p.project(raw, model))).toContain("A".repeat(1000));
		expect(f.reports.at(-1)?.compactionCount).toBe(0);
	});
});
