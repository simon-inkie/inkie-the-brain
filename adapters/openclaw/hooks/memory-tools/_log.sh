#!/bin/bash
# _log.sh — append a JSONL entry to ~/.the-brain/logs/hook-activity.jsonl.
# Sourced by observe.sh, reflect.sh, build-context.sh, compress-era.sh.
#
# Usage:
#   log info "observation-written" '{"path":"obs.md","chars":1234}'
#   log warn "claude-call-empty"
#   log error "spawn-failed" '{"err":"ENOENT"}'
#
# Trace propagation: BRAIN_TRACE_ID + BRAIN_COMPONENT are set by the parent
# (TS handler) before spawning bash. If unset, fall back to a synthetic id
# and the script's basename.
#
# Level filtering: BRAIN_LOG_LEVEL env knob (debug|info|warn|error, default info).
# Failures swallowed — logging never blocks observation/reflection.

log() {
  local level="$1"
  local event="$2"
  local data="${3:-}"
  [ -z "$data" ] && data='{}'

  local cur="${BRAIN_LOG_LEVEL:-info}"
  case "$cur" in
    debug) ;;
    info)  [[ "$level" == "debug" ]] && return 0 ;;
    warn)  [[ "$level" == "debug" || "$level" == "info" ]] && return 0 ;;
    error) [[ "$level" != "error" ]] && return 0 ;;
    *) ;;
  esac

  local logdir="${HOME}/.the-brain/logs"
  mkdir -p "$logdir" 2>/dev/null || return 0

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

  local trace="${BRAIN_TRACE_ID:-none:$(date +%s%3N 2>/dev/null || date +%s)}"
  local component="${BRAIN_COMPONENT:-${BASH_SOURCE[1]##*/}}"

  # Inline persona identity if AGENT_NAME is set — mirrors the TS helper so
  # a session-wide grep '"agentName":"brain-surgeon"' catches all components.
  local agent_field=""
  if [ -n "${AGENT_NAME:-}" ]; then
    agent_field=",\"agentName\":\"${AGENT_NAME}\""
  fi

  printf '{"ts":"%s","level":"%s","traceId":"%s","component":"%s","event":"%s"%s,"data":%s}\n' \
    "$ts" "$level" "$trace" "$component" "$event" "$agent_field" "$data" \
    >> "$logdir/hook-activity.jsonl" 2>/dev/null || true
}
