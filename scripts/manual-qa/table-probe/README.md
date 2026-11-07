# T1 local table parser probe

This is an isolated QA harness for the [T1 specification](../../../myself_dev/1107_切块优化/PLAN.md). It does not register a product parser, change an index, or run an answer model. The fixtures are synthetic. Only the dependency/model preparation steps need network access.

The measured environment is Linux x86_64, CPython 3.12, the existing AutoRAG dev image, a 4-CPU quota, 8 GiB of memory, and no extra swap. Use an existing image that contains Node 24, Bun and the hash-locked `/opt/autorag-embedding` venv. The Qwen weights must already be present in this checkout's `.autorag/embedding-models`; the preparation script copies and checks the six pinned files. The daily dev home and external datasource stores are not mounted. The checkout is read-only; the parser opens only generated fixtures.

## Reproduce

From the repository root, create a fresh task directory so earlier evidence is not overwritten. This example uses the locally available `autorag-xsy-dev:2.11.1-fastembed` image and a Linux x86_64 `uv` executable.

```bash
mkdir -p "$PWD/.autorag"
probe_host="$(mktemp -d "$PWD/.autorag/table-probe-repro.XXXXXX")"
probe=/workspace/.autorag/table-probe-t1
scripts=/workspace/scripts/manual-qa/table-probe
cp "$(command -v uv)" "$probe_host/uv"

qa() {
  network=$1
  shift
  docker run --rm --init --network "$network" --memory 8g --memory-swap 8g \
    --cpus 4 --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,source=$PWD,target=/workspace,readonly" \
    --mount "type=bind,source=$probe_host,target=$probe" \
    --env "HOME=$probe/home" --env "AUTORAG_HOME=$probe/home/.autorag" \
    --env "AUTORAG_CONFIG=$probe/home/.autorag/config.json" \
    --env "UV_CACHE_DIR=$probe/pip-cache" --env "HF_HOME=$probe/home/hf" \
    --env PYTHONDONTWRITEBYTECODE=1 \
    autorag-xsy-dev:2.11.1-fastembed "$@"
}

qa none "$probe/uv" venv --python /usr/bin/python3 "$probe/venv"
qa bridge "$probe/uv" pip sync --python "$probe/venv/bin/python" \
  --require-hashes --only-binary :all: --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cpu "$scripts/requirements.lock"
qa bridge "$probe/venv/bin/python" "$scripts/prepare.py" "$probe"
qa none "$probe/venv/bin/python" "$scripts/fixtures.py" "$probe/fixtures" "$probe/models/NotoSansSC.ttf"
for mode in fast accurate baseline offline-checks; do
  qa none "$probe/venv/bin/python" -u "$scripts/run.py" "$probe" "$mode"
done
```

Each mode gets a fresh cgroup. `run.py` verifies fixture/model hashes and the effective cgroup limit, starts its own loopback Qwen service, probes 1024-dimensional embeddings during parsing, enforces a 120-second file deadline, and stops only its own processes. No GPU is passed through. To try one document first, append `--smoke` to `fast` or `accurate`.

## Read the evidence

- `fixtures/manifest.json`: 12 document cases, expected records, known headers, split and hashes for that run. The current version includes a cell-width check for rendered PDF text. A fresh generation can change container metadata (for example ZIP timestamps) without changing the table or gold records.
- `models.lock.json`, `python-packages.json`: artifact identity, versions and upstream license metadata. The checked-in lock fixes sources and SHA-256; none of the weights are committed.
- `evidence/<mode>/result.json`: per-file seconds, relationship score, 0.1-second sampled parser process-tree RSS, cgroup `memory.peak` and OOM counters. Cold includes first worker/model load, warm reuses that process. `memory.peak` also includes page cache and FastEmbed; the sampled RSS is not an exact kernel high-water mark.
- `evidence/<mode>/*.json` and stderr logs: raw synthetic outputs and diagnostics. The kordoc baseline grades tables recoverable from the current adapter's Markdown, with its configured `zh-hans`/`en` Tesseract route. Docling grades its cell grid. This comparison measures output usable for structured indexing, not isolated OCR CER.
- `evidence/offline-checks.json`: missing-model diagnostic and absence of extracted cell/text content when OCR is disabled on the image-only PDF.

The probe's v1 wire contract is one JSONL request per document (`v`, `id`, `file`, `ocr`), one matching reply on stdout, and logs on stderr. Requests are bounded to 8 KiB, replies to 4 MiB; paths must remain inside the synthetic fixture directory. Successful conversion includes status, structured document and diagnostics; a partial conversion is not a quality pass. This contract is a T1 baseline for T2, not a public API.
