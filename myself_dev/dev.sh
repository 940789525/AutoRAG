#!/usr/bin/env bash
set -euo pipefail
DEV_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec docker compose -f "$DEV_DIR/compose.yaml" "$@"
