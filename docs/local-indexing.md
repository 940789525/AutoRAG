# AutoRAG-owned local indexing

AutoRAG owns parsing, chunking, lexical analysis, embedding batches, vector reuse,
LanceDB writes, and index maintenance. The default embedding model remains local
Qwen3-Embedding-0.6B through the shared MinSync daemon or optional native addon.
Local-file indexing and retrieval do not execute `minsync init`, `sync`, `check`,
or `query`. The exported legacy MinSync client remains available to callers that
use it explicitly.

## Inspect a run

```sh
autorag refresh --method local --json
autorag status --json
autorag refresh --method local --debug
autorag index inspect /docs/refund-policy.txt --json
```

`local` is an alias of the existing `minsync` method selection. The existing
`minsync` JSON property and retrieval method names `minsync` / `hybrid` remain
compatible. `minsync.backend` and `minsync.report.backend` identify the new
implementation as `autorag`.

Refresh reports stage durations in milliseconds:

| Stage | Work measured |
| --- | --- |
| `prepare` | Tokenizer/database preparation and embedding identity checks |
| `parse` | Reading, parsing and writing changed document mirrors |
| `chunk` | Structure-aware chunking and token counting |
| `lexical` | ICU segmentation and, for Korean, Kiwi morphology |
| `cache` | Looking up reusable vectors |
| `embed` | Embedding requests, including retries and any lazy runtime model loading |
| `write` | Recovery and atomic document replacements/deletions |
| `maintain` | Scalar/FTS/vector index creation and end-of-run optimization |

`durationMs` is wall time. Parsing and downstream indexing overlap, so stage
sums are work durations and should not be added to predict wall time. A cold run
can include public tokenizer/model downloads; compare a warm run separately. The
embedding runtime may load weights lazily during its first request; that time is
then included in `embed`, because AutoRAG cannot split the runtime's internal work
without provider-side tracing. The request boundaries and input batches remain
visible in AutoRAG.
`embedded` counts successful unique new embedding inputs; `reused` counts chunk
rows satisfied without another unique embedding call. `unchanged` counts source
files skipped before chunking. A forced refresh recomputes chunks and source
metadata while reusing valid matching vectors.

Each run writes these files under the configured workspace:

- `.autorag/local-index/runs/<runId>/events.jsonl`: stage starts, ends, errors,
  source identity, batch size and duration; flushed in groups of at most 64 events.
- `.autorag/local-index/runs/<runId>/report.json`: final counts, timings and exact
  underlying failures.
- `.autorag/local-index/last-run.json`: the latest report, including failed runs.
- `.autorag/local-index/ready.json`: queryable index profile and run identity (`partial` marks isolated source failures).

`--debug` prints stage events to stderr and embeds one input per request, using
the same pipeline. Use it for diagnosis rather than throughput comparisons.
`index inspect` reads an existing parsed mirror and prints chunk text, embedding
input, token counts, headings and offsets without invoking an embedding provider.
It prints document contents: use it only where that output is appropriate.
Offsets are UTF-16 positions in normalized Markdown, not PDF page coordinates.

## Defaults and tuning

```json
{
  "localIndex": {
    "targetTokens": 512,
    "maxTokens": 768,
    "maxInputTokens": 2048,
    "batchSize": 32,
    "maxBatchTokens": 8192
  }
}
```

Headings, paragraphs, lists, fenced code and pipe tables form chunk boundaries.
Long prose splits have a small overlap; table continuations repeat a bounded
header in embedding context. Embedding inputs include heading context. The token
budget reserves eight additional special tokens and checks passage/query prefixes
against the serving limit, including the daemon's reported `max_length`.

An eight-document channel starts downstream work before all parsing finishes.
Changed documents are grouped for length-sorted embedding batches; the padded
batch token budget and batch size bound requests. Identical embedding inputs
reuse vectors across files within one embedding profile. Writes replace complete
documents atomically; failed replacements never mark source state current. A
SQLite journal replays an interrupted commit on the next refresh. A process lease
rejects competing writers to the same index.

