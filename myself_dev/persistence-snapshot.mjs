import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const config = JSON.parse(readFileSync(process.env.AUTORAG_CONFIG, "utf8"));
const files = [
  process.env.AUTORAG_CONFIG,
  `${config.workspacePath}/.autorag/minsync/.minsync/cursor.json`,
  "/workspace/node_modules/typescript/package.json",
  "/workspace/dist/cli/index.js",
];
const model = `${process.env.HOME}/.cache/minsync/models/models--Qwen--Qwen3-Embedding-0.6B/blobs/0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd`;
const stat = statSync(model);
console.log(JSON.stringify({
  files: files.map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  })),
  model: { path: model, bytes: stat.size, modifiedAt: stat.mtimeMs },
}, null, 2));
