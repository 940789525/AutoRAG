# Native indexing validation — 2026-10-24

Implementation branch: `codex/observable-local-index`, based on `ddfb4b88`.
AutoRAG owns the local-file and Obsidian indexing pipeline. MinSync supplies
local embeddings only; the local index does not spawn its indexing/query CLI.

## Repository checks

- `bun run check`, `bun run lint`, `bun run typecheck`: pass.
- `bun run build`: pass, including the separately emitted lexical worker.
- Actual Bun lockfile generated using the npm registry; frozen-lockfile
  verification passes. Apache Arrow is pinned to 18.1.0, within the LanceDB
  SDK's declared peer range. Existing dependency versions remain available;
  Bun moves some existing optional dependencies into nested resolutions.
- NOTICE regenerated from installed packages; `bun run supply-chain`: pass.
  No license-allowlist or root LICENSE change. This gate validates the supplied
  inventory/policy; no external vulnerability-feed scan was requested.
- Final full Vitest run: 272 files passed and 16 skipped; 3,147 tests passed,
  63 skipped (288 files / 3,210 tests total). Live QA state was cleaned before
  the run so environment fixtures could use their own temporary state.
- Full-suite command: `node node_modules/vitest/vitest.mjs run --maxWorkers=3
  --testTimeout=180000`. The existing 16,385-message sidecar fixture exceeds
  its default 60-second timeout on this machine; it passes with this run's
  180-second allowance. The repository's default timeout was not changed.

## Focused coverage

Tests cover token and Unicode boundaries, structural/table chunks, stable
sections, vector reuse, unchanged runs, safe source deletion, per-input failures,
invalid vectors, HTTP cancellation, recovery replay, competing writers,
maintenance interruption, model revision readiness, bounded parser handoff,
empty-corpus refresh without model downloads, transparent lexical fallback when
query embedding fails, CLI inspection of actual embedding
inputs, and Agent/Obsidian/CLI/MCP integration.

LanceDB adapter tests execute real database operations. The 10,000-row ANN test
builds the vector index and checks recall@10 against exact cosine scans for three
deterministic synthetic queries, requiring at least 0.9 for each. This is an ANN
implementation check, not a claim about document relevance on a user's corpus.

## Isolated real-model QA

The supported Docker launcher ran cold and warm workflows. Both passed local
semantic retrieval, original-source readability, Korean stem BM25 retrieval,
CLI JSON/human output, and explicit loopback embedding-endpoint failure reporting.
The local and Obsidian lanes passed; eleven unavailable native CLI/store lanes
were recorded as SKIP, never PASS. No real host home or native datasource store
was mounted. All credentials were excluded; only proxy configuration was
forwarded. Embeddings used local Qwen3-Embedding-0.6B, 1,024 dimensions.

For the two-document fixture, the cold index run took 25,611 ms: preparation
5,656 ms, parsing 28 ms, chunking 13 ms, lexical work 18,346 ms, embedding
1,345 ms, database writes 50 ms, and maintenance 38 ms. Cold lexical work includes
its public model download/initialization. The final warm refresh took 564 ms,
with both documents unchanged and zero new embeddings. The final compatible Arrow dependency set also passed the real database and
warm semantic workflow. These measurements
exclude daemon startup and are not a comparison against the old pipeline.

Evidence is under `.omo/evidence/live-core-cold/result.json`,
`.omo/evidence/live-core-warm/result.json`, and the tracked fixed-live-E2E receipt.
The operator's real `~/.autorag/config.json` was absent before and after QA;
no real-home config was written. Task-owned QA containers/daemons exited and `.autorag-e2e` was removed;
verification reports were retained.

## Limits

No representative user-corpus recall/latency benchmark, macOS/Windows native run,
release, deployment, or merge has been performed. Existing legacy MinSync index
data is preserved; the first native refresh builds a separate store.

