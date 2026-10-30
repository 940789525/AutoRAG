#!/usr/bin/env bash
set -euo pipefail
CHECK_ROOT="$(mktemp -d /tmp/autorag-dev-checks.XXXXXX)"
trap 'rm -rf -- "$CHECK_ROOT"' EXIT
cd /workspace
cp -a src test scripts skills docs vendor licenses package.json bun.lock \
  tsconfig.json tsconfig.build.json biome.json vitest.config.ts \
  README.md AGENTS.md LICENSE NOTICE Makefile "$CHECK_ROOT/"
ln -s /workspace/node_modules "$CHECK_ROOT/node_modules"
# Installer tests remove directories containing minsync from PATH; keep node available separately.
mkdir "$CHECK_ROOT/test-bin"
ln -s "$(command -v node)" "$CHECK_ROOT/test-bin/node"
export PATH="$CHECK_ROOT/test-bin:$PATH"
cd "$CHECK_ROOT"
bun run check
bun run lint
bun run typecheck
node node_modules/vitest/vitest.mjs run \
  test/manual-qa/docker-qa.test.ts \
  test/minsync/minsync.test.ts \
  test/embedding/daemon.test.ts
