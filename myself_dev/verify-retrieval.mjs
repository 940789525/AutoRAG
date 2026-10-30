import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { probeMinSyncDaemon } from "../src/embedding/daemon.ts";
import { MinSyncVectorMethod } from "../src/minsync/method.ts";
import { minSyncWorkspaceRoot } from "../src/minsync/paths.ts";

assert.equal(process.env.AUTORAG_CONFIG, "/dev-home/.autorag/config.json");
const config = JSON.parse(readFileSync(process.env.AUTORAG_CONFIG, "utf8"));
assert.equal(config.minSync?.embedder?.baseUrl, undefined, "Remote embedding must stay disabled");
assert.ok(!config.minSync?.embedder?.id || config.minSync.embedder.id.startsWith("native:"));
const daemon = await probeMinSyncDaemon();
assert.ok(daemon, "A real local MinSync daemon must answer");
assert.equal(daemon.dimension, 1024);
const cursor = join(minSyncWorkspaceRoot(config.workspacePath), ".minsync/cursor.json");
assert.ok(existsSync(cursor), `MinSync cursor must exist: ${cursor}`);

const query = "Who must authorize an exceptional reimbursement before money is paid?";
const method = new MinSyncVectorMethod({
  root: config.workspacePath,
  binaryPath: "/usr/local/bin/minsync",
  autoInstall: false,
});
const results = await method.retrieve(query, { topK: 5 });
const hit = results.find((result) => result.source === "/documents/refund-policy.txt");
assert.ok(hit, "A real vector query must retrieve the refund policy fixture");
assert.equal(results[0].source, hit.source, "The relevant policy must rank first");
assert.ok(isAbsolute(hit.source));
assert.ok(existsSync(hit.source));
assert.match(readFileSync(hit.source, "utf8"), /director approval/);
assert.equal(hit.metadata.method, "minsync");

const evidence = {
  verifiedAt: new Date().toISOString(),
  backend: "daemon",
  model: daemon.model,
  dimension: daemon.dimension,
  remoteEmbedding: false,
  cursor,
  query,
  results: results.map(({ source, score, metadata }) => ({ source, score, method: metadata.method })),
  sourceAbsoluteAndReadable: true,
};
writeFileSync("/workspace/myself_dev/semantic-verification.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
