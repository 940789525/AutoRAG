import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { contentHash } from "../indexing/chunker.ts";
import type { LocalReadHandle } from "../indexing/evidence.ts";
import { MAX_EVIDENCE_BODY_BYTES } from "../indexing/evidence-reader.ts";
import type { IndexEvidenceChunk } from "../indexing/types.ts";
import { type EvidenceLedger, evidenceLedgerKey } from "./evidence-ledger.ts";

export const READ_LOCAL_EVIDENCE_TOOL_NAME = "read_local_evidence";
const schema = Type.Object({ evidenceId: Type.String({ pattern: "^e[1-9][0-9]*$" }) }, { additionalProperties: false });
const HEADER = "AutoRAG complete local evidence: ";

/** Check the final provider payload too: a capacity guard must never leave a false completeness claim. */
export function assertCompleteEvidenceReads(
	messages: readonly AgentMessage[],
	authorize?: (source: string, sourceId: string) => boolean,
): void {
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== READ_LOCAL_EVIDENCE_TOOL_NAME || message.isError)
			continue;
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		try {
			const end = text.indexOf("\n");
			if (!text.startsWith(HEADER) || end < 0) throw new Error("missing complete-body header");
			const meta = JSON.parse(text.slice(HEADER.length, end)) as {
				complete?: boolean;
				bodySha256?: string;
				source?: string;
				sourceId?: string;
			};
			if (meta.complete !== true || contentHash(text.slice(end + 1)) !== meta.bodySha256)
				throw new Error("body fingerprint mismatch");
			if (
				authorize &&
				(typeof meta.source !== "string" ||
					typeof meta.sourceId !== "string" ||
					!authorize(meta.source, meta.sourceId))
			)
				throw new Error("source is outside the current search roots or scope");
		} catch (error) {
			throw new Error(
				`Local evidence read was truncated or altered by final request limits: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

export function createReadLocalEvidenceTool(
	ledger: EvidenceLedger,
	read: (handle: LocalReadHandle, signal?: AbortSignal) => Promise<IndexEvidenceChunk>,
	onRead?: (callId: string, evidenceId: string, handle: LocalReadHandle, body: string, text: string) => void,
): AgentTool {
	return {
		name: READ_LOCAL_EVIDENCE_TOOL_NAME,
		label: "Read Local Evidence",
		description:
			"Restore one complete local indexed chunk by a previously retrieved [eN] ID, including after context compaction. Rechecks source version and current scope. Does not search, embed, refresh, or accept file paths. If unavailable or changed, search again after refreshing; never assume an excerpt is the full source.",
		parameters: schema,
		execute: async (callId, params, signal) => {
			signal?.throwIfAborted();
			if (!Value.Check(schema, params))
				throw new Error("read_local_evidence expects only a valid evidenceId such as e2");
			const entry = ledger.localReadEntry(params.evidenceId);
			if (!entry?.localReadHandle)
				throw new Error(
					`Evidence ${params.evidenceId} has no verified local read handle in this session branch; refresh and search again`,
				);
			const handle = entry.localReadHandle;
			if (entry.source !== handle.source || entry.retrievalResultId !== handle.chunkId)
				throw new Error("Local evidence locator does not match its ledger entry");
			const row = await read(handle, signal);
			const current = ledger.localReadEntry(params.evidenceId);
			if (current?.key !== entry.key || JSON.stringify(current.localReadHandle) !== JSON.stringify(handle))
				throw new Error("Local evidence session branch changed while reading; search again");
			if (
				row.id !== handle.chunkId ||
				row.source_id !== handle.sourceId ||
				row.source_path !== handle.source ||
				contentHash(row.text) !== handle.bodySha256
			)
				throw new Error("Local evidence body does not match its verified locator");
			const bytes = Buffer.byteLength(row.text, "utf8");
			if (bytes > MAX_EVIDENCE_BODY_BYTES)
				throw new Error(
					`Local evidence body is ${bytes} bytes, exceeding the ${MAX_EVIDENCE_BODY_BYTES}-byte complete-body limit`,
				);
			if (
				entry.key !== evidenceLedgerKey(handle.source, row.text, handle) &&
				entry.key !== evidenceLedgerKey(handle.source, row.text)
			)
				throw new Error("Local evidence body does not match its original ledger identity");
			signal?.throwIfAborted();
			const details = {
				evidenceId: entry.id,
				source: handle.source,
				sourceId: handle.sourceId,
				chunkId: handle.chunkId,
				profile: handle.profile,
				bodySha256: handle.bodySha256,
				sourceSha256: handle.sourceSha256,
				outputSha256: handle.outputSha256,
				heading: row.heading,
				start: row.start,
				end: row.end,
				complete: true as const,
				text: row.text,
			};
			const { text: _body, ...meta } = details;
			const text = `${HEADER}${JSON.stringify(meta)}\n${row.text}`;
			onRead?.(callId, entry.id, handle, row.text, text);
			return { content: [{ type: "text", text }], details };
		},
	};
}
