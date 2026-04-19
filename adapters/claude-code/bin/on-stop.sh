#!/bin/bash
# the-brain — Claude Code Stop hook entry.
# Reads hook JSON on stdin, fires observe.sh out of band, exits 0.
# Fail-open: the agent never blocks on an observation pass failing.

set -u

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

for cand in \
  "${CLAUDE_PLUGIN_ROOT}/on-stop.js" \
  "${CLAUDE_PLUGIN_ROOT}/dist/on-stop.js"; do
  if [[ -f "$cand" ]]; then exec node "$cand"; fi
done

if [[ -f "${CLAUDE_PLUGIN_ROOT}/src/on-stop.ts" ]]; then
  exec npx --yes tsx "${CLAUDE_PLUGIN_ROOT}/src/on-stop.ts"
fi

echo '{"suppressOutput":true}'
exit 0
