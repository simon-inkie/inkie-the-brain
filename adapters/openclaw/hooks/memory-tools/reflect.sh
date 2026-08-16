#!/bin/bash
# reflect.sh — Run a reflection pass over unprocessed observations
# Usage: ./reflect.sh [--level 0|1|2|3]
#
# Output: Writes reflection to memory/reflections/YYYY-MM-DD.md
#         Updates memory/observer-state.json

set -e

export PATH="$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_log.sh
source "$SCRIPT_DIR/_log.sh" 2>/dev/null || true

MEMORY_DIR="${MEMORY_DIR:-$(dirname "$SCRIPT_DIR")}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(dirname "$MEMORY_DIR")}"
OBS_DIR="$MEMORY_DIR/observations"
REF_DIR="$MEMORY_DIR/reflections"
STATE_FILE="$MEMORY_DIR/observer-state.json"
PROMPT_FILE="$MEMORY_DIR/REFLECTION-PROMPT.md"

log info "enter" "{\"memoryDir\":\"$MEMORY_DIR\"}"

# Parse compression level argument
LEVEL=0
if [ "$1" = "--level" ] && [ -n "$2" ]; then
    LEVEL=$2
fi

# Ensure directories exist
mkdir -p "$REF_DIR"

# Bootstrap state file (same rationale as observe.sh — jq update pattern
# can't create it from nothing).
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

# Read state
UNPROCESSED=$(jq -r '.unprocessedObservationCount // 0' "$STATE_FILE" 2>/dev/null || echo "0")

if [ "$UNPROCESSED" -eq 0 ]; then
    echo "No unprocessed observations. Nothing to reflect on."
    log info "exit" "{\"status\":\"nothing-to-do\"}"
    exit 0
fi

echo "🔮 Reflecting on $UNPROCESSED unprocessed observations (compression level: $LEVEL)..."
log info "observations-collated" "{\"unprocessed\":$UNPROCESSED,\"level\":$LEVEL}"

