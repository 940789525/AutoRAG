"""Loopback-only, raw-text Qwen embedding service. Never reads corpus paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import urllib.request

MODEL_LOCK = json.loads(Path(__file__).with_name("qwen-model.json").read_text())
REVISION = MODEL_LOCK["revision"] + "/fastembed-0.9.1/v1"
MAX_INPUT_TOKENS = 2048
MAX_INPUTS = 32
MAX_BODY_BYTES = 4 * 1024 * 1024


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare_model(directory, offline=False):
    from filelock import FileLock
    directory.mkdir(parents=True, exist_ok=True)
    with FileLock(str(directory / ".prepare.lock")):
        for name, expected in MODEL_LOCK["files"].items():
            target = directory / name
            if target.exists() and digest(target) == expected:
                continue
            if offline:
                raise RuntimeError(f"Model file missing or hash mismatch: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            url = f'https://huggingface.co/{MODEL_LOCK["repository"]}/resolve/{MODEL_LOCK["revision"]}/{name}'
            print(f"Preparing {name} from {url}", file=sys.stderr, flush=True)
            temporary = target.with_name(target.name + f".{os.getpid()}.part")
            try:
                with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
                if digest(temporary) != expected:
                    raise RuntimeError(f"Model SHA256 mismatch: {name}")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    return directory


def create_app(model, tokenizer, model_dir):
    import numpy as np
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    slot = threading.BoundedSemaphore(1)

    def info():
        return {"ready": True, "model": MODEL_LOCK["model"], "dimension": 1024,
                "revision": REVISION, "maxInputTokens": MAX_INPUT_TOKENS,
                "maxInputs": MAX_INPUTS, "device": "cpu", "prefixOwner": "client",
                "pooling": "last-token", "normalization": "l2",
                "tokenizerPath": str(model_dir), "artifact": MODEL_LOCK}

    @app.get("/health")
    @app.get("/autorag/embedding-info")
    def health():
        return info()

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": MODEL_LOCK["model"], "object": "model", "owned_by": "local"}]}

    @app.post("/v1/embeddings")
    async def embeddings(request: Request):
        body = bytearray()
        async for block in request.stream():
            body.extend(block)
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({"error": "embedding request exceeds byte limit"}, status_code=413)
        try:
            value = json.loads(body)
            if not isinstance(value, dict) or value.get("model") != MODEL_LOCK["model"]:
                raise ValueError("Unknown embedding model")
            if set(value) - {"model", "input", "encoding_format"} or value.get("encoding_format", "float") != "float":
                raise ValueError("Only float embeddings and model/input fields are supported")
            texts = value.get("input")
            if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_INPUTS or any(not isinstance(t, str) or not t.strip() for t in texts):
                raise ValueError(f"input must contain 1 to {MAX_INPUTS} nonempty strings")
            for i, text in enumerate(texts):
                count = len(tokenizer.encode(text).ids)
                if count > MAX_INPUT_TOKENS:
                    raise ValueError(f"input[{i}] has {count} tokens; limit is {MAX_INPUT_TOKENS}; truncation is disabled")
        except (ValueError, TypeError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        if not slot.acquire(blocking=False):
            return JSONResponse({"error": "embedding service is busy"}, status_code=429, headers={"Retry-After": "1"})
        try:
            def infer():
                try:
                    return list(model.embed(texts, batch_size=len(texts)))
                finally:
                    # Cancellation must not make the slot available while ONNX still runs.
                    slot.release()
            vectors = await run_in_threadpool(infer)
            if len(vectors) != len(texts) or any(v.shape != (1024,) or not np.isfinite(v).all() or not np.any(v) for v in vectors):
                raise RuntimeError("Invalid embedding model output")
            return {"object": "list", "model": MODEL_LOCK["model"], "data": [
                {"object": "embedding", "index": i, "embedding": vector.tolist()} for i, vector in enumerate(vectors)]}
        except Exception as error:
            print(str(error), file=sys.stderr, flush=True)
            return JSONResponse({"error": str(error)}, status_code=500)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "::1"])
    parser.add_argument("--port", type=int, default=18382)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.threads < 1 or not 0 <= args.port <= 65535:
        parser.error("invalid threads or port")
    directory = args.model_dir or args.cache_dir / ("qwen3-0.6b-" + MODEL_LOCK["revision"])
    prepared = time.monotonic()
    prepare_model(directory, args.offline)
    print(f"Model preparation/verification: {time.monotonic() - prepared:.3f}s", file=sys.stderr, flush=True)
    if args.prepare:
        print(json.dumps({"modelDir": str(directory), "revision": REVISION}))
        return
    from fastembed import TextEmbedding
    from tokenizers import Tokenizer
    import uvicorn
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    loaded = time.monotonic()
    print("Loading pinned Qwen ONNX on CPU", file=sys.stderr, flush=True)
    model = TextEmbedding(model_name=MODEL_LOCK["model"], specific_model_path=str(directory), local_files_only=True,
                          threads=args.threads, providers=["CPUExecutionProvider"])
    print(f"Model load: {time.monotonic() - loaded:.3f}s", file=sys.stderr, flush=True)
    probe = list(model.embed(["AutoRAG readiness probe"]))
    if len(probe) != 1 or probe[0].shape != (1024,):
        raise RuntimeError("Qwen model failed readiness inference")
    print("FastEmbed Qwen ready: 1024 dimensions, cpu, " + REVISION, file=sys.stderr, flush=True)
    uvicorn.run(create_app(model, tokenizer, directory), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    try:
        main()
    except ImportError as error:
        raise SystemExit(f"{error}. Install the pinned embedding-requirements.lock into a Python 3.12 environment and set AUTORAG_FASTEMBED_PYTHON to its python.")
