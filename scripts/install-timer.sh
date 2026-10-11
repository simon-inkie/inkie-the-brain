#!/bin/bash
# install-timer.sh: Install the daily Qdrant snapshot timer as a systemd user unit.
#
# Usage:
#   scripts/install-timer.sh [--root DIR] [--unit-dir DIR] [--no-enable]
#   scripts/install-timer.sh --uninstall
#
#   --root DIR      checkout to run (default: the checkout this script is in)
#   --unit-dir DIR  where to write the units (default ~/.config/systemd/user)
#   --no-enable     write the units only; do not call systemctl
#
# The units are rendered from the templates beside this script with the
# checkout path filled in, so the checkout can live anywhere. Re-running
# rewrites them in place.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
# shellcheck source=lib/render-unit.sh
source "$SCRIPT_DIR/lib/render-unit.sh"

ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
ENABLE=1
UNINSTALL=0
SERVICE_NAME="snapshot-qdrant.service"
TIMER_NAME="snapshot-qdrant.timer"

die() { echo "install-timer: $2" >&2; exit "$1"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --root)      [ $# -ge 2 ] || die 1 "--root needs a value";     ROOT="$2"; shift 2 ;;
        --unit-dir)  [ $# -ge 2 ] || die 1 "--unit-dir needs a value"; UNIT_DIR="$2"; shift 2 ;;
        --no-enable) ENABLE=0; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        *) die 1 "unknown argument $1" ;;
    esac
done

if [ "$UNINSTALL" -eq 1 ]; then
    echo "Stopping and disabling timer..."
    if [ "$ENABLE" -eq 1 ]; then
        systemctl --user stop "$TIMER_NAME" 2>/dev/null || true
        systemctl --user disable "$TIMER_NAME" 2>/dev/null || true
    fi
    rm -f "$UNIT_DIR/$SERVICE_NAME" "$UNIT_DIR/$TIMER_NAME"
    [ "$ENABLE" -eq 1 ] && systemctl --user daemon-reload
    echo "Uninstalled."
    exit 0
fi

[ -f "$ROOT/scripts/snapshot-qdrant.sh" ] || die 2 "$ROOT is not a the-brain checkout (no scripts/snapshot-qdrant.sh)"
ROOT="$(cd -P "$ROOT" && pwd)"
check_unit_path "$ROOT" || die 1 "checkout path contains a quote, backslash or newline: $ROOT"
ROOT_URL="$(urlencode_path "$ROOT")"

mkdir -p "$UNIT_DIR"
# Replace any symlink left by an earlier version of this script, so the write
# below does not go through it into the checkout's template.
rm -f "$UNIT_DIR/$SERVICE_NAME" "$UNIT_DIR/$TIMER_NAME"
render_unit "$SCRIPT_DIR/$SERVICE_NAME" "BRAIN_ROOT=$ROOT" "BRAIN_ROOT_URL=$ROOT_URL" > "$UNIT_DIR/$SERVICE_NAME"
render_unit "$SCRIPT_DIR/$TIMER_NAME" "BRAIN_ROOT=$ROOT" "BRAIN_ROOT_URL=$ROOT_URL" > "$UNIT_DIR/$TIMER_NAME"
echo "install-timer: wrote units to $UNIT_DIR (root $ROOT)"

if [ "$ENABLE" -eq 0 ]; then
    exit 0
fi

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_NAME"

echo ""
echo "✅ Timer installed and enabled."
echo ""
systemctl --user status "$TIMER_NAME" --no-pager 2>&1 || true
echo ""
echo "Next run:"
systemctl --user list-timers "$TIMER_NAME" --no-pager 2>&1 | tail -3
echo ""
echo "Manual test:"
echo "  systemctl --user start $SERVICE_NAME"
echo ""
echo "View logs:"
echo "  journalctl --user -u $SERVICE_NAME --since '-1 day'"
