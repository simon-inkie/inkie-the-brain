#!/usr/bin/env bash
# SessionStart hook -- inject the STABLE observation block into the MAIN
# session's cached prefix.
#
# Observation cache-split. The three-zone observation block (era summary + hot
# reflections + unprocessed observations) only changes at COMPACTION, because
# observation files are written compact-only. So it is STABLE between compacts
# and belongs in the CACHED prefix (cache-read is a fraction of fresh price),
# not re-sent fresh every turn by the UserPromptSubmit hook.
#
# SessionStart fires for real sessions (startup / resume / clear / compact) but
# NOT for spawned subagents -- so the cached obs lands in the main session and
# re-injects fresh-as-of-compact on every compact. Pairs with the per-turn drop
# in user-prompt-submit.ts: both sides are governed by the SAME flag.
#
# FLAG-GATED on BRAIN_OBS_VIA_SESSIONSTART=1. While the flag is off (the default
# for every agent) this emits empty and the per-turn hook still injects obs -- so
# a shared dist rebuild is byte-for-byte safe and migration is per-agent atomic:
# set the flag and wire this hook together in one agent's settings.json, verify
# on its next compact, then move on to the next. Emitting here while the flag is
# off would DOUBLE the obs (cached + per-turn); gating prevents that.
#
# Fail-open: any error emits empty additionalContext so a broken obs-inject
# never blocks a session (and with the flag off the per-turn hook still carries
# obs, so empty here is harmless).

emit_empty() {
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\n'
  exit 0
}

LOG="$HOME/.claude/obs-inject.log"
{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] fired"
  echo "  AGENT_NAME=${AGENT_NAME:-<unset>}  flag=${BRAIN_OBS_VIA_SESSIONSTART:-0}  one_shot=${BRAIN_ONE_SHOT_SESSION:-0}"
} >> "$LOG" 2>/dev/null

# Inactive until the agent opts into the cache-split.
if [ "${BRAIN_OBS_VIA_SESSIONSTART:-0}" != "1" ]; then
  echo "  -> exit: flag off (per-turn hook still carries obs)" >> "$LOG" 2>/dev/null
  emit_empty
fi

# Not a team agent -> nothing to inject.
if [ -z "${AGENT_NAME:-}" ]; then
  echo "  -> exit: no AGENT_NAME" >> "$LOG" 2>/dev/null
  emit_empty
fi

# One-shot Haiku sessions don't need the obs block.
if [ "${BRAIN_ONE_SHOT_SESSION:-0}" = "1" ]; then
  echo "  -> exit: one-shot session" >> "$LOG" 2>/dev/null
  emit_empty
fi

MEMORY_DIR="$HOME/.the-brain/agents/$AGENT_NAME/memory"
if [ ! -d "$MEMORY_DIR" ]; then
  echo "  -> exit: no memory dir $MEMORY_DIR" >> "$LOG" 2>/dev/null
  emit_empty
fi

# Locate build-context.sh relative to this hook rather than from a hardcoded
# checkout path, so the hook works wherever the adapter is installed.
#   1. $BRAIN_BUILD_CONTEXT             -- explicit override, wins outright
#   2. <hook dir>/../memory-tools/      -- the built layout (dist/claude-code/)
#   3. <hook dir>/../../openclaw/hooks/memory-tools/ -- running from a checkout
HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BUILD_CONTEXT=""
for _cand in \
  "${BRAIN_BUILD_CONTEXT:-}" \
  "$HOOK_DIR/../memory-tools/build-context.sh" \
  "$HOOK_DIR/../../openclaw/hooks/memory-tools/build-context.sh"; do
  if [ -n "$_cand" ] && [ -f "$_cand" ]; then BUILD_CONTEXT="$_cand"; break; fi
done
if [ -z "$BUILD_CONTEXT" ]; then
  echo "  -> exit: build-context.sh not found near $HOOK_DIR (set BRAIN_BUILD_CONTEXT to override)" >> "$LOG" 2>/dev/null
  emit_empty
fi

