#!/bin/bash
# install-timer.sh — Install the weekly Qdrant snapshot timer as a systemd user unit.
#
# Usage:
#   scripts/install-timer.sh           # install and enable
#   scripts/install-timer.sh --uninstall
#
# This installs (symlinks) the .service and .timer files into
# ~/.config/systemd/user/, enables the timer, and starts it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
SERVICE_NAME="snapshot-qdrant.service"
TIMER_NAME="snapshot-qdrant.timer"

if [ "${1:-}" = "--uninstall" ]; then
    echo "Stopping and disabling timer..."
    systemctl --user stop "$TIMER_NAME" 2>/dev/null || true
    systemctl --user disable "$TIMER_NAME" 2>/dev/null || true
    rm -f "$UNIT_DIR/$SERVICE_NAME" "$UNIT_DIR/$TIMER_NAME"
    systemctl --user daemon-reload
    echo "Uninstalled."
    exit 0
fi

mkdir -p "$UNIT_DIR"
ln -sf "$SCRIPT_DIR/$SERVICE_NAME" "$UNIT_DIR/$SERVICE_NAME"
ln -sf "$SCRIPT_DIR/$TIMER_NAME" "$UNIT_DIR/$TIMER_NAME"

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
