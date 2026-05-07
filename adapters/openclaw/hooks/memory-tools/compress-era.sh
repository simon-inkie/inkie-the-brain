#!/bin/bash
# compress-era.sh — Regenerate memory/era-summary.md by fusing the existing
# era summary with newly-aging reflections.
#
# Usage:
#   compress-era.sh <level> <new-reflections-input>
#
# Where:
#   <level>                   0-3 (compression intensity, see memory/prompts/)
#   <new-reflections-input>   Either a single .md file OR a directory of .md
#                             files OR a glob pattern. Concatenated in name
#                             (chronological) order.
#
# Reads:
#   memory/era-summary.md             — current consolidated narrative (may be empty)
#   memory/prompts/compress-era-level-<N>.md — system prompt at the requested level
#   <new-reflections-input>           — reflection(s) to fold in
#
# Writes:
#   memory/era-summary.md       — new consolidated narrative
#   memory/era-summary.meta.json — { level, updatedAt, coverageLatestReflectionDate,
#                                   sourceReflectionCount, charCount }
#
# Calls Claude Haiku 4.5 via the `claude` CLI in print mode (matches reflect.sh
# pattern). Synchronous — caller MUST wait for this to return.
#
# Exit codes:
#   0  success
#   1  bad arguments
#   2  prompt file missing
#   3  model call failed (will leave era-summary.md unchanged)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_log.sh
source "$SCRIPT_DIR/_log.sh" 2>/dev/null || true

export BRAIN_COMPONENT="compress-era.sh"

MEMORY_DIR="${MEMORY_DIR:-$(dirname "$SCRIPT_DIR")}"
ERA_FILE="$MEMORY_DIR/era-summary.md"

log info "enter" "{\"memoryDir\":\"$MEMORY_DIR\"}"
META_FILE="$MEMORY_DIR/era-summary.meta.json"
PROMPTS_DIR="$MEMORY_DIR/prompts"

# --- Argument parsing ---

if [ $# -lt 2 ]; then
    echo "Usage: $0 <level> <new-reflections-input>" >&2
    echo "  <level>                  0-3" >&2
    echo "  <new-reflections-input>  file, directory, or glob" >&2
    exit 1
fi

LEVEL="$1"
NEW_INPUT="$2"

case "$LEVEL" in
    0|1|2|3) ;;
    *) echo "Error: level must be 0-3, got '$LEVEL'" >&2; exit 1 ;;
esac

PROMPT_FILE="$PROMPTS_DIR/compress-era-level-${LEVEL}.md"
if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: prompt file not found: $PROMPT_FILE" >&2
    exit 2
fi

# --- Gather inputs ---

# Current era summary (may be empty)
CURRENT_ERA=""
if [ -f "$ERA_FILE" ]; then
    CURRENT_ERA="$(cat "$ERA_FILE")"
fi

# New reflections — concat in lexical (= chronological) order
NEW_MATERIAL=""
NEW_COUNT=0
LATEST_REFLECTION_DATE=""

# Build a list of files from the input arg
FILES=()
if [ -d "$NEW_INPUT" ]; then
    while IFS= read -r f; do
        FILES+=("$f")
    done < <(find -L "$NEW_INPUT" -maxdepth 1 -type f -name '*.md' | sort)
elif [ -f "$NEW_INPUT" ]; then
    FILES+=("$NEW_INPUT")
else
    # Treat as glob
    while IFS= read -r f; do
        [ -f "$f" ] && FILES+=("$f")
    done < <(compgen -G "$NEW_INPUT" 2>/dev/null || true)
fi

if [ ${#FILES[@]} -eq 0 ]; then
    echo "Warning: no new reflection files found at '$NEW_INPUT' — nothing to compress" >&2
    exit 0
fi

for f in "${FILES[@]}"; do
    BASENAME="$(basename "$f" .md)"
    NEW_MATERIAL="${NEW_MATERIAL}

--- Reflection: ${BASENAME} ---

$(cat "$f")"
    NEW_COUNT=$((NEW_COUNT + 1))
    # Extract YYYY-MM-DD prefix from basename for coverage tracking
    if [[ "$BASENAME" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
        LATEST_REFLECTION_DATE="${BASH_REMATCH[1]}"
    fi
done

# --- Build the user prompt ---

USER_PROMPT="## Existing era summary

${CURRENT_ERA:-(empty — this is the first era summary)}

## New material to absorb (${NEW_COUNT} reflection(s))

${NEW_MATERIAL}

---

Return ONLY the new consolidated era summary. No preamble, no explanation."

SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"

# Substitute persona placeholders ({USER_NAME}, {AGENT_NAME}). Defaults
# keep prompts sensible if env vars are unset (fresh OSS install).
USER_NAME_RESOLVED="${USER_NAME:-the user}"
AGENT_NAME_RESOLVED="${AGENT_NAME:-the agent}"
SYSTEM_PROMPT=${SYSTEM_PROMPT//\{USER_NAME\}/$USER_NAME_RESOLVED}
SYSTEM_PROMPT=${SYSTEM_PROMPT//\{AGENT_NAME\}/$AGENT_NAME_RESOLVED}

# --- Call the model ---

echo "🗜️  compress-era: level=$LEVEL, absorbing $NEW_COUNT reflection(s), latest=$LATEST_REFLECTION_DATE" >&2

# Use a temp file so the rare empty/error result doesn't clobber era-summary.md
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT

if ! echo "$USER_PROMPT" | claude --print --strict-mcp-config --model claude-haiku-4-5-20251001 --system-prompt "$SYSTEM_PROMPT" > "$TMP_OUT" 2>/dev/null; then
    echo "Error: claude CLI failed" >&2
    exit 3
fi

if [ ! -s "$TMP_OUT" ]; then
    echo "Error: claude returned empty result, leaving era-summary.md unchanged" >&2
    exit 3
fi

# --- Atomically write outputs ---

mv "$TMP_OUT" "$ERA_FILE"
trap - EXIT  # cancel cleanup; mv consumed the file

NEW_CHAR_COUNT=$(wc -c < "$ERA_FILE")
UPDATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Write meta.json (using jq for safety against shell-escape issues)
jq -n \
    --argjson level "$LEVEL" \
    --arg updatedAt "$UPDATED_AT" \
    --arg coverageLatestReflectionDate "$LATEST_REFLECTION_DATE" \
    --argjson sourceReflectionCount "$NEW_COUNT" \
    --argjson charCount "$NEW_CHAR_COUNT" \
    '{level: $level, updatedAt: $updatedAt, coverageLatestReflectionDate: $coverageLatestReflectionDate, sourceReflectionCount: $sourceReflectionCount, charCount: $charCount}' \
    > "$META_FILE"

echo "✅ era-summary.md regenerated (level=$LEVEL, ${NEW_CHAR_COUNT} chars, covers through ${LATEST_REFLECTION_DATE})" >&2
