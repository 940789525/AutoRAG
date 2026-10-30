# Incremental paper reading inbox

The optional `autorag-research` service turns newly imported local PDFs into topic-specific reading cards. Initial seeding indexes the existing library without reading it with a language model. The ordinary CLI and MCP entry points do not start PostgreSQL or DBOS.

## TUI integration

In this checkout's development container, choose **AutoRAG：调试 TUI** and press F5. The compound launch starts the research service in a separate terminal, waits for readiness, then launches the TUI with `--research-url http://127.0.0.1:8765`. Run `node scripts/dev/setup-research.mjs` once on the Docker host to prepare PostgreSQL and private secret-file references; this environment has already been prepared.

Enter `/research` for the inbox menu: seed the existing PDFs, create a topic, select a paper for explicit reading or import a new PDF, inspect jobs/batches, read cards/evidence, and save feedback. The footer reports unread cards. Reading views are local, read-only components, not chat messages. The generic CLI connects only when `--research-url` is supplied and never starts the service implicitly. See `myself_dev/1027/TUI使用说明.md` for the current container walkthrough.

The trusted research config may specify `databasePasswordFileEnv` in addition to `databaseUrlEnv`. The named environment variable points to an absolute private password-file path; the connection URL is assembled in memory. The development config explicitly enables model processing; the generic example below remains disabled until opted in.

## Start

Requirements: Node.js 24+, the repository dependencies, PostgreSQL 17 or 18, and a working local MinSync embedding backend. Build with `bun run build`.

Create an **absolute-path**, trusted `research.local.json` outside the PDF directory:

```json
{
  "root": "/absolute/path/papers",
  "workspace": "/absolute/path/research-state",
  "runtimeConfig": "/absolute/path/autorag-runtime.local.json",
  "agentDir": "/absolute/path/pi/agent",
  "databaseUrlEnv": "AUTORAG_RESEARCH_DATABASE_URL",
  "allowModelProcessing": false,
  "port": 8765
}
```

The PDF directory and research workspace must be separate, non-nested directories. Use a dedicated PostgreSQL database and a research workspace that other AutoRAG processes do not index. The runtime config is an existing AutoRAG JSON config: the service reuses its model, parser, embedding and tokenizer settings, while overriding search roots, workspace and retrieval memory. Do not point `runtimeConfig` at the research config itself. Keep the library directory focused on PDFs: the reused refresh pipeline may also index other supported document formats in that directory; only registered PDF assets are eligible as research evidence.

Set the database URL through the named environment variable using your normal credential manager or shell environment; do not put credentials in the JSON file or command arguments. Run:

```bash
node dist/research/index.js /absolute/path/research.local.json
# Installed package:
autorag-research /absolute/path/research.local.json
```

The listener binds to `127.0.0.1`. Browser origins and non-loopback Host headers are rejected. The MVP is for one local user and one worker process per database. When running in a development container, use an HTTP client **inside that container** (for example `docker exec ... curl ...`); do not publish a container port that only listens on its internal loopback interface.

Start with `allowModelProcessing: false` to verify indexing. Set it to `true` in this trusted file and restart to enable screening and reading. This explicitly allows paper excerpts to be sent to the model already selected by `runtimeConfig`, including a remote model if configured. The HTTP API cannot change providers, credentials, filesystem roots, or this permission. Embeddings continue using the existing local MinSync default, unless the trusted runtime config explicitly selects another backend.

## First use

Every POST and PATCH requires an `Idempotency-Key`; reuse a key only for the same operation and body. Responses expose UUIDs to use in subsequent requests. Request keys are remembered for seven days.

```bash
curl -s http://127.0.0.1:8765/research/v1/libraries \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: library-1' \
  -d '{"name":"Research papers"}'

# Replace LIBRARY_ID with the returned id.
curl -s http://127.0.0.1:8765/research/v1/topics \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: topic-1' \
  -d '{"libraryId":"LIBRARY_ID","title":"Agent memory","question":"How is long-term agent memory evaluated?","focus":["evaluation","retrieval"],"exclusions":["pure inference acceleration"]}'

curl -s http://127.0.0.1:8765/research/v1/libraries/LIBRARY_ID/scans \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: seed-1' \
  -d '{"mode":"seed"}'
```

Poll `GET /research/v1/batches/BATCH_ID` until `status` is `ready`; inspect individual item errors as well. After seeding, import new PDFs into the existing directory. Watch notifications debounce for five seconds (maximum thirty); startup and five-minute scans repair missed notifications. For an immediate scan, POST `{"mode":"incremental"}` with a new request key. An unfinished batch is returned instead of creating a competing batch.

`GET /research/v1/inbox` lists cards; `GET /research/v1/inbox/ITEM_ID` returns the full structured note and revision-bound excerpts. Card validity is `partial` because reading uses bounded excerpts. Opening a card rechecks the original and parsed revisions; a missing or changed source changes validity to `source_unavailable`. Raw excerpts are not streamed through SSE.

## API

