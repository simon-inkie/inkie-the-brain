#!/bin/bash
# greymatter — Claude Code UserPromptSubmit hook entry.
# Reads hook JSON on stdin, emits additionalContext JSON to stdout.
# Exits 0 on every non-catastrophic path (fail-open — never block prompts).

set -u

# CLAUDE_PLUGIN_ROOT is only set when installed as a Claude Code plugin.
# When invoked directly from settings.json, derive root from this script's
# location: bin/user-prompt-submit.sh → plugin root is one level up.
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

HANDLER_JS="${CLAUDE_PLUGIN_ROOT}/dist/user-prompt-submit.js"
HANDLER_TS="${CLAUDE_PLUGIN_ROOT}/src/user-prompt-submit.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  # Fail open: empty additionalContext if handler is missing.
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""}}
EOF
  exit 0
fi
