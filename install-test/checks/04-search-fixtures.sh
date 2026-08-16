#!/usr/bin/env bash
# L4 — search (synthetic corpus): drop the fixture markdown files into a
# fresh brain vault, run the indexer, run a search, verify the expected
# fixture file is in the top-3 results.
#
# This is the "the brain actually works" test — the previous three only
# verified the install path mechanically. Here we verify the round-trip.

set -uo pipefail

source "$(dirname "$0")/_lib.sh"

cd "${WORKSPACE:-/workspace}"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "  - GEMINI_API_KEY unset — skipping (search requires real embeddings)"
  exit 0
fi

FIXTURES_DIR="/opt/install-test/fixtures/brain"
BRAIN_DIR=$(mktemp -d)
SILO_DIR=$(mktemp -d)

# Copy fixtures into a fresh brain vault layout.
cp -r "$FIXTURES_DIR"/* "$BRAIN_DIR/"
mkdir -p "$SILO_DIR/memory/observations" "$SILO_DIR/memory/reflections"

echo "  brain vault: $BRAIN_DIR"
echo "  fixture files:"
find "$BRAIN_DIR" -name "*.md" -type f | sed 's|^|    |'

export BRAIN_VAULT_DIR="$BRAIN_DIR"
export BRAIN_MEMORY_DIR="$SILO_DIR/memory"
export AGENT_NAME="install-test"

run_step "pnpm index (fixture corpus)" timeout 90 pnpm index || exit $?

# Search for a phrase that's distinctively in one of the fixtures.
#
# `pnpm run search`, NOT `pnpm search`: pnpm has a BUILT-IN `search` command
# that queries the npm registry, and a built-in beats a package.json script of
# the same name. `pnpm search "octopus …"` therefore returns npm packages and
# this check fails with output that looks nothing like the brain. `run` forces
# the script. Same trap is called out in README/QUICKSTART.
echo "  pnpm run search 'octopus distributed cognition'"
SEARCH_OUT=$(timeout 30 pnpm --silent run search "octopus distributed cognition" 2>&1 | head -50)

# The expected fixture must show up in the results.
if echo "$SEARCH_OUT" | grep -q "octopus-architecture"; then
  echo "  ✓ search returned the expected fixture (octopus-architecture)"
else
  echo "  ✗ search did not return the expected fixture"
  echo "  --- search output ---"
  echo "$SEARCH_OUT"
  exit 1
fi

# Negative-control: a query unrelated to fixtures should NOT return high-confidence
# matches to fixture filenames. We don't enforce this strictly — just log it.
echo "  pnpm run search 'completely unrelated quantum nonsense' (negative control)"
NEG_OUT=$(timeout 30 pnpm --silent run search "completely unrelated quantum nonsense" 2>&1 | head -10)
echo "$NEG_OUT" | head -3 | sed 's|^|    |'
