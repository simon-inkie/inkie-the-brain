#!/usr/bin/env bash
# Install-test entry point. Runs four checks in order, prints a pass/fail
# matrix at the end, exits 0 if all pass and 1 if any fail.
#
# Each check is a self-contained script under /opt/install-test/checks/.
# Checks emit their own ✓/✗ lines while running; this script aggregates.

set -uo pipefail

CHECKS_DIR="/opt/install-test/checks"
WORKSPACE="${WORKSPACE:-/workspace}"
RESULTS=()
FAILED=0

cd "$WORKSPACE"

echo "════════════════════════════════════════════════════════════"
echo "  the-brain — install-test"
echo "  workspace: $WORKSPACE"
echo "  qdrant:    ${QDRANT_URL:-not set}"
echo "  gemini:    $([ -n "${GEMINI_API_KEY:-}" ] && echo 'set' || echo 'NOT SET — L2/L3/L4 will be skipped')"
echo "════════════════════════════════════════════════════════════"

run_check() {
  local script="$1"
  local name="$2"
  echo
  echo "── $name ──"
  if bash "$script"; then
    RESULTS+=("✓ $name")
  else
    RESULTS+=("✗ $name")
    FAILED=$((FAILED + 1))
  fi
}

run_check "$CHECKS_DIR/01-build-clean.sh"      "L1: build clean"
run_check "$CHECKS_DIR/02-services-up.sh"      "L2: services up"
run_check "$CHECKS_DIR/03-indexer-empty.sh"    "L3: indexer (empty silo)"
run_check "$CHECKS_DIR/04-search-fixtures.sh"  "L4: search (synthetic corpus)"

echo
echo "════════════════════════════════════════════════════════════"
echo "  Result"
echo "════════════════════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo "════════════════════════════════════════════════════════════"

if [ "$FAILED" -eq 0 ]; then
  echo "  ALL PASS"
  exit 0
else
  echo "  $FAILED FAILED"
  exit 1
fi
