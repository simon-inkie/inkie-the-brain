#!/bin/bash
# greymatter — Claude Code Stop hook entry.
# Reads hook JSON on stdin, fires observe.sh out of band, exits 0.
# Fail-open: the agent never blocks on an observation pass failing.

set -u

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

HANDLER_JS="${CLAUDE_PLUGIN_ROOT}/dist/on-stop.js"
HANDLER_TS="${CLAUDE_PLUGIN_ROOT}/src/on-stop.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  echo '{"suppressOutput":true}'
  exit 0
fi