# --cached is a pure read (no splice / era rebuild / live-state write); it emits
# the three-zone block without the wall-clock stamp.
OBS="$(MEMORY_DIR="$MEMORY_DIR" bash "$BUILD_CONTEXT" --cached 2>/dev/null)"
if [ -z "$OBS" ]; then
  echo "  -> exit: empty obs block (build-context --cached produced nothing)" >> "$LOG" 2>/dev/null
  emit_empty
fi

# Belt-and-braces cap guard. build-context --cached already hard-caps its block,
# but obs-inject must not TRUST that: if the cached block ever exceeds the emit
# ceiling (a build-context cap regression), emitting it blind lets Claude Code
# silently truncate anything over 10,000 chars to a ~2KB stub -- the same class
# of failure persona-inject.sh was built to avoid. So verify here: if OBS
# is over the ceiling, tail-truncate to whole lines (byte-safe, no mid-char
# cut), append a visible marker, and log LOUD. Never a silent cut.
OBS_EMIT_CEILING="${BRAIN_OBS_EMIT_CEILING:-9800}"
# Validate the ceiling: a bad override must never silently disable the guard nor
# drive head -c negative. A non-integer breaks the -gt test below (the guard is
# skipped and the block emits unguarded); a value under ~320 makes GUARD_BUDGET
# negative, and GNU head -c <negative> means "all but the last N bytes" (BSD head
# errors outright). So force a sane positive integer in [1000, 9900] (above 9900
# would defeat the point of protecting the 10,000-char cap), else fall back to
# the default with a LOUD log.
case "$OBS_EMIT_CEILING" in
  ''|*[!0-9]*)
    echo "  -> WARN bad BRAIN_OBS_EMIT_CEILING='${OBS_EMIT_CEILING}' (not a positive integer); using 9800" >> "$LOG" 2>/dev/null
    OBS_EMIT_CEILING=9800 ;;
esac
# Force base-10 before any arithmetic. A leading-zero all-digit override is octal
# to $(( )): 09800 has non-octal digits 8/9 so $(( )) aborts (the hook would crash
# on every SessionStart), and 01200 would parse as octal 640 and mis-size the
# budget. 10# makes the range checks below AND the GUARD_BUDGET arithmetic operate
# in base-10. Safe here: the case above has forced OBS_EMIT_CEILING all-digit.
OBS_EMIT_CEILING=$(( 10#$OBS_EMIT_CEILING ))
if [ "$OBS_EMIT_CEILING" -lt 1000 ] || [ "$OBS_EMIT_CEILING" -gt 9900 ]; then
  echo "  -> WARN BRAIN_OBS_EMIT_CEILING=${OBS_EMIT_CEILING} out of [1000,9900]; using 9800" >> "$LOG" 2>/dev/null
  OBS_EMIT_CEILING=9800
fi
OBS_BYTES="$(printf '%s' "$OBS" | wc -c)"
if [ "$OBS_BYTES" -gt "$OBS_EMIT_CEILING" ]; then
  GUARD_BUDGET=$(( OBS_EMIT_CEILING - 320 ))
  # head -c cuts at a byte boundary (may land mid-char); dropping everything
  # after the last newline removes that partial line, leaving only whole lines.
  OBS_TRUNC="$(printf '%s' "$OBS" | head -c "$GUARD_BUDGET")"
  OBS_TRUNC="${OBS_TRUNC%$'\n'*}"
  GUARD_MARKER="$(printf '\n\n[obs-inject guard: cached block was %sB, over the %sB ceiling; tail-truncated to whole lines to protect the 10,000-char session cap. build-context --cached total-cap likely regressed. See ~/.claude/obs-inject.log]' "$OBS_BYTES" "$OBS_EMIT_CEILING")"
  OBS="${OBS_TRUNC}${GUARD_MARKER}"
  echo "  -> WARN GUARD TRIPPED: obs block ${OBS_BYTES}B over ceiling ${OBS_EMIT_CEILING}B; tail-truncated to whole lines under ${GUARD_BUDGET}B + marker. build-context --cached cap regression suspected." >> "$LOG" 2>/dev/null
fi

echo "  -> emitted obs ($(printf '%s' "$OBS" | wc -c) bytes)" >> "$LOG" 2>/dev/null

OBS="$OBS" python3 -c '
import json, os
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": os.environ["OBS"],
    }
}))
' 2>/dev/null || emit_empty
