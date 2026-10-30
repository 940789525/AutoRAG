"""Use an existing Codex login read-only; send only its access token through stdin, never files or argv."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import time


def credential_payload(path: Path) -> tuple[bytes, str]:
    raw = path.read_bytes()
    auth = json.loads(raw)
    access = auth.get("tokens", {}).get("access_token")
    if not isinstance(access, str) or len(access.split(".")) != 3:
        raise ValueError("Existing Codex login has no usable JWT access token")
    claims_part = access.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(claims_part + "=" * (-len(claims_part) % 4)))
    expires_at = claims.get("exp", 0) * 1000
    if expires_at <= time.time() * 1000:
        raise ValueError("Existing Codex login is expired; this runner never refreshes shared credentials")
    digest = hashlib.sha256(raw).hexdigest()
    return json.dumps({"access": access, "expiresAt": expires_at, "sourceHash": digest}).encode(), digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-auth", type=Path, required=True)
    parser.add_argument("--container", default="autorag-xsy-dev-dev-1")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--output", default=".omo/evidence/context-completion-gpt61-low")
    parser.add_argument("--tokenizer", required=True, help="Existing task tokenizer directory inside the container")
    args = parser.parse_args()
    payload, before = credential_payload(args.codex_auth)
    common = ["--run-real", "--provider", "openai-codex", "--model", "gpt-6.1-sol", "--thinking", "low", "--credential-stdin", "--auth-dir", "/dev-home/.pi/agent"]
    if args.probe:
        target = ["scripts/bench/check-codex-model.ts"]
    elif args.smoke:
        target = ["scripts/bench/context-selection.ts", "--sessions", *common, "--case", "M1-1", "--variants", "E,F", "--repeats", "1", "--output", args.output + ".json"]
    else:
        target = ["scripts/bench/run-context-session-suite.mjs", *common, "--workers", "1", "--split", "all", "--output", args.output, *(["--resume"] if args.resume else [])]
    command = ["docker", "exec", "-i", "-w", "/workspace", "-e", "RAYON_NUM_THREADS=2", "-e", "TOKIO_WORKER_THREADS=2", "-e", "UV_THREADPOOL_SIZE=2", "-e", "AUTORAG_QA_TOKENIZER_PATH=" + args.tokenizer, args.container, "node", "--v8-pool-size=1", *target]
    result = subprocess.run(command, input=payload, check=False)
    after = hashlib.sha256(args.codex_auth.read_bytes()).hexdigest()
    receipt = {"provider": "openai-codex", "model": "gpt-6.1-sol", "thinking": "low", "existingAuthBefore": before, "existingAuthAfter": after, "unchanged": before == after, "credentialFilesCreated": False, "refreshPerformed": False, "childExitCode": result.returncode}
    destination = Path(args.output + ".auth-check.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(receipt, indent=2))
    print(json.dumps({"authenticationReceipt": str(destination), "unchanged": before == after}))
    return result.returncode if before == after else 1


if __name__ == "__main__":
    raise SystemExit(main())
