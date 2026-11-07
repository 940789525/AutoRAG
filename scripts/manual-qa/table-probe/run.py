"""Bounded offline T1 measurement in a fresh 4-CPU/8-GiB Docker cgroup."""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import psutil

from evaluate import markdown_tables, score, score_rows
from prepare import digest

CGROUP = Path("/sys/fs/cgroup")
HERE = Path(__file__).resolve().parent
MAX_REPLY = 4 * 1024 * 1024


def cgroup(name):
    return (CGROUP / name).read_text().strip()


def memory_events():
    return {k: int(v) for k, v in (line.split() for line in cgroup("memory.events").splitlines())}


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=4)


def request(process, case, ocr=True):
    packet = {"v": 1, "id": case["id"], "file": case["file"], "ocr": ocr}
    started = time.monotonic()
    process.stdin.write((json.dumps(packet) + "\n").encode())
    process.stdin.flush()
    data = bytearray()
    with selectors.DefaultSelector() as sel:
        sel.register(process.stdout, selectors.EVENT_READ)
        while b"\n" not in data:
            if not sel.select(max(0, started + 120 - time.monotonic())):
                raise TimeoutError(f'{case["id"]}: 120-second hard file deadline')
            block = os.read(process.stdout.fileno(), 65536)
            if not block:
                raise RuntimeError(f"parser exited without reply (status {process.poll()})")
            data.extend(block)
            if len(data) > MAX_REPLY:
                raise ValueError("reply exceeded 4 MiB")
    reply = json.loads(data)
    if reply.get("v") != 1 or reply.get("id") != case["id"] or type(reply.get("ok")) is not bool:
        raise ValueError("wrong v1 response identity")
    return reply, round(time.monotonic() - started, 4)


def embedding_request(port, embed=False):
    endpoint = f"http://127.0.0.1:{port}"
    if embed:
        body = json.dumps({"model": "Qwen/Qwen3-Embedding-0.6B", "input": ["Synthetic course ledger", "合成表格资源探针"]}).encode()
        url = urllib.request.Request(endpoint + "/v1/embeddings", data=body, headers={"Content-Type": "application/json"})
    else:
        url = endpoint + "/health"
    with urllib.request.urlopen(url, timeout=10) as response:
        result = json.load(response)
    if embed:
        if len(result["data"]) != 2 or any(len(item["embedding"]) != 1024 for item in result["data"]):
            raise RuntimeError("invalid FastEmbed result")
    elif not result["ready"] or result["dimension"] != 1024:
        raise RuntimeError("FastEmbed failed readiness")
    return result


