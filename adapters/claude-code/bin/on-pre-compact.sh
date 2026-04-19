#!/bin/bash
# the-brain — Claude Code PreCompact hook entry.
# Force-fires observe.sh so detail survives compaction. Fails open.

set -u

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

for cand in \
  "${CLAUDE_PLUGIN_ROOT}/on-pre-compact.js" \
  "${CLAUDE_PLUGIN_ROOT}/dist/on-pre-compact.js"; do
  if [[ -f "$cand" ]]; then exec node "$cand"; fi
done

if [[ -f "${CLAUDE_PLUGIN_ROOT}/src/on-pre-compact.ts" ]]; then
  exec npx --yes tsx "${CLAUDE_PLUGIN_ROOT}/src/on-pre-compact.ts"
fi

echo '{"suppressOutput":true}'
exit 0
