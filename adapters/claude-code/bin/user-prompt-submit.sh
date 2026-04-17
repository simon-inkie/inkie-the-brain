#!/bin/bash
# greymatter — Claude Code UserPromptSubmit hook entry.
# Reads hook JSON on stdin, emits additionalContext JSON to stdout.
# Exits 0 on every non-catastrophic path (fail-open — never block prompts).

set -u

# CLAUDE_PLUGIN_ROOT is set by Claude Code when installed as a plugin.
# When invoked directly from settings.json, derive root from this script.
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

# Candidate layouts, probed in order:
#   1. <root>/user-prompt-submit.js          — bundled flat layout (dist/claude-code/)
#   2. <root>/dist/user-prompt-submit.js     — legacy nested layout
#   3. <root>/src/user-prompt-submit.ts      — dev mode (tsx)
for cand in \
  "${CLAUDE_PLUGIN_ROOT}/user-prompt-submit.js" \
  "${CLAUDE_PLUGIN_ROOT}/dist/user-prompt-submit.js"; do
  if [[ -f "$cand" ]]; then exec node "$cand"; fi
done

if [[ -f "${CLAUDE_PLUGIN_ROOT}/src/user-prompt-submit.ts" ]]; then
  exec npx --yes tsx "${CLAUDE_PLUGIN_ROOT}/src/user-prompt-submit.ts"
fi

# Fail-open: empty additionalContext if handler is missing.
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""}}
EOF
exit 0
