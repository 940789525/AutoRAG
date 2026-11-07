"""Online preparation only. Frozen sources + hashes; inference runs network-free."""
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
from pathlib import Path
import shutil
import urllib.parse
import urllib.request


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(root, repo):
    root, repo = Path(root), Path(repo)
    models = root / "models"
    lock = Path(__file__).with_name("models.lock.json").read_bytes()
    inventory = json.loads(lock)
    sources = inventory["sources"]
    repositories = {v["repository"].replace("/", "--"): v for v in sources["repositories"]}
    qwen = inventory["qwen"]
    if qwen != json.loads((repo / "src/embedding/qwen-model.json").read_text()):
        raise ValueError("Product Qwen manifest changed; update T1 evidence before reusing this model lock")
    origin = repo / ".autorag/embedding-models" / ("qwen3-0.6b-" + qwen["revision"])
    rapid = Path(importlib.util.find_spec("rapidocr").origin).parent / "models"
    for item in inventory["files"]:
        target = models / item["path"]
        if target.exists() and digest(target) == item["sha256"]:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        kind, _, relative = item["path"].partition("/")
        temporary = target.with_suffix(target.suffix + ".part")
        try:
            print("prepare", item["path"], flush=True)
            if kind in {"rapidocr", "qwen"}:
                shutil.copyfile((rapid if kind == "rapidocr" else origin) / relative, temporary)
            else:
                if kind == "NotoSansSC.ttf":
                    url = sources["font"]["url"]
                elif kind == "tessdata":
                    url = f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{sources["tesseract"]["revision"]}/{relative}'
                else:
                    source = repositories[kind]
                    url = f'https://huggingface.co/{source["repository"]}/resolve/{source["revision"]}/{urllib.parse.quote(relative)}'
                with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as stream:
                    shutil.copyfileobj(response, stream)
            if temporary.stat().st_size != item["bytes"] or digest(temporary) != item["sha256"]:
                raise ValueError(f'Model SHA256/size mismatch: {item["path"]}')
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    (root / "models.lock.json").write_bytes(lock)
    versions = []
    for dist in metadata.distributions():
        versions.append({"name": dist.metadata["Name"], "version": dist.version, "license": dist.metadata.get("License-Expression") or dist.metadata.get("License", "UNKNOWN")[:200]})
    (root / "python-packages.json").write_text(json.dumps(sorted(versions, key=lambda v: v["name"].lower()), indent=2) + "\n")
    print(json.dumps({"modelFiles": len(inventory["files"]), "modelBytes": sum(f["bytes"] for f in inventory["files"])}), flush=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--repo", type=Path, default=Path("/workspace"))
    args = parser.parse_args()
    prepare(args.root, args.repo)
