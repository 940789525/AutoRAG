import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createAutoRAGLite, releaseEmbedders } from "../dist/index.js";

assert.equal(process.env.AUTORAG_HOME, "/dev-home/.autorag");
assert.equal(process.env.AUTORAG_CONFIG, "/dev-home/.autorag/config.fastembed.json");
const lite = createAutoRAGLite({ readOnly: true });
const profile = lite.config.embedding.profiles["local-qwen3"];
assert.equal(profile.kind, "local-http");
assert.equal(new URL(profile.baseUrl).hostname, "127.0.0.1");

try {
  const response = await fetch(`${profile.baseUrl}/health`);
  assert.equal(response.ok, true);
  const health = await response.json();
  assert.equal(health.ready, true);
  assert.equal(health.model, "Qwen/Qwen3-Embedding-0.6B");
  assert.equal(health.dimension, 1024);
  const readyPath = join(lite.config.workspacePath, ".autorag/local-index/ready.json");
  assert.equal(JSON.parse(readFileSync(readyPath, "utf8")).embeddingProfile, "local-qwen3");
  const query = "Who must authorize an exceptional reimbursement before money is paid?";
  const result = await lite.getRetrievalEngine().retrieveSelected(
    query, { methods: ["local-vector"], local: true }, { topK: 5 },
  );
  assert.equal(result.unsearched?.length ?? 0, 0);
  const hit = result.results.find(item => item.source === "/documents/refund-policy.txt");
  assert.ok(hit, "A real vector query must retrieve the refund policy fixture");
  assert.equal(result.results[0].source, hit.source);
  for (const item of result.results) {
    assert.ok(isAbsolute(item.source));
    accessSync(item.source, constants.R_OK);
  }
  assert.match(readFileSync(hit.source, "utf8"), /director approval/);
  const evidence = {
    verifiedAt: new Date().toISOString(), backend: "local-http", model: health.model,
    dimension: health.dimension, remoteEmbedding: false, readyPath, query,
    results: result.results.map(({ source, score, metadata }) => ({ source, score, method: metadata.method })),
    sourceAbsoluteAndReadable: true,
  };
  writeFileSync(join(process.env.AUTORAG_HOME, "semantic-verification.fastembed.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await releaseEmbedders();
}
