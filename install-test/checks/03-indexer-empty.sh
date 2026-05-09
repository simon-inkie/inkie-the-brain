#!/usr/bin/env bash
# L3 — indexer (empty silo): pnpm index runs against a fresh, empty
# brain vault and silo without crashing, exits 0, doesn't wedge Qdrant.
#
# The bar is "doesn't crash on the empty case" — the L4 check verifies
# actual indexing semantics with fixtures.

set -uo pipefail

source "$(dirname "$0")/_lib.sh"

cd "${WORKSPACE:-/workspace}"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "  - GEMINI_API_KEY unset — skipping (indexer requires embeddings)"
  exit 0
fi

# Fresh empty brain vault + silo for this run.
BRAIN_DIR=$(mktemp -d)
SILO_DIR=$(mktemp -d)
mkdir -p "$BRAIN_DIR/ideas" "$BRAIN_DIR/decisions" "$BRAIN_DIR/learnings" "$BRAIN_DIR/inbox"
mkdir -p "$SILO_DIR/memory/observations" "$SILO_DIR/memory/reflections"
echo "  brain vault: $BRAIN_DIR (empty)"
echo "  silo:        $SILO_DIR (empty)"

# Override config to point at the empty dirs
export BRAIN_VAULT_DIR="$BRAIN_DIR"
export BRAIN_MEMORY_DIR="$SILO_DIR/memory"
export AGENT_NAME="install-test"

run_step "pnpm index (empty corpus)" timeout 60 pnpm index || exit $?
echo "  ✓ indexer ran cleanly on empty corpus"

# Verify Qdrant is still healthy (didn't get poisoned)
if ! curl -sf "${QDRANT_URL}/healthz" >/dev/null; then
  echo "  ✗ Qdrant unhealthy after indexer run"
  exit 1
fi
echo "  ✓ Qdrant still healthy"
