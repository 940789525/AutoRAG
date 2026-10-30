# Container local-index recovery — 2026-10-26

Validated against the existing development container, Node 24.22.1, using the
source CLI referenced by `.vscode/launch.json`. No dependency or embedding
backend was changed. The existing MinSync daemon was neither restarted nor
reconfigured.

- `bun run check`, `bun run lint`, `bun run typecheck`, and `bun run build`: pass.
- Final focused regression: six files, 157 tests passed, including CLI refresh,
  config, index operations, native indexing, MinSync, and test isolation.
- Those tests deliberately inherited the debug `AUTORAG_CONFIG` and
  `AUTORAG_HOME`. The default config, debug config, and recovered real index's
  `ready.json` hashes were identical before and after the test process.
- The full-suite run passed 3,176 tests and skipped 63, with three failures.
  The container PATH issue in the MinSync installation test was then fixed;
  all 73 MinSync tests passed in the final regression. Two release-asset tests
  remain blocked by `npm pack failed: spawnSync npm ENOENT`: this container
  includes Node and Bun but no npm. The full suite is not claimed as green.
- Isolated live QA built a fresh local Qwen3 index with a Node inspector enabled,
  then retrieved the refund-policy fixture using a semantic paraphrase. The
  original absolute source path existed and was readable. The serving backend
  was `daemon`, model `Qwen/Qwen3-Embedding-0.6B`, dimension 1024, with no remote
  embedding endpoint. The interactive source TUI also started under a temporary
  config, displayed `embedding: daemon ● up`, and exited normally.
- The batch configuration from `launch.json` rebuilt the actual debug workspace:
  three documents, 73 chunks, 73 new embeddings, no failed sources. It took
  approximately 363 seconds on the container CPU. The first recovery attempt
  was interrupted by the validation harness's four-minute timeout; recovery
  completed after that artificial limit was removed. The test profile remains
  preserved, while the ready marker now names Qwen3/1024.
- A fresh query against the recovered debug workspace returned
  `/documents/refund-policy.txt`, readable at its original path, with no
  diagnostics or unsearched surfaces. No remote model query was used to judge
  or curate an answer.
- The single-input debug launch also completed a forced warm refresh in about
  3.1 seconds, reusing all 73 vectors with zero new embedding calls.

Config SHA-256 before and after validation:

| Config | Before | After |
| --- | --- | --- |
| Container default | `c655960cce74a0087340214e665827c1c8241aa736e6b0d18b114ad7d3a816ac` | Same |
| Debug config | `29747e71675cf0cf1327c71536f37ef2ea89c46f866c1319036ce8a86b312244` | Same |

The host default AutoRAG config was absent before and after. Source fixtures
were mounted read-only. Only the task's temporary QA root and TUI process were
used for isolated QA; the debug-workspace refresh was the intentional repair.
No other service was stopped. No claim is made about VS Code GUI breakpoint
interaction or remote LLM answer generation.

Cleanup receipt: the task-owned temporary QA root was removed after final checks;
the temporary TUI exited normally. Both config hashes still matched, the old
profile was present, and the final ready marker remained Qwen3/1024. Git fetch
was blocked by GitHub connectivity, and signing a commit requires the missing
Git author name/email; no commit or push was performed.
