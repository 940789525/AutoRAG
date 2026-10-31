# FastEmbed / API embedding

AutoRAG owns parsing, chunking, caching, LanceDB indexing, BM25/hybrid search and source verification. A separate loopback Python process runs FastEmbed; an explicitly authorized HTTP API is the optional alternative. This release adds TUI operations, not new MCP functionality.

The default remains `Qwen/Qwen3-Embedding-0.6B`, 1024 dimensions, last-token pooling and L2 normalization on CPU. FastEmbed needs the pinned **ONNX** representation; an existing MinSync safetensors/GGUF cache cannot be loaded directly. AutoRAG prepares a separate cache and never modifies `~/.cache/minsync/models`. No GPU, quantization or BGE default is introduced. Keeping Qwen does not promise a speedup; batch and CPU measurements are in the implementation evidence.

## Install the local runtime

Node.js 24+ and Python 3.12 are required for the validated configuration. From a source checkout:

```bash
python3.12 -m venv .venv-embedding
.venv-embedding/bin/python -m pip install --require-hashes -r src/embedding/embedding-requirements.lock
export AUTORAG_FASTEMBED_PYTHON="$PWD/.venv-embedding/bin/python"
```

For an npm installation, replace `src/embedding/embedding-requirements.lock` with `<package-root>/dist/embedding-requirements.lock`. The package ships `dist/embedding-service.py` and `dist/qwen-model.json`; it does not require source scripts to be present. Windows uses the venv's `Scripts/python.exe`.

The model lock records the Qdrant ONNX repository, immutable revision and every file's SHA256. The unquantized weights alone occupy about 2.38 GB. First preparation requires access to Hugging Face and additional disk space for temporary downloads. Preparation logs go to stderr; the TUI reports the prepare phase. Model loading happens once per service process, before HTTP readiness.

For a manually managed service (source checkout):

```bash
python3 src/embedding/service.py --cache-dir /YOUR/AUTORAG_HOME/models/fastembed
```

Use the configured venv's Python, not necessarily system `python3`. The default listener is `http://127.0.0.1:18382`. `--prepare` downloads/verifies files without starting HTTP; `--offline` refuses downloads; `--model-dir /path/to/verified/onnx-directory` loads an independently prepared directory. Health verifies model, revision, dimension, pooling and normalization. If using a custom model directory, configure its tokenizer path in the profile manifest too.

## TUI operations

With configured document roots, no conversation model is needed for:

```text
/index build --embedding local-qwen3
/index status
/index refresh
/index cancel --job JOB_ID
/embedding status
/embedding on
/embedding off
```

`build` creates an isolated generation, performs a query smoke test, then atomically activates it. Failure/cancellation preserves the previous active generation. `refresh` updates the active profile and reuses unchanged chunks; a partial refresh reports already committed documents. Profile changes require `build`. Source documents are never rewritten. Index generations live under `<workspace>/.autorag/local-index`; its `ready.json` is the activation pointer.

`build` explicitly prepares/starts the local service when needed; queries, setup and status never start it or download models. CLI refresh/watch need an already running service. `/embedding off` can stop only the process started by this agent; an existing external service remains externally managed. Exiting the owning TUI cancels its task and closes its owned service. It is not a detached job queue. Tasks are persisted under `<workspace>/.autorag/index-jobs`; a dead owner is reported as interrupted, not successful. Linux owner detection also checks the process start tick to avoid PID reuse.

A signed-in conversation model can process requests such as “使用本地 Qwen 为已配置目录建立索引” and “查看索引进度”. A native `manage_local_index` tool uses the same task controller. Explicit `/index` remains the deterministic entry. Natural-language indexing requires a matching explicit user intent; retrieved document text cannot grant write or network authorization.

## Profile configuration

The default `embedding` block is generated for new configurations. Existing `minSync.embedder` inputs remain readable, but cannot coexist with `embedding`; migrate explicitly. `minsync` retrieval selections and `syncMinSync` are compatibility names for the AutoRAG index, not executable MinSync clients. `local-vector` selects the same registered method, without duplicate retrieval.

Example optional API profile (merge into the existing config, retaining the local profile):

