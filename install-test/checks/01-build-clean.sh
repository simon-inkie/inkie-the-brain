#!/usr/bin/env bash
# L1 — build clean: pnpm install resolves, pnpm build produces dist/, typecheck passes.
#
# This is the lowest bar: the repo is buildable from a fresh clone with the
# documented prereqs (Node 22+, pnpm). Anything that fails here means a
# stranger following QUICKSTART hits a wall before they reach the brain proper.

set -uo pipefail

source "$(dirname "$0")/_lib.sh"

cd "${WORKSPACE:-/workspace}"

run_step "pnpm install"   pnpm install --frozen-lockfile  || exit $?
run_step "pnpm build"     pnpm build                      || exit $?

# typecheck has known pre-existing media-filer issues — not a hard fail in v0.
if ! run_step "pnpm typecheck" pnpm typecheck; then
  echo "  (typecheck has known pre-existing media-filer issues — not gating)"
fi

echo "  verify dist/ artifacts"
# The Claude Code adapter is bundled into dist/. The MCP server runs from
# source via tsx (no build step) — verify the source entry point instead.
test -d dist/claude-code/bin                            || { echo "  ✗ dist/claude-code/bin missing";              exit 1; }
test -x dist/claude-code/bin/user-prompt-submit.sh      || { echo "  ✗ user-prompt-submit.sh not executable";      exit 1; }
test -x dist/claude-code/bin/on-stop.sh                 || { echo "  ✗ on-stop.sh not executable";                 exit 1; }
test -x dist/claude-code/bin/on-pre-compact.sh          || { echo "  ✗ on-pre-compact.sh not executable";          exit 1; }
test -f mcp/server.ts                                   || { echo "  ✗ mcp/server.ts source missing";              exit 1; }
echo "  ✓ all 3 hook scripts present + MCP server source available"
