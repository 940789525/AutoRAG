import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { embeddingConfigFromLegacy, normalizeEmbeddingConfig } from "../src/embedding/config.ts";

const args = process.argv.slice(2);
const flags = {};
while (args.length) {
 const flag = args.shift(); const value = args.shift();
 if (!["--input", "--output"].includes(flag) || !value || flags[flag]) throw new Error("Use --input CONFIG [--output NEW_CONFIG]");
 flags[flag] = value;
}
if (!flags["--input"]) throw new Error("An explicit --input CONFIG is required");
const input = resolve(flags["--input"]);
const raw = JSON.parse(readFileSync(input, "utf8"));
if (raw.embedding && raw.minSync?.embedder) throw new Error("Conflicting embedding and minSync.embedder; choose one before migration");
const embedding = raw.embedding ? normalizeEmbeddingConfig(raw.embedding, input) : embeddingConfigFromLegacy(raw.minSync?.embedder);
const ignored = Object.keys(raw.minSync ?? {}).filter(key => key !== "embedder");
if (flags["--output"]) {
 const output = resolve(flags["--output"]);
 if (input === output) throw new Error("Migration output must be a new file, not the input configuration");
 const result = {...raw, embedding}; delete result.minSync;
 writeFileSync(output, JSON.stringify(result, null, 2) + "\n", {flag:"wx",mode:0o600});
 console.log(JSON.stringify({output, ignoredMinSyncFields:ignored, originalUnchanged:true}));
} else console.log(JSON.stringify({defaultProfile:embedding.defaultProfile,profiles:Object.entries(embedding.profiles).map(([id,p])=>({id,kind:p.kind,model:p.model,dimension:p.dimension,allowRemote:p.allowRemote===true,allowedConsumers:p.allowedConsumers})), ignoredMinSyncFields:ignored, writes:false},null,2));
