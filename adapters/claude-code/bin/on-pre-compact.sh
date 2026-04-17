#!/bin/bash
# greymatter — Claude Code PreCompact hook entry.
# Force-fires observe.sh so detail survives compaction. Fails open.

set -u

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

HANDLER_JS="${CLAUDE_PLUGIN_ROOT}/dist/on-pre-compact.js"
HANDLER_TS="${CLAUDE_PLUGIN_ROOT}/src/on-pre-compact.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  echo '{"suppressOutput":true}'
  exit 0
fi
