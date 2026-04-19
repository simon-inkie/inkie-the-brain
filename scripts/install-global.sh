#!/usr/bin/env bash
# install-global.sh — symlink bin/the-brain into ~/.local/bin/ so
# `the-brain` works from any directory.
#
# Idempotent — re-running is safe (prints "already current" if the
# symlink already points at our bin).
#
# Target platforms: Linux, macOS, WSL2 on Windows. Native Windows
# (PowerShell / CMD) is not supported — the observer/reflect pipeline
# is bash-based, so the-brain only runs where bash runs.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
SOURCE="$REPO_ROOT/bin/the-brain"
TARGET_DIR="$HOME/.local/bin"
TARGET="$TARGET_DIR/the-brain"

if [ ! -f "$SOURCE" ]; then
    echo "install-global: source not found at $SOURCE — run from a the-brain checkout" >&2
    exit 1
fi

chmod +x "$SOURCE"

mkdir -p "$TARGET_DIR"

# If target already exists and points at us, we're done.
if [ -L "$TARGET" ]; then
    CURRENT="$(readlink "$TARGET")"
    if [ "$CURRENT" = "$SOURCE" ]; then
        echo "install-global: $TARGET → $SOURCE already current"
    else
        echo "install-global: replacing $TARGET (was → $CURRENT)"
        ln -sf "$SOURCE" "$TARGET"
    fi
elif [ -e "$TARGET" ]; then
    echo "install-global: $TARGET exists and is not a symlink — refusing to overwrite. Remove it and re-run." >&2
    exit 1
else
    ln -s "$SOURCE" "$TARGET"
    echo "install-global: linked $TARGET → $SOURCE"
fi

# Verify PATH contains ~/.local/bin (warn but don't fail).
case ":$PATH:" in
    *":$TARGET_DIR:"*)
        ;;
    *)
        echo
        echo "⚠️  $TARGET_DIR is not on your PATH."
        echo "   Add this to your shell rc file (~/.bashrc / ~/.zshrc):"
        echo
        echo '      export PATH="$HOME/.local/bin:$PATH"'
        echo
        echo "   Then `source` the rc file or open a new shell. Until then, invoke"
        echo "   the CLI with the full path: $TARGET agent init <name>"
        ;;
esac

echo
echo "Try it:  the-brain agent init test-install-$$"
