#!/bin/bash
# build-context.sh - Rebuild MEMORY.md's IO_LIVE block as a bounded three-zone view.
#
# Three zones, oldest → newest, top → bottom:
#   1. Era Summary       - fused narrative of reflections older than the hot zone
#                          (compressed by compress-era.sh at level 0-3 under
#                          budget pressure). Stored in memory/era-summary.md.
#   2. Recent Reflections - last K reflections verbatim. K = hotReflectionCount.
#   3. Unprocessed Observations - bullets from observation files newer than
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

set -euo pipefail
export LC_ALL=C.UTF-8

# --- --emit mode (used by the agy adapter) ---
# With --emit the assembled three-zone block is printed to stdout and the
# script exits. Pure read of the memory state: no MEMORY.md splice, no era
# rebuild, no live-state writes. PreInvocation fires per MODEL CALL, so any
# mutation here would run many times a turn; era/budget maintenance stays with
# the splice path (observe.sh / reflect.sh). Default behaviour with the flag
# absent is byte-for-byte unchanged.
#
# --- --cached mode (observation cache-split) ---
# --cached is --emit (pure read, no splice / no era rebuild / no live-state
# write) PLUS one suppression that makes the block belong in the CACHED
# SessionStart prefix rather than the per-turn fresh zone: no "Current time:"
# wall-clock stamp, because NOW, the per-turn dynamic line, is the single
# source of current time and a frozen stamp here only invites the staleness
# misread. Implies EMIT_MODE so it rides the --emit dispatch.
#
# In --cached mode, Zone 2 (Recent Reflections) is assembled as budget-capped
# GISTs (first ~500 chars of each reflection, newest-first) rather than
# verbatim bodies. The total --cached output target is < 9,500 chars. Full
# reflection bodies remain on disk and are reachable via semantic recall.
# Budget priority: era (full) > unprocessed obs (full) > reflection gists.
EMIT_MODE=false
CACHED_MODE=false
for arg in "$@"; do
    case "$arg" in
        --emit) EMIT_MODE=true ;;
        --cached) EMIT_MODE=true; CACHED_MODE=true ;;
    esac
done

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

# --- flock self-atomicity (skipped in --emit mode: pure read, no contention) ---

if [ "$EMIT_MODE" != "true" ]; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        echo "build-context.sh: another instance is running, skipping" >&2
        exit 0
    fi
fi

# --- Sanity checks (--emit needs no MEMORY.md: it never splices) ---

if [ "$EMIT_MODE" != "true" ]; then
    if [ ! -f "$MEMORY_FILE" ]; then
        echo "Error: MEMORY.md not found at $MEMORY_FILE" >&2
        exit 1
    fi

    if ! grep -qF "$ANCHOR_START" "$MEMORY_FILE" || ! grep -qF "$ANCHOR_END" "$MEMORY_FILE"; then
        echo "Error: MEMORY.md is missing IO_LIVE_START/IO_LIVE_END anchors. Run the one-time anchor migration first." >&2
        exit 1
    fi
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

# Era rebuild writes era-summary.md + live-state.json - skipped in --emit
# mode (pure read; the splice path keeps the era fresh).
if [ "$ERA_NEEDS_REBUILD" = "true" ] && [ "$EMIT_MODE" != "true" ]; then
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