```json
{
  "embedding": {
    "defaultProfile": "local-qwen3",
    "profiles": {
      "local-qwen3": {
        "kind": "local-http",
        "protocol": "openai",
        "baseUrl": "http://127.0.0.1:18382",
        "model": "Qwen/Qwen3-Embedding-0.6B",
        "dimension": 1024,
        "batchSize": 4,
        "maxConcurrent": 1
      },
      "online": {
        "kind": "api",
        "protocol": "openai",
        "baseUrl": "https://api.openai.com",
        "model": "text-embedding-3-small",
        "dimension": 1536,
        "apiKeyEnv": "AUTORAG_EMBEDDING_API_KEY",
        "allowRemote": true,
        "allowedConsumers": ["local-documents"],
        "batchSize": 4,
        "maxConcurrent": 1,
        "timeoutMs": 120000,
        "maxRetries": 2,
        "manifest": {
          "model": "text-embedding-3-small",
          "dimension": 1536,
          "revision": "operator-approved-text-embedding-3-small-v1",
          "maxInputTokens": 8191,
          "queryPrefix": "",
          "passagePrefix": "",
          "pooling": "provider-managed",
          "normalization": "provider-managed"
        }
      }
    }
  }
}
```

Set the named environment variable outside configuration; no literal keys in files or argv. Then `/index build --embedding online`; return locally with `/index build --embedding local-qwen3`. The active ready manifest persists the successful selection across restarts. Editing `defaultProfile` alone cannot silently switch a ready index to another model.

Remote sending requires **both** `allowRemote:true` and the relevant `allowedConsumers` entry. Supported consumers are `local-documents`, `memory`, `chat-sidecars`, `gist`, `native-cli`. Document opt-in does not authorize mail/chat/memory. API profiles default to no allowed consumers. A key is checked before any text request. The connection probe uses fixed non-corpus text. Redirects, invalid dimensions, non-finite/zero vectors and duplicate OpenAI indices are rejected. Retry/timeout/cancellation are bounded; API failure never silently falls back to another backend.

A custom manifest must declare actual model semantics and input limits; update `revision` when the provider changes them. For non-OpenAI tokenizers supply matching local `manifest.tokenizerPath` assets. Supported OpenAI embedding models use the bundled cl100k tokenizer. `modelManifest` may reference a JSON manifest relative to the config file; it is exclusive with inline `manifest`. Local HTTP profiles are loopback only. This release supports serial batches (`maxConcurrent:1`); larger values are rejected.

Queries get the Qwen instruction once in the client; passages stay raw. The service never adds instructions and rejects overlength input instead of truncating it. The index counts tokens before sending, including prefixes. Semantic fingerprints include engine/profile type, protocol, model, dimension, revision, limits, prefixes, pooling and normalization; chunk caches also include tokenizer/analyzer contents and chunk settings. An endpoint port change alone does not change semantic identity. The first FastEmbed build never reuses legacy MinSync vectors.

## Migration and rollback

Generate a preview without modifying the current config:

```bash
node scripts/migrate-embedding-config.mjs --input /path/to/config.json
node scripts/migrate-embedding-config.mjs --input /path/to/config.json --output /path/to/config.fastembed.json
```

The second command creates a **new** file exclusively. Neither command modifies the input. Legacy remote endpoints require an explicit dimension and still receive no remote opt-in. Review the new file and its consumer authorization before choosing it with `--config`. The script lists ignored MinSync installer/workspace/chunker options; AutoRAG's native `localIndex` controls chunking. Existing parsed mirrors and old model/index directories remain untouched.

Keep the old release and configuration separately if rollback to MinSync is needed. The new release does not read MinSync vectors; keeping those files alone does not make them searchable here. Existing SDK code using MinSync installer/client classes must migrate to `createEmbedderFromConfig`, `LocalDocumentIndex` or `AutoRAGAgent.startIndexJob`. These execution exports were removed deliberately.

Memory, Gist and chat sidecars reject/invalidate mismatched fingerprints and keep their text. They are separate stores and do not share the document index's atomic activation. Native datasource CLIs keep their own stores and credentials. In particular lazykatok cannot receive Qwen role prefixes through its existing environment interface, so AutoRAG leaves its native embedding configuration independent. Hister accepts only a local endpoint and changes its own config only through its explicit synchronization operation.

## Verification

Run repository checks plus Python contract tests:

```bash
bun run check
bun run lint
bun run typecheck
bun run supply-chain
bun run build
.venv-embedding/bin/python -m unittest discover -s test/embedding -p '*_test.py'
```

Use isolated `AUTORAG_HOME` **and** `AUTORAG_CONFIG` for every live QA command. The real local-model smoke entry is `scripts/manual-qa/run-qa-fastembed.mts`; it requires an already prepared loopback service and tokenizer assets and creates only synthetic fixtures. Hosted API verification requires an operator-authorized fixture profile and its own credentials; protocol mocks cannot prove real provider availability. See the recorded implementation evidence for what was actually run.
