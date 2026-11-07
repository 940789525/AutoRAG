import { type Static, Type } from "typebox";
import type { RetrievalResult } from "../retrieval/types.ts";

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const localReadHandleSchema = Type.Object(
	{
		version: Type.Literal(1),
		source: Type.String(),
		sourceId: Type.String(),
		chunkId: Type.String(),
		profile: sha256,
		bodySha256: sha256,
		sourceSha256: sha256,
		outputSha256: sha256,
		structureSha256: Type.Optional(sha256),
	},
	{ additionalProperties: false },
);
export type LocalReadHandle = Static<typeof localReadHandleSchema>;

/** Internal, request-lifetime signals. Symbols survive result spreads but never JSON serialization. */
export const localEvidence = Symbol("autorag.localEvidence");

export interface LocalEvidence {
	readonly query: string;
	readonly profile: string;
	readonly scope?: string;
	readonly cosine?: number;
	readonly vector: readonly number[];
	readonly readHandle?: LocalReadHandle;
}

export type LocalEvidenceResult = RetrievalResult & { readonly [localEvidence]?: LocalEvidence };
