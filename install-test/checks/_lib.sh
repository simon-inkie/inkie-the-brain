# Shared helpers for install-test checks. Source from each check script:
#   source "$(dirname "$0")/_lib.sh"

# run_step LABEL CMD ARGS... — capture full output to a temp file, show last
# 3 lines on success and last 40 lines on failure. Returns the underlying exit
# code so the caller's `set -e` / explicit-exit semantics still apply.
#
# This is the workhorse for surfacing failure context. The earlier pattern
# (`cmd 2>&1 | tail -3`) hid root causes when commands crashed with multi-line
# stack traces — only the bottom three frames survived.
run_step() {
  local label="$1"
  shift
  local log
  log=$(mktemp)
  echo "  $label"
  if "$@" >"$log" 2>&1; then
    tail -3 "$log" | sed 's/^/    /'
    rm -f "$log"
    return 0
  else
    local rc=$?
    echo "    ✗ failed (exit $rc) — last 40 lines:"
    tail -40 "$log" | sed 's/^/    /'
    rm -f "$log"
    return "$rc"
  fi
}
