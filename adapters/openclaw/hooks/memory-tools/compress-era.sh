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
ERA_SUMMARY_MAX_BYTES="${ERA_SUMMARY_MAX_BYTES:-12000}"
ERA_SUMMARY_CAP_PASSES="${ERA_SUMMARY_CAP_PASSES:-3}"
CAP_PROMPT_FILE="$PROMPTS_DIR/compress-era-cap.md"
# Max reflections folded into a single Haiku call. A first/fresh build on a
# large corpus (e.g. 218 elders ≈ 260K tokens) blows Haiku's 200K window in one
# shot, so we fold in batches, accumulating the summary forward. The common lazy
# path (1–3 newly-aged elders) is one batch = one call = no behaviour change.
ERA_COMPRESS_BATCH_SIZE="${ERA_COMPRESS_BATCH_SIZE:-30}"

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

# New reflections — folded in lexical (= chronological) order, batched.
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
    NEW_COUNT=$((NEW_COUNT + 1))
    # Extract YYYY-MM-DD prefix from basename for coverage tracking
    if [[ "$BASENAME" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
        LATEST_REFLECTION_DATE="${BASH_REMATCH[1]}"
    fi
done

SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"

# Substitute persona placeholders ({USER_NAME}, {AGENT_NAME}). Defaults keep
# the prompt sensible if the env vars are unset (a fresh install).
USER_NAME_RESOLVED="${USER_NAME:-the user}"
AGENT_NAME_RESOLVED="${AGENT_NAME:-the agent}"
SYSTEM_PROMPT=${SYSTEM_PROMPT//\{USER_NAME\}/$USER_NAME_RESOLVED}
SYSTEM_PROMPT=${SYSTEM_PROMPT//\{AGENT_NAME\}/$AGENT_NAME_RESOLVED}

# --- Fuse one batch ---
# $1 = existing era summary text; remaining args = reflection files to absorb.
# Builds the user prompt and calls Haiku, writing the candidate summary to the
# global $FUSE_OUT. Returns 0 on success, 3 on model failure / empty result.
fuse_batch() {
    local existing="$1"; shift
    local material="" bn
    for bf in "$@"; do
        bn="$(basename "$bf" .md)"
        material="${material}

--- Reflection: ${bn} ---

$(cat "$bf")"
    done

    local prompt="## Existing era summary

${existing:-(empty — this is the first era summary)}

## New material to absorb ($# reflection(s))

${material}

---

Return ONLY the new consolidated era summary. No preamble, no explanation."

    export BRAIN_ONE_SHOT_SESSION=1
    if ! echo "$prompt" | claude --print --no-session-persistence --strict-mcp-config --model claude-haiku-4-5-20251001 --system-prompt "$SYSTEM_PROMPT" > "$FUSE_OUT" 2>/dev/null; then
        return 3
    fi
    [ -s "$FUSE_OUT" ] || return 3
    return 0
}

# --- Fold the reflections in batches ---
# Folding (not one giant call) keeps every Haiku call under the 200K window even
# for a fresh build on a large corpus. Each batch's consolidated summary becomes
# the "existing" summary fed to the next batch. ERA_FILE is not touched until the
# whole fold + cap loop succeeds (atomic mv at the end), so a mid-fold failure
# leaves the prior era-summary.md intact (fail-open).

echo "🗜️  compress-era: level=$LEVEL, absorbing $NEW_COUNT reflection(s) in batches of $ERA_COMPRESS_BATCH_SIZE, latest=$LATEST_REFLECTION_DATE" >&2

TMP_OUT="$(mktemp)"
FUSE_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT" "$FUSE_OUT"' EXIT

ACCUM="$CURRENT_ERA"
TOTAL=${#FILES[@]}
OFFSET=0
BATCH_NUM=0
while [ "$OFFSET" -lt "$TOTAL" ]; do
    BATCH_NUM=$((BATCH_NUM + 1))
    BATCH=("${FILES[@]:OFFSET:ERA_COMPRESS_BATCH_SIZE}")
    if [ "$TOTAL" -gt "$ERA_COMPRESS_BATCH_SIZE" ]; then
        echo "  batch $BATCH_NUM: folding ${#BATCH[@]} reflection(s) (offset $OFFSET/$TOTAL)…" >&2
    fi
    if ! fuse_batch "$ACCUM" "${BATCH[@]}"; then
        echo "Error: claude CLI failed on batch $BATCH_NUM, leaving era-summary.md unchanged" >&2
        exit 3
    fi
    ACCUM="$(cat "$FUSE_OUT")"
    OFFSET=$((OFFSET + ERA_COMPRESS_BATCH_SIZE))
done

printf '%s\n' "$ACCUM" > "$TMP_OUT"
rm -f "$FUSE_OUT"
# Restore the single-file cleanup trap the cap loop below expects.
trap 'rm -f "$TMP_OUT"' EXIT

# --- Byte-cap re-distill loop ---
# If the fusion candidate exceeds ERA_SUMMARY_MAX_BYTES, feed it back through
# Haiku (cap-distill prompt) for up to ERA_SUMMARY_CAP_PASSES passes.
# Fail-open: a Haiku error or empty result keeps the best candidate so far;
# still-over-cap after K passes also accepts best result. Never truncates.

CAP_BYTES=$(wc -c < "$TMP_OUT")
if [ "$CAP_BYTES" -gt "$ERA_SUMMARY_MAX_BYTES" ]; then
    if [ ! -f "$CAP_PROMPT_FILE" ]; then
        log warn "cap-no-prompt" "{\"bytes\":$CAP_BYTES,\"cap\":$ERA_SUMMARY_MAX_BYTES}"
        echo "  ⚠️  compress-era: cap exceeded (${CAP_BYTES} bytes > ${ERA_SUMMARY_MAX_BYTES}) but $CAP_PROMPT_FILE not found — skipping cap loop (fail-open)" >&2
    else
        log info "cap-check" "{\"bytes\":$CAP_BYTES,\"cap\":$ERA_SUMMARY_MAX_BYTES}"
        echo "⚠️  compress-era: candidate is ${CAP_BYTES} bytes (cap=${ERA_SUMMARY_MAX_BYTES}), starting re-distill loop" >&2

        BEST_OUT="$(mktemp)"
        # Update trap to clean up both temp files
        trap 'rm -f "$TMP_OUT" "$BEST_OUT"' EXIT
        cp "$TMP_OUT" "$BEST_OUT"

        # Build the cap-distill system prompt (substitute {target} placeholder)
        CAP_SYSTEM_PROMPT="$(sed "s/{target}/${ERA_SUMMARY_MAX_BYTES}/g" "$CAP_PROMPT_FILE")"

        CAP_PASS=0
        while [ "$CAP_PASS" -lt "$ERA_SUMMARY_CAP_PASSES" ]; do
            CAP_PASS=$((CAP_PASS + 1))
            CURRENT_BYTES=$(wc -c < "$BEST_OUT")
            if [ "$CURRENT_BYTES" -le "$ERA_SUMMARY_MAX_BYTES" ]; then
                break
            fi

            log info "cap-pass" "{\"pass\":$CAP_PASS,\"bytes\":$CURRENT_BYTES}"
            echo "  pass $CAP_PASS/${ERA_SUMMARY_CAP_PASSES}: ${CURRENT_BYTES} bytes → re-distilling…" >&2

            CAP_TMP="$(mktemp)"

            set +e
            cat "$BEST_OUT" | claude --print --no-session-persistence --strict-mcp-config --model claude-haiku-4-5-20251001 --system-prompt "$CAP_SYSTEM_PROMPT" > "$CAP_TMP" 2>/dev/null
            CLAUDE_EXIT=$?
            set -e

            CAP_TMP_SIZE=$(wc -c < "$CAP_TMP" 2>/dev/null || echo 0)
            if [ "$CLAUDE_EXIT" -ne 0 ] || [ "$CAP_TMP_SIZE" -eq 0 ]; then
                log warn "cap-pass-failed" "{\"pass\":$CAP_PASS,\"exitCode\":$CLAUDE_EXIT,\"outputBytes\":$CAP_TMP_SIZE}"
                echo "  ⚠️  pass $CAP_PASS failed (exit=$CLAUDE_EXIT, bytes=$CAP_TMP_SIZE) — keeping best so far, stopping loop" >&2
                rm -f "$CAP_TMP"
                break
            fi

            mv "$CAP_TMP" "$BEST_OUT"
        done

        FINAL_BYTES=$(wc -c < "$BEST_OUT")
        if [ "$FINAL_BYTES" -gt "$ERA_SUMMARY_MAX_BYTES" ]; then
            log warn "cap-over" "{\"bytes\":$FINAL_BYTES,\"cap\":$ERA_SUMMARY_MAX_BYTES,\"passes\":$CAP_PASS}"
            echo "  ⚠️  compress-era: still ${FINAL_BYTES} bytes after ${CAP_PASS} pass(es) (cap=${ERA_SUMMARY_MAX_BYTES}) — accepting best result (fail-open)" >&2
        else
            echo "  ✅ compress-era: cap satisfied at ${FINAL_BYTES} bytes after ${CAP_PASS} pass(es)" >&2
        fi

        mv "$BEST_OUT" "$TMP_OUT"
        # Restore single-file cleanup trap
        trap 'rm -f "$TMP_OUT"' EXIT
    fi
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
