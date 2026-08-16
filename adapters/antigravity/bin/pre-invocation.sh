#!/bin/bash
# the-brain — agy (Antigravity CLI) PreInvocation hook entry.
# Reads agy hook JSON on stdin, emits {"injectSteps":[...]} JSON to stdout.
# Exits 0 on every non-catastrophic path (fail-open — never block a model call).

set -u

# AGY_PLUGIN_ROOT is the adapter root. When invoked from a bundled dist
# layout it may be pre-set; when invoked from the repo, derive it from
# this script's location.
: "${AGY_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"
export AGY_PLUGIN_ROOT

# Candidate layouts, probed in order (mirrors the claude-code adapter):
#   1. <root>/pre-invocation.js          — bundled flat layout
#   2. <root>/dist/pre-invocation.js     — legacy nested layout
#   3. <root>/src/pre-invocation.ts      — dev mode (tsx)
for cand in \
  "${AGY_PLUGIN_ROOT}/pre-invocation.js" \
  "${AGY_PLUGIN_ROOT}/dist/pre-invocation.js"; do
  if [[ -f "$cand" ]]; then exec node "$cand"; fi
done

if [[ -f "${AGY_PLUGIN_ROOT}/src/pre-invocation.ts" ]]; then
  exec npx --yes tsx "${AGY_PLUGIN_ROOT}/src/pre-invocation.ts"
fi

# Fail-open: no injection if the handler is missing.
echo '{"injectSteps":[]}'
exit 0
