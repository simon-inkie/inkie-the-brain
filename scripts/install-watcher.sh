#!/usr/bin/env bash
# install-watcher.sh: install the file watcher as a systemd user service for
# a checkout at any path. Idempotent: re-running rewrites the unit and
# restarts nothing unless the unit changed.
#
#   scripts/install-watcher.sh [--root DIR] [--extras LIST] [--unit-dir DIR]
#                              [--no-enable] [--uninstall]
#
#   --root DIR      checkout to run (default: the checkout this script is in)
#   --extras LIST   opt-in watchers: media-filer, poke-agy, all (default none)
#   --unit-dir DIR  where to write the unit (default ~/.config/systemd/user)
#   --no-enable     write the unit only; do not call systemctl
#   --uninstall     stop, disable and remove the unit
#
# Exit codes: 0 ok, 1 bad arguments, 2 prerequisite missing (checkout, pnpm).

set -euo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/render-unit.sh
source "$SELF_DIR/lib/render-unit.sh"

ROOT="$(cd -P "$SELF_DIR/.." && pwd)"
EXTRAS=""
UNIT_DIR="${HOME}/.config/systemd/user"
ENABLE=1
UNINSTALL=0
UNIT="the-brain-watcher.service"

die() { echo "install-watcher: $2" >&2; exit "$1"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --root)      [ $# -ge 2 ] || die 1 "--root needs a value";     ROOT="$2"; shift 2 ;;
        --extras)    [ $# -ge 2 ] || die 1 "--extras needs a value";   EXTRAS="$2"; shift 2 ;;
        --unit-dir)  [ $# -ge 2 ] || die 1 "--unit-dir needs a value"; UNIT_DIR="$2"; shift 2 ;;
        --no-enable) ENABLE=0; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help)   sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die 1 "unknown argument $1" ;;
    esac
done

if [ "$UNINSTALL" -eq 1 ]; then
    if [ "$ENABLE" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now "$UNIT" 2>/dev/null || true
    fi
    rm -f "$UNIT_DIR/$UNIT"
    [ "$ENABLE" -eq 1 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload || true
    echo "install-watcher: removed $UNIT_DIR/$UNIT"
    exit 0
fi

[ -d "$ROOT" ] && [ -f "$ROOT/daemon/watcher.ts" ] || die 2 "$ROOT is not a the-brain checkout (no daemon/watcher.ts)"
ROOT="$(cd -P "$ROOT" && pwd)"
PNPM="$(command -v pnpm || true)"
check_unit_path "$ROOT" || die 1 "checkout path contains a quote, backslash or newline: $ROOT"
[ -n "$PNPM" ] || die 2 "pnpm not found on PATH"
check_unit_path "$PNPM" || die 1 "pnpm path contains a quote, backslash or newline: $PNPM"

case "$EXTRAS" in
    ""|none|all|media-filer|poke-agy|media-filer,poke-agy|poke-agy,media-filer) ;;
    *) die 1 "--extras must be media-filer, poke-agy, both comma separated, or all" ;;
esac
[ "$EXTRAS" = "none" ] && EXTRAS=""

mkdir -p "$UNIT_DIR"
NEW="$(render_unit "$SELF_DIR/the-brain-watcher.service" \
    "BRAIN_ROOT=$ROOT" "PNPM=$PNPM" "WATCH_EXTRAS=$EXTRAS")"

CHANGED=1
if [ -f "$UNIT_DIR/$UNIT" ] && [ "$(cat "$UNIT_DIR/$UNIT")" = "$NEW" ]; then
    CHANGED=0
fi
if [ "$CHANGED" -eq 1 ]; then
    printf '%s\n' "$NEW" > "$UNIT_DIR/$UNIT"
    echo "install-watcher: wrote $UNIT_DIR/$UNIT (root $ROOT, extras: ${EXTRAS:-none})"
else
    echo "install-watcher: $UNIT_DIR/$UNIT already current"
fi

if [ "$ENABLE" -eq 1 ]; then
    command -v systemctl >/dev/null 2>&1 || die 2 "systemctl not found; re-run with --no-enable to only write the unit"
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT"
    if [ "$CHANGED" -eq 1 ]; then systemctl --user restart "$UNIT"; else systemctl --user start "$UNIT"; fi
    echo "install-watcher: enabled and running; logs: journalctl --user -u the-brain-watcher -f"
fi