All routes below are under `/research/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | API/database liveness; never calls a language model |
| GET | `/overview` | Local TUI summary: library, topics, unread cards, recent jobs and batches |
| POST / GET | `/libraries` | Register/list the configured local library; POST body `{name}` |
| POST | `/libraries/:id/scans` | `{mode: "seed" \| "incremental"}` |
| GET | `/batches/:id` | Batch status, frozen baseline, counts and per-file outcomes |
| POST / GET | `/topics` | Topic title, question, focus and exclusions; at most five |
| PATCH | `/topics/:id` | Edit fields/active flag; increment revision without automatic historical backfill |
| GET | `/papers` | Papers with their assets; `limit` / `offset` pagination |
| PATCH | `/papers/:id` | Set explicit DOI/arXiv/title, or assign an unused provisional paper to an existing work |
| POST | `/papers/:id/analyses` | Explicit historical reading, body `{assetId, topicId}` |
| GET | `/inbox` | `topicId`, `reviewState`, `limit`, `offset` |
| GET | `/inbox/:id` | Card, evidence and current verification status |
| POST | `/inbox/:id/feedback` | `{kind, value, comment?}`; kinds: `usefulness`, `relevance`, `reading_state` |
| GET | `/runs/:id` | Durable stage, snapshots, coverage, reading usage and original error |
| POST | `/runs/:id/cancel` | Persist cancellation and abort an in-process model request |
| POST | `/runs/:id/retry` | Explicit new generation for failed/cancelled/deferred/not-selected/needs-review runs |
| GET | `/runs/:id/events` | SSE with `Last-Event-ID`; terminal state closes the stream |

Feedback values: `useful`/`not_useful`, `relevant`/`not_relevant`, or `unread`/`later`/`read` for the respective kind. SSE pushes stage names and transactionally ordered IDs, with a 256 KiB connection buffer bound. Expired history returns HTTP 410, or a `reset` event if expiration is encountered after streaming starts. Refetch the run after reset.

## Guarantees and limits

- Files must have unchanged size/mtime across two observations separated by two seconds before hashing. Fingerprinting and evidence reads detect revision changes; stable metadata alone does not certify a complete PDF. In-progress initial seed files keep seeding from completing.
- Byte-identical copies create locations without another automatic reading. Modern arXiv filenames such as `2501.12345v2.pdf` link explicit versions to a work. Other identifiers require explicit correction. Titles never cause automatic merging.
- At most 1,000 seed PDFs, 50 new assets per incremental batch, five topics and ten automatic deep readings per topic/batch. Pending files are reported and picked up on a later scan; deferred readings need an explicit retry or manual analysis.
- A batch freezes ready asset revisions before indexing its new files. Searches apply exact source allowlists before top-k; target assets and known versions of the same work are excluded. This is a frozen manifest, not an immutable historical copy of PDF content.
- Reading uses at most three retrieval queries, three old works, twelve excerpts and 12,000 input tokens (cl100k estimate, not a provider billing guarantee). New-paper excerpts cover bounded positions across the parsed document. Notes expose incomplete coverage rather than claiming a full systematic review.
- Pi helper sessions have only the structured submission tool, no shell/web/write/project instructions/extensions/interactive memory. A submission can be corrected once. Each model stage has a 120-second wall limit and a four-turn guard. Reported model usage covers the reading session; screening is separate.
- DBOS checkpoints stages. A killed in-flight model stage may repeat and incur another charge; completed stages are reused. Business result uniqueness and cancellation checks prevent duplicate or late cards. Index/observation failures retry at most twice; model failures require explicit retry to control unexpected spend.
- `research` is the application schema; `research_dbos` is SDK-owned. Back up both schemas together with the research workspace and retain the original files. Restoring only one schema can lose recovery or business state. Do not edit DBOS tables manually.
- `/health` confirms API/database access. It does not prove an embedding server, model login, or paper quality is ready; use a seed run and inspect the existing AutoRAG indexing diagnostics. There is no web UI, external paper subscription, automatic title merge, distributed deployment or quality benchmark in this MVP.

## Verification

```bash
bun run check
bun run lint
bun run typecheck
bun run build
bun run supply-chain
bun x vitest run test/research/reader.test.ts test/indexing/lance-store.test.ts test/indexing/pipeline.test.ts test/profiles/agent-factory.test.ts

# Use a disposable, dedicated database whose name ends in _test or _qa.
# The integration suite DROPS its research and research_dbos schemas before/after running.
# Set AUTORAG_RESEARCH_TEST_DATABASE_URL through your environment, then:
bun x vitest run test/research/service.integration.test.ts

# Local semantic smoke: synthetic PDF, isolated workspace, no model call.
# A pre-existing local MinSync daemon must be available; the script never controls it.
# Optional AUTORAG_RESEARCH_QA_TOKENIZER points to a directory containing both
# tokenizer.json and tokenizer_config.json, avoiding public resource downloads.
node --experimental-strip-types scripts/manual-qa/run-qa-research-local.ts
```

The integration suite uses real PostgreSQL and DBOS, controlled reading results, cancellation that returns late, and SIGKILL recovery in separate Node processes. The Pi test uses a scripted provider with the real profile runtime. These verify execution and evidence contracts; they do not establish the scientific quality of live model outputs.
