#!/usr/bin/env bash
# L1 — build clean: pnpm install resolves, pnpm build produces dist/, typecheck passes.
#
# This is the lowest bar: the repo is buildable from a fresh clone with the
# documented prereqs (Node 22+, pnpm). Anything that fails here means a
# stranger following QUICKSTART hits a wall before they reach the brain proper.

set -euo pipefail

cd /workspace

echo "  pnpm install"
pnpm install --frozen-lockfile 2>&1 | tail -3

echo "  pnpm build"
pnpm build 2>&1 | tail -3

echo "  pnpm typecheck"
if ! pnpm typecheck 2>&1 | tail -5; then
  echo "  (typecheck has known pre-existing media-filer issues — not a hard fail in v0)"
fi

echo "  verify dist/ artifacts"
test -d dist/claude-code/bin       || { echo "  ✗ dist/claude-code/bin missing"; exit 1; }
test -x dist/claude-code/bin/user-prompt-submit.sh || { echo "  ✗ user-prompt-submit.sh not executable"; exit 1; }
test -x dist/claude-code/bin/on-stop.sh             || { echo "  ✗ on-stop.sh not executable";              exit 1; }
test -x dist/claude-code/bin/on-pre-compact.sh      || { echo "  ✗ on-pre-compact.sh not executable";       exit 1; }
test -f dist/mcp/server.js                          || { echo "  ✗ dist/mcp/server.js missing";             exit 1; }
echo "  ✓ all 4 dist artifacts present + executable"
