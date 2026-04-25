#!/bin/bash
# build-context.sh — Rebuild MEMORY.md's IO_LIVE block as a bounded three-zone view.
#
# Three zones, oldest → newest, top → bottom:
#   1. Era Summary       — fused narrative of reflections older than the hot zone
#                          (compressed by compress-era.sh at level 0–3 under
#                          budget pressure). Stored in memory/era-summary.md.
#   2. Recent Reflections — last K reflections verbatim. K = hotReflectionCount.
#   3. Unprocessed Observations — bullets from observation files newer than
#                          the latest reflection's mtime.
#
# This script's only modification to MEMORY.md is the replacement of bytes
# between <!-- IO_LIVE_START --> and <!-- IO_LIVE_END --> markers. Everything
# outside the markers is owned by other writers (e.g. OpenClaw gateway) and
# is preserved byte-for-byte. This is a permanent runtime concurrency contract,
# not a one-shot dev guarantee.
#
# Atomic against concurrent invocations of itself via flock on memory/.live-block.lock.
#
# Called automatically by observe.sh and reflect.sh; can also be invoked manually.
# Spec: io-memory-engine.spec.md §2A.

set -euo pipefail
export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_log.sh
source "$SCRIPT_DIR/_log.sh" 2>/dev/null || true

# Override any inherited BRAIN_COMPONENT (e.g. from observe.sh parent) so
# our log entries are correctly tagged.
export BRAIN_COMPONENT="build-context.sh"

MEMORY_DIR="${MEMORY_DIR:-$(dirname "$SCRIPT_DIR")}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(dirname "$MEMORY_DIR")}"

log info "enter" "{\"memoryDir\":\"$MEMORY_DIR\"}"
OBS_DIR="$MEMORY_DIR/observations"
REF_DIR="$MEMORY_DIR/reflections"
ERA_FILE="$MEMORY_DIR/era-summary.md"
LIVE_STATE_FILE="$MEMORY_DIR/live-state.json"
MEMORY_FILE="$WORKSPACE_DIR/MEMORY.md"
LOCK_FILE="$MEMORY_DIR/.live-block.lock"
COMPRESS_ERA="$SCRIPT_DIR/compress-era.sh"

ANCHOR_START="<!-- IO_LIVE_START -->"
ANCHOR_END="<!-- IO_LIVE_END -->"

# --- flock self-atomicity ---

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "build-context.sh: another instance is running, skipping" >&2
    exit 0
fi

# --- Sanity checks ---

if [ ! -f "$MEMORY_FILE" ]; then
    echo "Error: MEMORY.md not found at $MEMORY_FILE" >&2
    exit 1
fi

if ! grep -qF "$ANCHOR_START" "$MEMORY_FILE" || ! grep -qF "$ANCHOR_END" "$MEMORY_FILE"; then
    echo "Error: MEMORY.md is missing IO_LIVE_START/IO_LIVE_END anchors. Run the one-time anchor migration first." >&2
    exit 1
fi

if [ ! -f "$LIVE_STATE_FILE" ]; then
    echo "Error: live-state.json not found at $LIVE_STATE_FILE" >&2
    exit 1
fi

# --- Read live-state.json ---

read_state() {
    jq -r ".$1" "$LIVE_STATE_FILE"
}

write_state() {
    local key="$1"
    local value="$2"
    local is_string="${3:-false}"
    local tmp
    tmp="$(mktemp)"
    if [ "$is_string" = "true" ]; then
        jq --arg v "$value" ".$key = \$v" "$LIVE_STATE_FILE" > "$tmp"
    else
        jq --argjson v "$value" ".$key = \$v" "$LIVE_STATE_FILE" > "$tmp"
    fi
    mv "$tmp" "$LIVE_STATE_FILE"
}

HOT_K=$(read_state hotReflectionCount)
ERA_LEVEL=$(read_state eraCompressionLevel)
SOFT_BUDGET=$(read_state softBudgetChars)
HARD_BUDGET=$(read_state hardBudgetChars)
MIN_HOT=$(read_state minHotReflectionCount)
MAX_LEVEL=$(read_state maxEraCompressionLevel)
ERA_COVERAGE=$(read_state eraCoverageThroughReflectionDate)

# --- Gather reflections ---

REFLECTIONS=()
while IFS= read -r f; do
    REFLECTIONS+=("$f")
done < <(find "$REF_DIR" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)

