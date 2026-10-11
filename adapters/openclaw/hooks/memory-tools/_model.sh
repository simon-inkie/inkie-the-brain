#!/bin/bash
# _model.sh: the one place the memory loop's model CLI is configured.
# Sourced by observe.sh, reflect.sh and compress-era.sh.
#
# Defaults reproduce the previous hardcoded behaviour exactly:
#   claude --print --strict-mcp-config [--no-session-persistence] \
#          --model claude-haiku-4-5-20251001 --system-prompt "<prompt>"
#
# Configuration (environment, or the env file; the environment wins):
#   BRAIN_MODEL_CLI          Executable, may carry leading words ("npx my-llm").
#                            Default: claude
#   BRAIN_MODEL_ID           Model id passed to the CLI. Set it empty to pass
#                            no model flag and let the CLI choose.
#                            Default: claude-haiku-4-5-20251001
#   BRAIN_MODEL_ARGS         Fixed arguments placed before the model flag.
#                            Replaces the default for BOTH one-shot modes.
#                            Default: "--print --strict-mcp-config", plus
#                            "--no-session-persistence" for reflect and
#                            compress-era.
#   BRAIN_MODEL_FLAG         Flag that carries the model id. Default: --model
#   BRAIN_MODEL_SYSTEM_FLAG  Flag that carries the system prompt.
#                            Default: --system-prompt
#
# BRAIN_MODEL_CLI and BRAIN_MODEL_ARGS are split on whitespace, so a CLI path
# or an argument that itself contains a space cannot be expressed; wrap such a
# CLI in a small script and point BRAIN_MODEL_CLI at that.
#
# The CLI must read the user prompt on stdin and write the answer to stdout.
# No API key is read here: the host's model CLI owns its own authentication.

# Fill a BRAIN_MODEL* variable from the env files only when the environment
# has not already set it (even to the empty string). Sourcing the files would
# also override the environment, which is the wrong way round for the "the
# environment wins" rule that core/env.ts documents.
_brain_model_load_env() {
    local name file line val
    for name in BRAIN_MODEL_CLI BRAIN_MODEL_ID BRAIN_MODEL_ARGS BRAIN_MODEL_FLAG BRAIN_MODEL_SYSTEM_FLAG; do
        [ -n "${!name+x}" ] && continue
        # First file to define the variable wins, same as core/env.ts.
        for file in "${BRAIN_ENV_FILE:-}" "$HOME/.the-brain/.env" "$HOME/io-data/.env"; do
            [ -n "$file" ] && [ -f "$file" ] || continue
            line=$(grep -E "^${name}=" "$file" 2>/dev/null | tail -n 1) || true
            [ -n "$line" ] || continue
            val="${line#*=}"
            val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
            printf -v "$name" '%s' "$val"
            export "${name?}"
            break
        done
    done
}
_brain_model_load_env
unset -f _brain_model_load_env

: "${BRAIN_MODEL_CLI:=claude}"
[ -n "${BRAIN_MODEL_ID+x}" ] || BRAIN_MODEL_ID="claude-haiku-4-5-20251001"
: "${BRAIN_MODEL_FLAG:=--model}"
: "${BRAIN_MODEL_SYSTEM_FLAG:=--system-prompt}"

# brain_model_call <ephemeral:0|1> <system-prompt>
# Prompt on stdin, answer on stdout, stderr discarded (as before). Returns the
# CLI's exit status.
brain_model_call() {
    local ephemeral="$1" system_prompt="$2"
    local -a cli args cmd
    read -r -a cli <<< "$BRAIN_MODEL_CLI"
    if [ -n "${BRAIN_MODEL_ARGS+x}" ]; then
        read -r -a args <<< "$BRAIN_MODEL_ARGS"
    else
        args=(--print --strict-mcp-config)
        [ "$ephemeral" = "1" ] && args=(--print --no-session-persistence --strict-mcp-config)
    fi
    cmd=("${cli[@]}" "${args[@]}")
    [ -n "$BRAIN_MODEL_ID" ] && cmd+=("$BRAIN_MODEL_FLAG" "$BRAIN_MODEL_ID")
    cmd+=("$BRAIN_MODEL_SYSTEM_FLAG" "$system_prompt")
    "${cmd[@]}" 2>/dev/null
}

# JSON-escaped copies for the log lines, so a quote in a CLI path cannot make
# a hook-activity.jsonl line invalid.
_brain_json_escape() {
    local v="$1"
    v="${v//\\/\\\\}"
    v="${v//\"/\\\"}"
    printf '%s' "$v"
}
BRAIN_MODEL_CLI_LOG="$(_brain_json_escape "$BRAIN_MODEL_CLI")"
BRAIN_MODEL_ID_LOG="$(_brain_json_escape "$BRAIN_MODEL_ID")"