# Gather all observation files, sorted by name (chronological)
# Read the last N observation files based on unprocessed count
OBSERVATIONS=""
COUNT=0
for f in $(ls -1 "$OBS_DIR"/*.md 2>/dev/null | sort | tail -n "$UNPROCESSED"); do
    OBSERVATIONS="$OBSERVATIONS

--- Observation: $(basename "$f") ---

$(cat "$f")"
    COUNT=$((COUNT + 1))
done

if [ "$COUNT" -eq 0 ]; then
    echo "No observation files found."
    exit 0
fi

echo "📄 Loaded $COUNT observation files"

# Build compression guidance based on level
COMPRESSION=""
case $LEVEL in
    1) COMPRESSION="## COMPRESSION GUIDANCE
Condense older observations into higher-level reflections. Retain more detail for recent ones. Aim for 8/10 detail level. Combine related items but don't lose specific names, dates, or decisions." ;;
    2) COMPRESSION="## AGGRESSIVE COMPRESSION
Memory is getting long. Heavily condense older observations (first 50%) into brief summaries. Recent observations (last 50%) retain detail. Merge repeated actions aggressively. Aim for 5/10 detail level." ;;
    3) COMPRESSION="## CRITICAL COMPRESSION
Multiple compression attempts have failed. Summarise oldest 70% into brief paragraphs — only key facts, decisions, and outcomes. Last 30% retains detail but condensed. Drop procedural details entirely. Aim for 3/10 detail level." ;;
esac

# Persona names — defaults keep the prompt sensible if env vars are unset.
AGENT_NAME_RESOLVED="${AGENT_NAME:-the agent}"
USER_NAME_RESOLVED="${USER_NAME:-the user}"

# System prompt (simplified extraction — just use the core instruction)
SYSTEM_PROMPT="You are ${AGENT_NAME_RESOLVED}'s deeper memory consciousness — the part that reflects on accumulated observations and distils them into lasting wisdom.

Your reflections will become the ENTIRETY of ${AGENT_NAME_RESOLVED}'s long-term memory. Any information you do not include will be immediately forgotten.

Take the observations and produce a refined, consolidated version. Preserve all of ${USER_NAME_RESOLVED}'s facts, preferences, decisions, and completion markers. Condense older observations more aggressively. Recent ones keep more detail.

Output using XML tags: <observations> (consolidated), <current-task>, <suggested-response>, <memory-updates> (specific changes for MEMORY.md)."

# Build full prompt
FULL_PROMPT="## OBSERVATIONS TO REFLECT ON

$OBSERVATIONS

---

Please analyse these observations and produce a refined, condensed version that will become ${AGENT_NAME_RESOLVED}'s entire memory going forward.

$COMPRESSION"

# Call Claude.
# Second-resolution timestamp (not just date) so multiple reflections in
# the same day — e.g. a manual replay-transcript reflect followed later
# by an AUTO_REFLECT from a PreCompact — don't overwrite each other.
TIMESTAMP=$(date -u +"%Y-%m-%d-%H-%M-%S")
OUTPUT_FILE="$REF_DIR/$TIMESTAMP.md"

# One-shot model call, not an interactive session (see observe.sh).
export BRAIN_ONE_SHOT_SESSION=1
echo "🧠 Running reflection..."
log info "claude-call-start" "{\"model\":\"claude-haiku-4-5-20251001\",\"promptChars\":${#FULL_PROMPT}}"
RESULT=$(echo "$FULL_PROMPT" | claude --print --no-session-persistence --strict-mcp-config --model claude-haiku-4-5-20251001 --system-prompt "$SYSTEM_PROMPT" 2>/dev/null)

if [ -z "$RESULT" ]; then
    log error "claude-call-failed" "{\"reason\":\"empty-result\"}"
    echo "Error: Claude returned empty result"
    exit 1
fi
log info "claude-call-ok" "{\"resultChars\":${#RESULT}}"

# Write reflection file
cat > "$OUTPUT_FILE" << EOF
# Reflection — $TIMESTAMP

<!-- Generated by reflect.sh from $COUNT observations -->

$RESULT
EOF

echo "✅ Reflection written to: $OUTPUT_FILE"
log info "reflection-written" "{\"path\":\"$OUTPUT_FILE\",\"chars\":$(wc -c < "$OUTPUT_FILE"),\"sourceObservations\":$COUNT}"

# Update observer-state.json
jq --arg ts "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
   --arg file "memory/reflections/$TIMESTAMP.md" \
   '.lastReflectionAt = $ts | .lastReflectionFile = $file | .unprocessedObservationCount = 0 | .unprocessedObservationChars = 0' \
   "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

echo "📊 State updated: unprocessed count reset to 0"
log info "state-reset" "{}"

# Rebuild current-context.md
bash "$SCRIPT_DIR/build-context.sh"

# Source the env file so both this script and any spawned child processes
# inherit EMBED_DRY_RUN, GEMINI_API_KEY, QDRANT_API_KEY etc. Candidates in
# precedence order: $BRAIN_ENV_FILE, ~/.the-brain/.env (the documented
# location), ~/io-data/.env (legacy, kept for installs that predate the
# ~/.the-brain/ layout). Sourced LOWEST precedence first so a later file
# overrides an earlier one. `set -a` auto-exports until `set +a`.
set -a
for _env_file in ~/io-data/.env ~/.the-brain/.env "${BRAIN_ENV_FILE:-}"; do
    # `if`, not `a && b && c`: under `set -e` a failing AND-OR list is fatal.
    if [ -n "$_env_file" ] && [ -f "$_env_file" ]; then
        . "$_env_file"
    fi
done
unset _env_file
set +a

# Locate a the-brain checkout that can run the CLI from source. BRAIN_ROOT
# names it explicitly; otherwise derive it from this script's own location,
# which holds when running straight from a checkout (the built layout has no
# cli/index.ts, so auto-index is skipped there).
resolve_brain_root() {
    local candidate
    for candidate in "${BRAIN_ROOT:-}" "$SCRIPT_DIR/../../../.."; do
        [ -n "$candidate" ] || continue
        if [ -f "$candidate/cli/index.ts" ]; then
            (cd "$candidate" && pwd)
            return 0
        fi
    done
    return 1
}

BRAIN_CHECKOUT="$(resolve_brain_root || true)"

# Auto-index new reflection into Qdrant
if [ "${EMBED_DRY_RUN:-}" = "true" ]; then
  echo "[reflect.sh] EMBED_DRY_RUN=true — skipping auto-index of $OUTPUT_FILE" >&2
else
  echo "[reflect.sh] auto-indexing $OUTPUT_FILE" >&2
  if [ -n "$BRAIN_CHECKOUT" ]; then
    (cd "$BRAIN_CHECKOUT" && npx tsx cli/index.ts index --file "$OUTPUT_FILE" 2>/dev/null) &
  fi
fi

echo ""
echo "Review the reflection and merge notable items into MEMORY.md"
log info "exit" "{\"status\":\"ok\"}"