REFL_COUNT=${#REFLECTIONS[@]}

# Slice into HOT (last K) and ELDER (everything older)
ELDER=()
HOT=()
if [ "$REFL_COUNT" -le "$HOT_K" ]; then
    HOT=("${REFLECTIONS[@]}")
else
    ELDER_COUNT=$((REFL_COUNT - HOT_K))
    ELDER=("${REFLECTIONS[@]:0:ELDER_COUNT}")
    HOT=("${REFLECTIONS[@]:ELDER_COUNT}")
fi

ELDER_COUNT=${#ELDER[@]}
HOT_COUNT=${#HOT[@]}

# --- Decide whether to (re)build the era summary ---
#
# Lazy path: a new reflection has aged out of the hot zone, i.e. ELDER's last
# entry is newer than what era-summary currently covers. Run compress-era.sh
# at the current level to fold the new ELDER tail into the existing era summary.
#
# First-run path: era-summary.md is empty, ELDER is non-empty, build from
# scratch at level 0.

ERA_NEEDS_REBUILD=false
ERA_REBUILD_REASON=""

if [ "$ELDER_COUNT" -gt 0 ]; then
    LATEST_ELDER_FILE="${ELDER[-1]}"
    LATEST_ELDER_BASENAME="$(basename "$LATEST_ELDER_FILE" .md)"
    LATEST_ELDER_DATE="${LATEST_ELDER_BASENAME:0:10}"

    if [ ! -s "$ERA_FILE" ]; then
        ERA_NEEDS_REBUILD=true
        ERA_REBUILD_REASON="era-summary.md is empty and there are $ELDER_COUNT elder reflections to absorb"
    elif [ "$ERA_COVERAGE" = "null" ] || [ -z "$ERA_COVERAGE" ]; then
        ERA_NEEDS_REBUILD=true
        ERA_REBUILD_REASON="era coverage is unknown"
    elif [[ "$LATEST_ELDER_DATE" > "$ERA_COVERAGE" ]]; then
        ERA_NEEDS_REBUILD=true
        ERA_REBUILD_REASON="latest elder reflection ($LATEST_ELDER_DATE) is newer than era coverage ($ERA_COVERAGE)"
    fi
fi

if [ "$ERA_NEEDS_REBUILD" = "true" ]; then
    echo "🗜️  Rebuilding era summary: $ERA_REBUILD_REASON" >&2

    # On first build / coverage-unknown, absorb ALL elders into the era.
    # On lazy update, only absorb the newly-aged-out reflections (those with
    # date > current coverage). Either way the existing era-summary.md is
    # passed as the "current" via compress-era.sh.
    NEW_ABSORB=()
    if [ -z "$ERA_COVERAGE" ] || [ "$ERA_COVERAGE" = "null" ] || [ ! -s "$ERA_FILE" ]; then
        NEW_ABSORB=("${ELDER[@]}")
    else
        for f in "${ELDER[@]}"; do
            BN="$(basename "$f" .md)"
            DT="${BN:0:10}"
            if [[ "$DT" > "$ERA_COVERAGE" ]]; then
                NEW_ABSORB+=("$f")
            fi
        done
    fi

    if [ ${#NEW_ABSORB[@]} -gt 0 ]; then
        # Pass the list as a temp directory of symlinks so compress-era.sh sees
        # exactly the files we want absorbed (not the entire reflections dir).
        ABSORB_DIR="$(mktemp -d)"
        for f in "${NEW_ABSORB[@]}"; do
            ln -s "$f" "$ABSORB_DIR/$(basename "$f")"
        done

        if "$COMPRESS_ERA" "$ERA_LEVEL" "$ABSORB_DIR"; then
            ERA_COVERAGE="$LATEST_ELDER_DATE"
            write_state eraCoverageThroughReflectionDate "$ERA_COVERAGE" true
        else
            echo "Warning: compress-era.sh failed; using stale era-summary.md" >&2
        fi

        rm -rf "$ABSORB_DIR"
    fi
fi

# --- Gather unprocessed observations (mtime > latest reflection mtime) ---

LATEST_REFL_MTIME=0
if [ "$REFL_COUNT" -gt 0 ]; then
    LATEST_REFL_MTIME=$(stat -c %Y "${REFLECTIONS[-1]}")
fi

UNPROCESSED_FILES=()
while IFS= read -r f; do
    UNPROCESSED_FILES+=("$f")
done < <(find "$OBS_DIR" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)

UNPROCESSED_NEW=()
for f in "${UNPROCESSED_FILES[@]}"; do
    F_MTIME=$(stat -c %Y "$f")
    if [ "$F_MTIME" -gt "$LATEST_REFL_MTIME" ]; then
        UNPROCESSED_NEW+=("$f")
    fi
done

UNPROCESSED_COUNT=${#UNPROCESSED_NEW[@]}

# --- Inbox section (file-per-correspondent DMs with symlink mirror) ---

LIVE_AGENTS=("io" "doctor2" "andor" "aldus" "hopkins")

render_inbox_section() {
    local agent_name="${AGENT_NAME:-}"
    [ -z "$agent_name" ] && return

    local agents_root="$HOME/.the-brain/agents"
    local my_inbox="$agents_root/$agent_name/inbox"
    mkdir -p "$my_inbox"

    # Self-heal symlink mirrors: if another agent has a thread file
    # naming me in their inbox, ensure I have a reverse symlink.
    for other in "${LIVE_AGENTS[@]}"; do
        [ "$other" = "$agent_name" ] && continue
        local their_file="$agents_root/$other/inbox/$agent_name.md"
        local my_link="$my_inbox/$other.md"
        if [ -f "$their_file" ] && [ ! -e "$my_link" ]; then
            ln -sfn "$their_file" "$my_link"
        fi
    done

    local total_new=0
    local threads_with_new=0
    local inbox_lines=""

    for thread_file in "$my_inbox"/*.md; do
        [ -f "$thread_file" ] || continue
        local correspondent
        correspondent="$(basename "$thread_file" .md)"

        local new_count=0
        local latest_ts="" latest_subject="" latest_from=""

        while IFS= read -r heading; do
            local msg_ts msg_from msg_subject
            msg_ts="$(printf '%s' "$heading" | sed -n 's/^## \([^ ]*\) .*/\1/p')"
            msg_from="$(printf '%s' "$heading" | sed -n 's/.*— from: \([^ ]*\) .*/\1/p')"
            msg_subject="$(printf '%s' "$heading" | sed -n 's/.*— subject: \(.*\)/\1/p')"

            [ -z "$msg_ts" ] && continue
            [ "$msg_from" = "$agent_name" ] && continue

            new_count=$((new_count + 1))
            latest_ts="$msg_ts"
            latest_subject="$msg_subject"
            latest_from="$msg_from"
        done < <(grep '^## [0-9].*— status: sent —' "$thread_file" 2>/dev/null)

        if [ "$new_count" -gt 0 ]; then
            total_new=$((total_new + new_count))
            threads_with_new=$((threads_with_new + 1))
            inbox_lines+="- 📩 from ${latest_from} — ${new_count} new, latest ${latest_ts}: \"${latest_subject}\""$'\n'
        fi
    done

    if [ "$total_new" -gt 0 ]; then
        local plural=""
        [ "$threads_with_new" -gt 1 ] && plural="s"
        printf '### 📬 Inbox (%d new across %d thread%s)\n\n%s' \
            "$total_new" "$threads_with_new" "$plural" "$inbox_lines"
    fi
}

mark_inbox_read() {
    local agent_name="${AGENT_NAME:-}"
    [ -z "$agent_name" ] && return

    local agents_root="$HOME/.the-brain/agents"
    local my_inbox="$agents_root/$agent_name/inbox"

    for thread_file in "$my_inbox"/*.md; do
        [ -f "$thread_file" ] || continue

        if ! grep -q '^## [0-9].*— status: sent —' "$thread_file" 2>/dev/null; then
            continue
        fi

        local real_path
        real_path="$(readlink -f "$thread_file")"
        local tmp
        tmp="$(mktemp)"

        awk -v agent="$agent_name" '{
            if ($0 ~ /^## [0-9].*— status: sent —/ && index($0, "— from: " agent " —") == 0) {
                sub(/— status: sent —/, "— status: read —")
            }
            print
        }' "$real_path" > "$tmp"

        if ! cmp -s "$tmp" "$real_path"; then
            mv "$tmp" "$real_path"
        else
            rm -f "$tmp"
        fi
    done
}

# --- Assemble the three-zone block ---

assemble_block() {
    local block=""
    block+="$ANCHOR_START"$'\n'
    block+="## 🧠 Live Observation Context"$'\n'
    block+=$'\n'
    block+="> Auto-generated by build-context.sh — do not hand-edit this section. Edits are clobbered on the next observation. Edit memory/reflections/*.md or memory/era-summary.md instead."$'\n'
    block+="> **Current time: $(date +"%A %Y-%m-%d %H:%M %Z") ($(date -u +"%H:%M UTC"))** — treat dates in reflections below as historical unless they match this. (Live NOW above is fresher; trust it when in doubt.)"$'\n'
    block+="> era level=${ERA_LEVEL} · hot K=${HOT_K} · elders=${ELDER_COUNT} · unprocessed=${UNPROCESSED_COUNT}"$'\n'
    block+=$'\n'

    # Zone 0 — Inbox
    local inbox_section
    inbox_section="$(render_inbox_section)"
    if [ -n "$inbox_section" ]; then
        block+="$inbox_section"$'\n'
        block+=$'\n'
    fi

    # Zone 1 — Era Summary
    block+="### Era Summary (compressed, level ${ERA_LEVEL})"$'\n'
    block+="<!-- Covers reflections older than the hot zone. Regenerated by compress-era.sh. -->"$'\n'
    block+=$'\n'
    if [ -s "$ERA_FILE" ]; then
        block+="$(cat "$ERA_FILE")"$'\n'
    elif [ "$ELDER_COUNT" -eq 0 ]; then
        block+="_No elder reflections yet — all reflections are in the hot zone below._"$'\n'
    else
        block+="_Era summary not yet built._"$'\n'
    fi
    block+=$'\n'

    # Zone 2 — Recent Reflections (verbatim, oldest → newest within the hot zone)
    block+="### Recent Reflections (last ${HOT_COUNT} verbatim, oldest first)"$'\n'
    block+=$'\n'
    if [ "$HOT_COUNT" -eq 0 ]; then
        block+="_No reflections yet._"$'\n'
        block+=$'\n'
    else
        for f in "${HOT[@]}"; do
            BN="$(basename "$f" .md)"
            block+="## Reflection (${BN})"$'\n'
            block+=$'\n'
            block+="$(cat "$f")"$'\n'
            block+=$'\n'
        done
    fi

    # Zone 3 — Unprocessed Observations
    if [ "$REFL_COUNT" -gt 0 ]; then
        LATEST_REFL_BN="$(basename "${REFLECTIONS[-1]}" .md)"
    else
        LATEST_REFL_BN="(none)"
    fi
    block+="### Unprocessed Observations (since ${LATEST_REFL_BN})"$'\n'
    block+=$'\n'
    if [ "$UNPROCESSED_COUNT" -eq 0 ]; then
        block+="_No new observations since the last reflection._"$'\n'
    else
        for f in "${UNPROCESSED_NEW[@]}"; do
            OBS_BN="$(basename "$f" .md)"
            block+="#### ${OBS_BN}"$'\n'
            block+=$'\n'
            block+="$(cat "$f")"$'\n'
            block+=$'\n'
        done
    fi

    block+="$ANCHOR_END"

    printf '%s' "$block"
}

BLOCK="$(assemble_block)"
BLOCK_INNER_CHARS=$(( ${#BLOCK} - ${#ANCHOR_START} - ${#ANCHOR_END} - 1 ))  # rough; for budget gating

# --- Budget escalation state machine (§2A.5) ---
#
# 1. If block_chars <= softBudget: ok
# 2. If over soft and level < max: escalate level, regenerate era, re-assemble, retry
# 3. If at max level and over hard: decrement hot count (>=minHot), absorb the
#    newly-bumped reflection into the era at max level, retry
# 4. If at min hot and max level and still over hard: accept and warn

ESCALATIONS=0
MAX_ESCALATIONS=8  # safety upper bound — level 0→3 + 3 hot decrements + slack

while true; do
    if [ "$BLOCK_INNER_CHARS" -le "$SOFT_BUDGET" ]; then
        break
    fi

    ESCALATIONS=$((ESCALATIONS + 1))
    if [ "$ESCALATIONS" -gt "$MAX_ESCALATIONS" ]; then
        echo "Warning: budget escalation hit safety bound at $ESCALATIONS attempts; accepting overage" >&2
        break
    fi

    if [ "$ERA_LEVEL" -lt "$MAX_LEVEL" ]; then
        ERA_LEVEL=$((ERA_LEVEL + 1))
        echo "💥 Block ${BLOCK_INNER_CHARS} > soft ${SOFT_BUDGET}; escalating era compression to level $ERA_LEVEL" >&2
        write_state eraCompressionLevel "$ERA_LEVEL"
        # Regenerate era at higher level using ALL elders
        if [ "$ELDER_COUNT" -gt 0 ]; then
            ABSORB_DIR="$(mktemp -d)"
            for f in "${ELDER[@]}"; do
                ln -s "$f" "$ABSORB_DIR/$(basename "$f")"
            done
            # Wipe era so compress-era treats this as a fresh build at the new level
            : > "$ERA_FILE"
            "$COMPRESS_ERA" "$ERA_LEVEL" "$ABSORB_DIR" || echo "Warning: compress-era.sh failed during escalation" >&2
            rm -rf "$ABSORB_DIR"
        fi
        BLOCK="$(assemble_block)"
        BLOCK_INNER_CHARS=$(( ${#BLOCK} - ${#ANCHOR_START} - ${#ANCHOR_END} - 1 ))
        continue
    fi

    # At max level — only escalate further by reducing hot zone
    if [ "$BLOCK_INNER_CHARS" -gt "$HARD_BUDGET" ] && [ "$HOT_K" -gt "$MIN_HOT" ]; then
        HOT_K=$((HOT_K - 1))
        echo "💥 Block ${BLOCK_INNER_CHARS} > hard ${HARD_BUDGET}; reducing hot K to $HOT_K" >&2
        write_state hotReflectionCount "$HOT_K"
        # Re-slice
        if [ "$REFL_COUNT" -le "$HOT_K" ]; then
            ELDER=()
            HOT=("${REFLECTIONS[@]}")
        else
            ELDER_COUNT=$((REFL_COUNT - HOT_K))
            ELDER=("${REFLECTIONS[@]:0:ELDER_COUNT}")
            HOT=("${REFLECTIONS[@]:ELDER_COUNT}")
        fi
        ELDER_COUNT=${#ELDER[@]}
        HOT_COUNT=${#HOT[@]}
        # Rebuild era at max level absorbing the new (larger) elder set
        ABSORB_DIR="$(mktemp -d)"
        for f in "${ELDER[@]}"; do
            ln -s "$f" "$ABSORB_DIR/$(basename "$f")"
        done
        : > "$ERA_FILE"
        "$COMPRESS_ERA" "$ERA_LEVEL" "$ABSORB_DIR" || echo "Warning: compress-era.sh failed during hot decrement" >&2
        rm -rf "$ABSORB_DIR"
        BLOCK="$(assemble_block)"
        BLOCK_INNER_CHARS=$(( ${#BLOCK} - ${#ANCHOR_START} - ${#ANCHOR_END} - 1 ))
        continue
    fi

    echo "Warning: live block ${BLOCK_INNER_CHARS} chars exceeds hard budget ${HARD_BUDGET} at minimum hot=${HOT_K} level=${ERA_LEVEL}; accepting overage" >&2
    break
done

# --- Splice the block into MEMORY.md between the anchors (atomic write) ---

splice_into_memory() {
    local memory_file="$1"
    local block="$2"
    local tmp block_file
    tmp="$(mktemp)"
    block_file="$(mktemp)"
    printf '%s\n' "$block" > "$block_file"

    # Use awk with the block read from a file via getline so we avoid -v's
    # backslash-escape interpretation of arbitrary block content.
    awk -v block_file="$block_file" -v start="$ANCHOR_START" -v end="$ANCHOR_END" '
        BEGIN {
            block = ""
            while ((getline line < block_file) > 0) {
                block = block (block == "" ? "" : "\n") line
            }
            close(block_file)
            in_block = 0
            printed = 0
        }
        {
            if ($0 == start) {
                if (!printed) { print block; printed = 1 }
                in_block = 1
                next
            }
            if ($0 == end) {
                in_block = 0
                next
            }
            if (!in_block) { print }
        }
    ' "$memory_file" > "$tmp"

    mv "$tmp" "$memory_file"
    rm -f "$block_file"
}

splice_into_memory "$MEMORY_FILE" "$BLOCK"

# --- Mark inbox messages as read (status: sent → read) ---
mark_inbox_read

# --- Update live-state.json with final metrics ---

write_state lastBlockCharCount "$BLOCK_INNER_CHARS"
write_state lastRebuildAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" true

echo "✅ MEMORY.md live block rebuilt: ${BLOCK_INNER_CHARS} chars · era level=${ERA_LEVEL} · hot=${HOT_COUNT}/${HOT_K} · unprocessed=${UNPROCESSED_COUNT}" >&2
log info "block-rebuilt" "{\"chars\":${BLOCK_INNER_CHARS},\"eraLevel\":${ERA_LEVEL},\"hot\":${HOT_COUNT},\"hotK\":${HOT_K},\"elders\":${ELDER_COUNT},\"unprocessed\":${UNPROCESSED_COUNT}}"
log info "exit" "{\"status\":\"ok\"}"
