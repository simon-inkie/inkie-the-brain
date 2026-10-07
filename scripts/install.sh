#!/usr/bin/env bash
# install.sh: non-interactive, idempotent install of the-brain into a Claude
# Code setup. Safe to run from another project's install script, and safe to
# run again.
#
#   scripts/install.sh [--settings FILE] [--agent NAME [--link DIR]]
#                      [--skip-build] [--dry-run]
#
#   --settings FILE  settings.json to wire (default ~/.claude/settings.json)
#   --agent NAME     also create (or repair) the agent memory silo NAME
#   --link DIR       with --agent, point DIR/.the-brain/memory_root at the silo
#   --skip-build     do not run pnpm install / pnpm build (dist/ is already built)
#   --dry-run        build nothing, write nothing; report the hook changes only
#
# The checkout can have any name and live anywhere: every path is derived from
# this script's own location. Nothing here prompts.
#
# Exit codes: 0 ok, 1 bad arguments, 2 a prerequisite is missing or the build
# failed, 3 settings.json is unusable (left untouched). When --agent is given,
# a failure from `agent init` is passed through unchanged (1, 2 or 3, see
# README "Scripting the install").

set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="${HOME}/.claude/settings.json"
AGENT=""
LINK=""
SKIP_BUILD=0
DRY_RUN=0

die() { echo "install: $2" >&2; exit "$1"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --settings) [ $# -ge 2 ] || die 1 "--settings needs a value"; SETTINGS="$2"; shift 2 ;;
        --agent)    [ $# -ge 2 ] || die 1 "--agent needs a value";    AGENT="$2";    shift 2 ;;
        --link)     [ $# -ge 2 ] || die 1 "--link needs a value";     LINK="$2";     shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --dry-run)    DRY_RUN=1; shift ;;
        -h|--help)    sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die 1 "unknown argument $1" ;;
    esac
done
[ -z "$LINK" ] || [ -n "$AGENT" ] || die 1 "--link needs --agent"

command -v node >/dev/null 2>&1 || die 2 "node not found (Node 22+ required)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die 2 "Node 22+ required, found $(node --version)"

# Paths the caller passed are relative to the caller, not to the checkout.
abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
SETTINGS="$(abspath "$SETTINGS")"
[ -z "$LINK" ] || LINK="$(abspath "$LINK")"

cd "$ROOT"

if [ "$SKIP_BUILD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    command -v pnpm >/dev/null 2>&1 || die 2 "pnpm not found (see QUICKSTART prerequisites)"
    echo "install: pnpm install"
    pnpm install --frozen-lockfile >&2 || die 2 "pnpm install failed"
    echo "install: pnpm build"
    pnpm build >&2 || die 2 "pnpm build failed"
fi

echo "install: wiring hooks into $SETTINGS"
HOOK_ARGS=(--settings "$SETTINGS")
[ "$DRY_RUN" -eq 1 ] && HOOK_ARGS+=(--dry-run)
node "$ROOT/scripts/install-hooks.mjs" "${HOOK_ARGS[@]}"

if [ -n "$AGENT" ] && [ "$DRY_RUN" -eq 0 ]; then
    TSX="$ROOT/node_modules/.bin/tsx"
    [ -x "$TSX" ] || die 2 "tsx not found at $TSX; run pnpm install (or drop --skip-build)"
    INIT_ARGS=(agent init "$AGENT")
    [ -n "$LINK" ] && INIT_ARGS+=(--link "$LINK")
    "$TSX" "$ROOT/cli/index.ts" "${INIT_ARGS[@]}" </dev/null
fi

echo "install: done"
