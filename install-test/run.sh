#!/usr/bin/env bash
# Install-test entry point. Runs four checks in order, prints a pass/fail
# matrix at the end, exits 0 if all pass and 1 if any fail.
#
# Each check is a self-contained script under /opt/install-test/checks/.
# Checks emit their own ✓/✗ lines while running; this script aggregates.
#
# Workspace handling: the repo is bind-mounted read-only at /workspace.
# We git-clone from there into /tmp/work (mirroring "user clones the repo")
# and run all checks from /tmp/work. Host /workspace stays pristine.

set -uo pipefail

CHECKS_DIR="/opt/install-test/checks"
SOURCE="${SOURCE:-/workspace}"
WORKSPACE=$(mktemp -d /tmp/the-brain-work-XXXX)
RESULTS=()
FAILED=0

trap 'rm -rf "$WORKSPACE"' EXIT

echo "════════════════════════════════════════════════════════════"
echo "  the-brain — install-test"
echo "  source:    $SOURCE (read-only bind mount)"
echo "  workspace: $WORKSPACE (fresh clone, ephemeral)"
echo "  qdrant:    ${QDRANT_URL:-not set}"
echo "  gemini:    $([ -n "${GEMINI_API_KEY:-}" ] && echo 'set' || echo 'NOT SET — L2/L3/L4 will skip')"
echo "════════════════════════════════════════════════════════════"
echo

# Clone the repo from the read-only bind mount into the ephemeral workspace.
# `git clone <local-path> <dest>` only copies tracked files — node_modules/
# and dist/ on the host are NOT pulled in, so the test starts from a fresh
# clone-shaped checkout the same way a user would.
#
# `safe.directory='*'` is needed because the bind-mounted repo's files are
# owned by the host UID, not the container's root — git's ownership-check
# trips on that otherwise. The * wildcard is appropriate here because we
# fully trust the bind-mounted source by definition.
echo "── prep: clone $SOURCE → $WORKSPACE ──"
git config --global --add safe.directory "$SOURCE"
git config --global --add safe.directory "$SOURCE/.git"
#
# --no-hardlinks: git's default --local clone mode hardlinks individual loose
# objects from the source. If the source repo just ran `git gc` (auto-pack on
# commit), most objects are now in pack files, not loose — and the hardlink
# attempt fails with a confusing "No such file or directory" on the loose path.
# --no-hardlinks forces a proper copy that reads pack files correctly.
git clone --no-hardlinks --quiet "$SOURCE" "$WORKSPACE" 2>&1 | sed 's/^/    /' || {
  echo "    ✗ clone failed"
  exit 1
}
echo "    ✓ cloned ($(git -C "$WORKSPACE" log --oneline -1))"
echo

export WORKSPACE  # checks read this

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