# --- Assemble the three-zone block ---
#
# In --cached mode, Zone 2 (Recent Reflections) is assembled as
# budget-capped gists instead of verbatim bodies. Budget priority:
#   1. Era Summary (full)
#   2. Unprocessed Observations (full)
#   3. Most-recent reflection gists, newest-first, until budget exhausted
# Target output < 9,500 chars. Full bodies remain on disk for recall.
#
# Helper: emit a gist (first GIST_MAX chars) of a reflection file.
# Args: $1=file $2=max_chars
reflection_gist() {
    local f="$1"
    local max_chars="$2"
    local full
    full="$(cat "$f")"
    local flen=${#full}
    if [ "$flen" -le "$max_chars" ]; then
        printf '%s' "$full"
    else
        printf '%s' "${full:0:$max_chars}"
        printf '\n[...gist truncated, full body via recall]'
    fi
}

CACHED_BUDGET="${CACHED_BUDGET:-9500}"
CACHED_GIST_MAX="${CACHED_GIST_MAX:-500}"
# Per-zone sub-budget for Unprocessed Observations. The zone
# is kept most-recent-first (newest obs entries retained, oldest dropped) up to
# this many chars; if anything is dropped a recall pointer is appended. Era +
# full unprocessed alone breached the total budget on busy days, so the zone is
# bounded here and the HARD total-cap (Layer 2, post-assembly) is the backstop.
CACHED_UNPROC_MAX="${CACHED_UNPROC_MAX:-2000}"

assemble_block() {
    local block=""
    block+="$ANCHOR_START"$'\n'
    block+="## 🧠 Live Observation Context"$'\n'
    block+=$'\n'
    block+="> Auto-generated by build-context.sh. Do not hand-edit this section. Edits are clobbered on the next observation. Edit memory/reflections/*.md or memory/era-summary.md instead."$'\n'
    if [ "$CACHED_MODE" != "true" ]; then
        block+="> **Current time: $(date +"%A %Y-%m-%d %H:%M %Z") ($(date -u +"%H:%M UTC"))**. Treat dates in reflections below as historical unless they match this. (Live NOW above is fresher; trust it when in doubt.)"$'\n'
    fi
    block+="> era level=${ERA_LEVEL} · hot K=${HOT_K} · elders=${ELDER_COUNT} · unprocessed=${UNPROCESSED_COUNT}"$'\n'
    block+=$'\n'

    # Zone 1 - Era Summary (always full, highest budget priority)
    block+="### Era Summary (compressed, level ${ERA_LEVEL})"$'\n'
    block+="<!-- Covers reflections older than the hot zone. Regenerated by compress-era.sh. -->"$'\n'
    block+=$'\n'
    if [ -s "$ERA_FILE" ]; then
        block+="$(cat "$ERA_FILE")"$'\n'
    elif [ "$ELDER_COUNT" -eq 0 ]; then
        block+="_No elder reflections yet; all reflections are in the hot zone below._"$'\n'
    else
        block+="_Era summary not yet built._"$'\n'
    fi
    block+=$'\n'

    if [ "$CACHED_MODE" = "true" ]; then
        # --cached mode: budget-capped gist assembly
        #
        # Zone order in --cached is era > unprocessed > reflections (highest to
        # lowest priority). That ordering is deliberate: the Layer-2 hard cap
        # (post-assembly, below) tail-truncates, so the lowest-priority content
        # (reflection gists) sits at the tail and is dropped first, then
        # unprocessed, with era (the head) preserved longest.
        #
        # Layer 1 - per-zone caps:
        #   - Era Summary: full (already appended above).
        #   - Unprocessed Observations: bounded to CACHED_UNPROC_MAX, MOST-
        #     RECENT-FIRST (newest entries kept, oldest dropped + recall pointer).
        #   - Recent Reflections: gists fill the budget remaining after era +
        #     capped-unprocessed.
        #
        # Step 1: build the CAPPED unprocessed-obs block (priority 2) so we can
        # measure it and reserve budget before adding reflections.
        if [ "$REFL_COUNT" -gt 0 ]; then
            LATEST_REFL_BN="$(basename "${REFLECTIONS[-1]}" .md)"
        else
            LATEST_REFL_BN="(none)"
        fi

        local obs_block=""
        obs_block+="### Unprocessed Observations (since ${LATEST_REFL_BN})"$'\n'
        obs_block+=$'\n'
        if [ "$UNPROCESSED_COUNT" -eq 0 ]; then
            obs_block+="_No new observations since the last reflection._"$'\n'
        else
            # Most-recent-first, char-bounded to CACHED_UNPROC_MAX: walk newest
            # -> oldest, keep whole entries while the sub-budget holds. When the
            # next entry would overflow, truncate THAT entry to the remaining
            # room (if the remainder is usefully large) and stop; the rest
            # (older) are dropped. Prepend each kept entry so the emitted order
            # stays oldest -> newest (chronological) among the survivors. A
            # single fat observation file is genuinely bounded here (not left
            # for the Layer-2 backstop to crudely chop). Truncated bodies remain
            # on disk and are reachable via recall.
            local obs_used=0
            local obs_dropped=0
            local obs_kept=()
            local obs_body obs_entry obs_entry_len obs_remaining obs_head_keep obs_trunc
            for (( j=UNPROCESSED_COUNT-1; j>=0; j-- )); do
                f="${UNPROCESSED_NEW[$j]}"
                OBS_BN="$(basename "$f" .md)"
                obs_body="$(cat "$f")"
                obs_entry="#### ${OBS_BN}"$'\n'$'\n'"${obs_body}"$'\n'$'\n'
                obs_entry_len=${#obs_entry}
                obs_remaining=$(( CACHED_UNPROC_MAX - obs_used ))
                if [ "$obs_remaining" -le 0 ]; then
                    obs_dropped=1
                    break
                fi
                if [ "$obs_entry_len" -le "$obs_remaining" ]; then
                    obs_kept=("$obs_entry" "${obs_kept[@]}")
                    obs_used=$(( obs_used + obs_entry_len ))
                else
                    # Entry overflows the sub-budget. Keep its head if there is
                    # usefully-large room (>= 200 chars), reserving ~120 for the
                    # heading + truncation marker; otherwise drop it whole.
                    if [ "$obs_remaining" -ge 200 ]; then
                        obs_head_keep=$(( obs_remaining - 120 ))
                        [ "$obs_head_keep" -lt 0 ] && obs_head_keep=0
                        obs_trunc="#### ${OBS_BN}"$'\n'$'\n'"${obs_body:0:$obs_head_keep}"$'\n'"> (observation truncated; full text via recall)"$'\n'$'\n'
                        obs_kept=("$obs_trunc" "${obs_kept[@]}")
                        obs_used=$(( obs_used + ${#obs_trunc} ))
                    fi
                    obs_dropped=1
                    break
                fi
            done
            local e
            for e in "${obs_kept[@]}"; do
                obs_block+="$e"
            done
            if [ "$obs_dropped" -eq 1 ]; then
                obs_block+="> older unprocessed observations available via recall (remembering)"$'\n'
                obs_block+=$'\n'
            fi
        fi

        # Step 2: append Zone 2 - Unprocessed Observations (capped block).
        block+="${obs_block}"

        # Step 3: compute remaining budget for Zone 3 (reflection gists), now
        # accounting for the CAPPED unprocessed size already in $block.
        local RECALL_POINTER="> deeper reflections available via recall (remembering)"
        local anchor_overhead=${#ANCHOR_END}
        local pointer_overhead=$((${#RECALL_POINTER} + 5))
        local zone3_header_overhead=60  # "### Recent Reflections (gist, newest first)\n\n"
        local headroom=400  # covers multi-byte UTF-8 chars (emoji) + the per-reflection accounting drift; keeps byte-size under budget too

        local refl_budget=$(( CACHED_BUDGET - ${#block} - anchor_overhead - pointer_overhead - zone3_header_overhead - headroom ))

        # Step 4: Zone 3 - reflection gists, newest-first, budget-capped.
        # If era + capped-unprocessed have already consumed the budget
        # (refl_budget too small for even one useful gist), skip the zone
        # entirely rather than emit an empty header+pointer that would tip the
        # total over CACHED_BUDGET and force a Layer-2 trim. Reflections are
        # fully reachable via recall, so dropping them here loses nothing.
        if [ "$HOT_COUNT" -gt 0 ] && [ "$refl_budget" -lt 120 ]; then
            block+="### Recent Reflections"$'\n'
            block+=$'\n'
            block+="${RECALL_POINTER}"$'\n'
            block+=$'\n'
        elif [ "$HOT_COUNT" -eq 0 ]; then
            block+="### Recent Reflections (gist, newest first)"$'\n'
            block+=$'\n'
            block+="_No reflections yet._"$'\n'
            block+=$'\n'
        else
            block+="### Recent Reflections (gist, newest first)"$'\n'
            block+=$'\n'
            local gist_used=0
            for (( i=HOT_COUNT-1; i>=0; i-- )); do
                f="${HOT[$i]}"
                BN="$(basename "$f" .md)"

                # Per-reflection budget: min(GIST_MAX, remaining)
                local remaining=$(( refl_budget - gist_used ))
                [ "$remaining" -le 50 ] && break

                local take="$CACHED_GIST_MAX"
                [ "$take" -gt "$remaining" ] && take="$remaining"

                local gist_content
                gist_content="$(reflection_gist "$f" "$take")"

                block+="#### Reflection (${BN})"$'\n'
                block+=$'\n'
                block+="${gist_content}"$'\n'
                block+=$'\n'

                gist_used=$(( gist_used + ${#gist_content} + ${#BN} + 20 ))
            done

            block+="${RECALL_POINTER}"$'\n'
            block+=$'\n'
        fi

    else
        # Non-cached mode: original verbatim behaviour

        # Zone 2 - Recent Reflections (verbatim, oldest → newest within the hot zone)
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

        # Zone 3 - Unprocessed Observations
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

    fi  # end if CACHED_MODE

    block+="$ANCHOR_END"

    printf '%s' "$block"
}

BLOCK="$(assemble_block)"

# --- Layer 2: HARD total-cap (--cached only, the load-bearing guarantee) ---
#
# Bulletproof backstop: no matter how large any single zone grows (even Era
# alone), the emitted --cached block is ALWAYS < CACHED_BUDGET. Layer 1's
# per-zone caps keep the normal/fat-unprocessed cases comfortably under budget;
# this guard catches the fat-era case (era alone near/over budget) that no
# per-zone cap can bound. We tail-truncate: the cached block is ordered
# era > unprocessed > reflections, so truncation sheds reflection gists first,
# then unprocessed, preserving the highest-priority head (era) longest.
if [ "$CACHED_MODE" = "true" ] && [ "${#BLOCK}" -ge "$CACHED_BUDGET" ]; then
    HARDCAP_POINTER="> content truncated to budget; full memory via recall (remembering)"
    # Slack (150) covers the anchor/pointer re-add plus a multi-byte margin so the
    # emitted block lands clearly under CACHED_BUDGET in BYTES too (not just chars).
    HARDCAP_RESERVE=$(( ${#ANCHOR_END} + ${#HARDCAP_POINTER} + 150 ))
    HARDCAP_KEEP=$(( CACHED_BUDGET - HARDCAP_RESERVE ))
    [ "$HARDCAP_KEEP" -lt 0 ] && HARDCAP_KEEP=0
    BLOCK="${BLOCK:0:$HARDCAP_KEEP}"$'\n'"${HARDCAP_POINTER}"$'\n'"$ANCHOR_END"
fi

BLOCK_INNER_CHARS=$(( ${#BLOCK} - ${#ANCHOR_START} - ${#ANCHOR_END} - 1 ))  # rough; for budget gating

# --- --emit dispatch: print the block and stop before any mutation ---
# Budget escalation is skipped too (it writes era + state); the consumer
# (agy PreInvocation handler) applies its own injection-size cap.
# In --cached mode we also log the char count so obs-inject.sh can surface it.

if [ "$EMIT_MODE" = "true" ]; then
    printf '%s\n' "$BLOCK"
    log info "emit-block" "{\"chars\":${BLOCK_INNER_CHARS},\"eraLevel\":${ERA_LEVEL},\"hot\":${HOT_COUNT},\"unprocessed\":${UNPROCESSED_COUNT},\"cached\":${CACHED_MODE}}"
    if [ "$CACHED_MODE" = "true" ] && [ "$BLOCK_INNER_CHARS" -ge 9500 ]; then
        log warn "cached-budget-breach" "{\"chars\":${BLOCK_INNER_CHARS},\"budget\":9500}"
    fi
    exit 0
fi

# --- Budget escalation state machine (§2A.5) ---
#
# 1. If block_chars <= softBudget: ok
# 2. If over soft and level < max: escalate level, regenerate era, re-assemble, retry
# 3. If at max level and over hard: decrement hot count (>=minHot), absorb the
#    newly-bumped reflection into the era at max level, retry
# 4. If at min hot and max level and still over hard: accept and warn

ESCALATIONS=0
MAX_ESCALATIONS=8  # safety upper bound - level 0→3 + 3 hot decrements + slack

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

    # At max level - only escalate further by reducing hot zone
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

# --- Update live-state.json with final metrics ---

write_state lastBlockCharCount "$BLOCK_INNER_CHARS"
write_state lastRebuildAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" true

echo "✅ MEMORY.md live block rebuilt: ${BLOCK_INNER_CHARS} chars · era level=${ERA_LEVEL} · hot=${HOT_COUNT}/${HOT_K} · unprocessed=${UNPROCESSED_COUNT}" >&2
log info "block-rebuilt" "{\"chars\":${BLOCK_INNER_CHARS},\"eraLevel\":${ERA_LEVEL},\"hot\":${HOT_COUNT},\"hotK\":${HOT_K},\"elders\":${ELDER_COUNT},\"unprocessed\":${UNPROCESSED_COUNT}}"
log info "exit" "{\"status\":\"ok\"}"
