#!/bin/bash
# the-brain — agy (Antigravity CLI) Stop hook entry.
# Reads agy hook JSON on stdin, fires the observe pipeline + the turn-end
# MEMORY.md refresh out of band, exits 0. Fail-open: the agent never blocks
# on an observation pass failing.

set -u

: "${AGY_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"
export AGY_PLUGIN_ROOT

for cand in \
  "${AGY_PLUGIN_ROOT}/observe-agy.js" \
  "${AGY_PLUGIN_ROOT}/dist/observe-agy.js"; do
  if [[ -f "$cand" ]]; then exec node "$cand"; fi
done

if [[ -f "${AGY_PLUGIN_ROOT}/src/observe-agy.ts" ]]; then
  exec npx --yes tsx "${AGY_PLUGIN_ROOT}/src/observe-agy.ts"
fi

echo '{}'
exit 0
