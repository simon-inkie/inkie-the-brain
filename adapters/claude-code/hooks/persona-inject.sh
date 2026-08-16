#!/usr/bin/env bash
# SessionStart hook -- inject the agent's distilled CORE persona into the MAIN
# session's cached prefix, then force a first-action read of the full files.
#
# SessionStart fires for real sessions (startup / resume / clear / compact) but
# NOT for spawned subagents (empirically confirmed: a spawned subagent produces
# zero SessionStart log entries). So injecting persona HERE gives the main
# session its identity while subagents stay lean.
#
# WHY THE CUTOVER: the earlier version of this hook cat'd the 6 FULL persona
# files (~46K), which blew past Claude Code's 10,000-char hook-output cap and
# got silently truncated to a 2KB preview+pointer -- so persona arrived as a
# stub. The fix: emit a small distilled CORE (~/agents/<name>/CORE.md) as the
# always-present floor, PLUS a forceful first-action instruction to Read the
# full files for depth. The inline CORE stays well under the cap; the full
# files arrive reliably via the agent's own first Read.
#
# The emitted text becomes part of the session's CACHED prefix (static between
# session-start events), so the CORE is cache-read, not re-sent fresh per turn.
#
# DEGRADED MODES (deliberate, flagged): if CORE.md is missing OR the assembled
# CORE+wrapper would exceed the byte cap, emit the WRAPPER ALONE (always tiny)
# plus a LOUD log line. The agent still gets the read-trigger and the failure
# is visible. We NEVER emit a truncated CORE.
#
# Fail-open: any unexpected condition emits empty additionalContext so a broken
# persona-inject never blocks a session.

# Emit an empty SessionStart additionalContext and exit 0 (fail-open).
emit_empty() {
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\n'
  exit 0
}

LOG="$HOME/.claude/persona-inject.log"
{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] fired"
  echo "  AGENT_NAME=${AGENT_NAME:-<unset>}  PPID=$PPID  one_shot=${BRAIN_ONE_SHOT_SESSION:-0}"
} >> "$LOG" 2>/dev/null

# Not a team agent -> nothing to inject.
if [ -z "${AGENT_NAME:-}" ]; then
  echo "  -> exit: no AGENT_NAME (branch=empty)" >> "$LOG" 2>/dev/null
  emit_empty
fi

# One-shot model sessions (observe.sh / reflect.sh / compress-era.sh) don't need
# persona -- same gate the rest of the memory tooling uses.
if [ "${BRAIN_ONE_SHOT_SESSION:-0}" = "1" ]; then
  echo "  -> exit: one-shot session (branch=empty)" >> "$LOG" 2>/dev/null
  emit_empty
fi

AGENT_DIR="$HOME/agents/$AGENT_NAME"
SHARED_DIR="$HOME/agents"
CORE_FILE="$AGENT_DIR/CORE.md"

# If the agent dir doesn't exist, this session is not a the-brain agent home
# (e.g. an agent running on a different runtime, with no ~/agents/<name>/).
if [ ! -d "$AGENT_DIR" ]; then
  echo "  -> exit: no agent dir $AGENT_DIR (branch=empty)" >> "$LOG" 2>/dev/null
  emit_empty
fi

# Byte cap. The real Claude Code hook-output limit is 10,000 CHARS; we guard on
# BYTES (wc -c), which is >= chars, so staying under 9,500 bytes guarantees we
# stay under the char cap with margin. The build.mjs CORE guard uses the same
# byte measure so the two never disagree.
CAP=9500

# Static first-action read wrapper. Read-list is the LEAN persona files as
# absolute paths (NOT the .full variants). Order: shared first, then the
# agent-specific set. Keep this text IN SYNC with scripts/core-guard.mjs
# (the build-time guard recomputes the identical wrapper to size it).
build_wrapper() {
  cat <<WRAP
🔴 FIRST ACTION THIS SESSION, before you respond to anything: Read these full persona files now (your CORE is your floor; these are your depth):
$SHARED_DIR/SYSTEM.md
$SHARED_DIR/ROSTER.md
$AGENT_DIR/SOUL.md
$AGENT_DIR/IDENTITY.md
$AGENT_DIR/TOOLS.md
$AGENT_DIR/USER.md
Do not skip this. Your CORE is a distilled summary; the full files carry the detail you operate on.
WRAP
}

WRAPPER="$(build_wrapper)"

if [ -f "$CORE_FILE" ]; then
  CORE="$(cat "$CORE_FILE" 2>/dev/null)"
  ASSEMBLED="$CORE"$'\n\n'"$WRAPPER"
  ASSEMBLED_CHARS=$(printf '%s' "$ASSEMBLED" | wc -c)
  if [ "$ASSEMBLED_CHARS" -lt "$CAP" ]; then
    OUT="$ASSEMBLED"
    BRANCH="core"
    echo "  -> emitted CORE+wrapper ($ASSEMBLED_CHARS bytes, branch=core)" >> "$LOG" 2>/dev/null
  else
    OUT="$WRAPPER"
    BRANCH="wrapper-only"
    echo "  !!! LOUD: assembled CORE+wrapper = $ASSEMBLED_CHARS bytes >= $CAP cap for $AGENT_NAME -> emitting WRAPPER-ALONE (CORE too big, NOT truncated). FIX THE CORE." >> "$LOG" 2>/dev/null
  fi
else
  OUT="$WRAPPER"
  BRANCH="wrapper-only"
  ASSEMBLED_CHARS=$(printf '%s' "$WRAPPER" | wc -c)
  echo "  !!! LOUD: CORE.md missing ($CORE_FILE) for $AGENT_NAME -> emitting WRAPPER-ALONE (no CORE floor this session). AUTHOR THE CORE." >> "$LOG" 2>/dev/null
fi

# Belt-and-braces: OUT should never be empty (wrapper is always non-empty), but
# if it somehow is, fail open rather than emit a half-formed block.
if [ -z "$OUT" ]; then
  echo "  -> exit: assembled output empty (branch=empty, unexpected)" >> "$LOG" 2>/dev/null
  emit_empty
fi

# Emit as SessionStart additionalContext JSON (json.dumps handles escaping).
OUT="$OUT" python3 -c '
import json, os
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": os.environ["OUT"],
    }
}))
' 2>/dev/null || emit_empty