def run(root, repo, mode, smoke=False):
    root, repo = root.resolve(), repo.resolve()
    expected_home = root / "home"
    if Path(os.environ.get("AUTORAG_HOME", "/")) != expected_home / ".autorag" or Path(os.environ.get("AUTORAG_CONFIG", "/")) != expected_home / ".autorag/config.json":
        raise ValueError("Set both AutoRAG paths inside this task's isolated home")
    if cgroup("memory.max") != "8589934592" or cgroup("cpu.max") != "400000 100000":
        raise ValueError("T1 requires an actual 8 GiB / 4 CPU cgroup")
    with open("/proc/net/route") as stream:
        if any(line.split()[1] == "00000000" for line in list(stream)[1:]):
            raise ValueError("T1 inference requires a Docker --network none container")
    manifest = json.loads((root / "fixtures/manifest.json").read_text())
    model_lock = json.loads((root / "models.lock.json").read_text())
    for file in model_lock["files"]:
        if digest(root / "models" / file["path"]) != file["sha256"]:
            raise ValueError(f'Model SHA256 mismatch: {file["path"]}')
    for case in manifest["cases"]:
        if digest(root / "fixtures" / case["file"]) != case["sha256"]:
            raise ValueError(f'Fixture SHA256 mismatch: {case["file"]}')
    out = root / "evidence" / (mode + ("-smoke" if smoke else ""))
    out.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "OMP_NUM_THREADS": "4", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "4", "NO_PROXY": "127.0.0.1", "PYTHONDONTWRITEBYTECODE": "1"})
    report = {"mode": mode, "offline": True, "cpuMax": cgroup("cpu.max"), "memoryMaxBytes": int(cgroup("memory.max")), "memorySwapMaxBytes": cgroup("memory.swap.max"), "fixtureManifestSha256": digest(root / "fixtures/manifest.json"), "modelLockSha256": digest(root / "models.lock.json"), "scriptsSha256": {p.name: digest(p) for p in sorted(HERE.glob("*.py"))}, "memoryEventsBefore": memory_events(), "records": [], "embeddingRequests": 0, "embeddingErrors": [], "sampleIntervalSeconds": 0.1, "parserPeakTreeRssBytes": 0, "cleanup": []}
    worker = embedding = None
    finished = threading.Event()
    threads = []
    with (out / "embedding.stderr.log").open("wb") as embed_log, (out / "parser.stderr.log").open("wb") as parser_log:
        try:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            embedding = subprocess.Popen(["/opt/autorag-embedding/bin/python", str(repo / "src/embedding/service.py"), "--port", str(port), "--cache-dir", str(root / "models"), "--model-dir", str(root / "models/qwen"), "--offline", "--threads", "4"], env=env, stdout=embed_log, stderr=embed_log, start_new_session=True)
            deadline = time.monotonic() + 120
            while True:
                try:
                    report["embeddingHealth"] = embedding_request(port)
                    break
                except (OSError, RuntimeError) as error:
                    if embedding.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError(f"FastEmbed readiness failed: {error}; see {embed_log.name}") from error
                    time.sleep(0.2)
            embedding_request(port, True)
            report["embeddingRequests"] += 1
            report["embeddingReadyMemoryBytes"] = int(cgroup("memory.current"))
            cmd = ["node", str(HERE / "baseline.mts"), str(root)] if mode == "baseline" else [sys.executable, "-u", str(HERE / "worker.py"), str(root), mode]
            worker = subprocess.Popen(cmd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=parser_log, start_new_session=True)

            def measure():
                while not finished.is_set():
                    try:
                        process = psutil.Process(worker.pid)
                        rss = sum(p.memory_info().rss for p in [process, *process.children(recursive=True)] if p.is_running())
                        report["parserPeakTreeRssBytes"] = max(report["parserPeakTreeRssBytes"], rss)
                    except psutil.NoSuchProcess:
                        pass
                    finished.wait(0.1)

            def use_embedding():
                while not finished.wait(8):
                    try:
                        embedding_request(port, True)
                        report["embeddingRequests"] += 1
                    except (OSError, RuntimeError) as error:
                        report["embeddingErrors"].append(str(error))

            threads = [threading.Thread(target=measure), threading.Thread(target=use_embedding)]
            for thread in threads:
                thread.start()
            cases = manifest["cases"][:1] if smoke else manifest["cases"]
            for i, (case, phase) in enumerate([(cases[0], "cold"), *((c, "warm") for c in cases)]):
                try:
                    reply, seconds = request(worker, case)
                    if reply["ok"]:
                        quality = score_rows(case, markdown_tables(reply["markdown"])) if mode == "baseline" else score(case, reply["document"])
                    else:
                        quality = {"pass": False, "error": reply["error"]}
                    row = {"case": case["id"], "split": case["split"], "language": case["language"], "core": case["core"], "phase": phase, "seconds": seconds, "pages": reply.get("pages", 1), "status": reply.get("status", "error"), **quality}
                    row["pass"] = row["pass"] and row["status"] == "success"
                    write_json(out / f'{i:02}-{case["id"]}.json', reply)
                except Exception as error:
                    row = {"case": case["id"], "split": case["split"], "phase": phase, "pass": False, "error": str(error)}
                    if isinstance(error, (TimeoutError, BrokenPipeError, RuntimeError)):
                        report["records"].append(row)
                        raise
                report["records"].append(row)
                write_json(out / "result.json", report)
                print(json.dumps(row, ensure_ascii=False), flush=True)
            embedding_request(port, True)
            report["embeddingRequests"] += 1
        except Exception as error:
            report["runError"] = str(error)
            raise
        finally:
            finished.set()
            for thread in threads:
                thread.join(timeout=12)
            for process, label in [(worker, "parser"), (embedding, "FastEmbed")]:
                if process is not None:
                    stop(process)
                    report["cleanup"].append({"process": label, "pid": process.pid, "exitCode": process.returncode})
            report["memoryPeakBytes"] = int(cgroup("memory.peak"))
            report["memoryEventsAfter"] = memory_events()
            report["resourcePass"] = not report.get("runError") and not report["embeddingErrors"] and all(report["memoryEventsAfter"][k] == report["memoryEventsBefore"][k] for k in ["oom", "oom_kill"])
            write_json(out / "result.json", report)
            print(json.dumps({"mode": mode, "peakBytes": report["memoryPeakBytes"], "parserRssBytes": report["parserPeakTreeRssBytes"], "resourcePass": report["resourcePass"], "records": len(report["records"])}), flush=True)


def verify_offline_failures(root):
    case = json.loads((root / "fixtures/manifest.json").read_text())["cases"][0]
    with tempfile.TemporaryDirectory(dir=root) as directory:
        empty = Path(directory)
        (empty / "fixtures").mkdir()
        shutil.copyfile(root / "fixtures" / case["file"], empty / "fixtures" / case["file"])
        checks = []
        for location, ocr in [(empty, True), (root, False)]:
            with (root / "evidence" / f"offline-{ocr}.stderr.log").open("wb") as log:
                process = subprocess.Popen([sys.executable, "-u", str(HERE / "worker.py"), str(location), "fast"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
                try:
                    reply, seconds = request(process, case, ocr)
                    if ocr:
                        passed = not reply["ok"] and "Missing prepared model:" in reply["error"]
                    else:
                        doc = reply.get("document", {})
                        text_items = [item.get("text", "") for item in doc.get("texts", [])]
                        cells = [cell.get("text", "") for table in doc.get("tables", []) for cell in table["data"]["table_cells"]]
                        passed = reply["ok"] and reply["status"] == "success" and not any(value.strip() for value in text_items + cells)
                    checks.append({"check": "missing-model" if ocr else "ocr-disabled", "pass": passed, "seconds": seconds, "reply": reply})
                finally:
                    stop(process)
        write_json(root / "evidence/offline-checks.json", checks)
        if not all(check["pass"] for check in checks):
            raise RuntimeError("offline/disabled OCR check failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("mode", choices=["baseline", "fast", "accurate", "offline-checks"])
    parser.add_argument("--repo", type=Path, default=Path("/workspace"))
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if args.mode == "offline-checks":
        verify_offline_failures(args.root)
    else:
        run(args.root, args.repo, args.mode, args.smoke)