LanceDB stores full vectors and analyzed lexical text. BM25 and vector searches
apply source scope before top-k. The compatibility setting
`limits.minSyncScopedQueryTopK` no longer controls oversampling because scope
filtering happens in the database. Hybrid retrieval combines the two rankings with
reciprocal rank fusion. If query embedding fails, the hybrid method preserves
keyword retrieval and records the exact failure in each hit's `embeddingError`
metadata; the vector method still reports its failure. Small corpora use exact vector scans; at 10,000 chunk rows
an HNSW-SQ cosine index is built, with full-vector refinement on queries.
Maintenance runs once at the end of a changed/recovered run rather than per file.
These defaults require corpus-specific recall and latency validation before
making a performance or accuracy claim.

The tokenizer must match the embedding model. Public Hugging Face models load
`tokenizer.json` and `tokenizer_config.json` into the workspace cache. Known OpenAI
embedding models use `cl100k_base` through `js-tiktoken`. Other endpoints require
`localIndex.tokenizerPath` pointing to matching tokenizer assets. Relative paths
are resolved against the configured workspace. No corpus text is sent to a model
hub to download assets. Remote embeddings still require explicit trusted
`minSync.embedder` configuration; there is no automatic remote fallback.

Korean text uses `kiwi-nlp` in a worker. On first use AutoRAG downloads the pinned
Kiwi 0.24.1 base model from the official release and verifies its SHA-256 before
caching it under `.autorag/models`. `localIndex.koreanModelPath` can point to an
already provisioned directory containing the nine files listed in
`src/indexing/kiwi-model.ts`. Missing or invalid assets surface an error rather
than silently switching Korean retrieval to whitespace matching. Other languages
use ICU word segmentation plus original terms.

`localIndex.embeddingFingerprint` is an operator-supplied model revision. Change
it when a custom endpoint serves different document vectors under the same model
name. Provider/model/dimension, passage formatting and this revision isolate
vector profiles; changing only the query prefix does not force re-embedding.

## Migration and recovery

### Container debugging

When opening this checkout inside the development container, the configurations
in `.vscode/launch.json` use the source CLI, the same explicit
`.vscode/index-debug.config.json`, and `/data/workspace/index-debug` as the
workspace. Run **AutoRAG：索引测速（正常批处理）** once to build the local index,
then start **AutoRAG：调试 TUI**. Use **AutoRAG：调试索引（逐条向量化）** to step
through individual embedding requests. The latter forces a refresh and uses
single-input batches; matching cached vectors can still be reused. All three
configurations use the existing container Pi authentication directory and attach
to child processes. They require the existing local MinSync daemon or native
addon; they do not start or restart an embedding service.

An index marked `native-index-fixture` is a deterministic test index, not a real
semantic model. Queries using Qwen3 must reject it. Refresh with the same explicit
config to build a separate matching embedding profile; do not edit `ready.json`
or change the query model to the test fixture. The old profile remains available
for diagnosis. The error reports both models and dimensions when they differ.

Vitest's shared setup clears inherited `AUTORAG_CONFIG` and `AUTORAG_HOME` and
provides a temporary `HOME`. Tests that set their own config must keep it inside
their temporary root, including in child processes. Changing only `HOME` cannot
isolate a test from a caller's explicit `AUTORAG_CONFIG`.

The first refresh builds the new store from parsed mirrors. Existing MinSync
files are preserved and are not automatically imported or deleted. Legacy
`minSync.workspacePath`, binary and installer options no longer select the local
index database. `minSync.maxChunkSize` was a character limit; it does not map to
token budgets. Use `localIndex.targetTokens` / `maxTokens` instead.

`index reset --method local --yes` removes the new local store;
`index rebuild --method local --yes` resets it and refreshes. Full reset also
removes parsed mirrors. These commands preserve the legacy MinSync directory.
A partial run remains failed in its report and CLI exit status; successfully committed
files remain searchable and the component reports `degraded`, including after restart.
Source documents and datasource-native stores remain untouched. Obsidian retains
its isolated staging directory and opaque `/obsidian/...` source identities while
using this same indexing pipeline internally.

## Verification

Run repository checks, focused tests and supply-chain validation after installing
the locked dependencies. The database adapter integration tests use real LanceDB;
the pipeline unit tests inject only embedding/tokenizer/storage boundaries.
Live QA must use the repository's isolated Docker procedure. The updated live
runner checks the native ready marker, the stage report, readable original
sources, a real local semantic query and Korean stem BM25 retrieval. It no longer
uses a MinSync cursor as proof that AutoRAG indexing succeeded.
