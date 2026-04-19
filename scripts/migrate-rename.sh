#!/bin/bash
# migrate-rename.sh — idempotent migration from `greymatter` → `the-brain`.
#
# What it does:
#   1. Renames ~/.greymatter/  → ~/.the-brain/  (user-global memory dir + config)
#   2. Walks known agent worktrees and renames per-project pointer dirs:
#        <worktree>/.greymatter/memory_root  →  <worktree>/.the-brain/memory_root
#      Also sed-updates the *content* of each memory_root file to rewrite any
#      literal `/.greymatter/` path references inside the pointer target path.
#
# Usage:
#   scripts/migrate-rename.sh           # DRY RUN (default — prints what would happen)
#   scripts/migrate-rename.sh --apply   # actually perform the moves
#
# Safety:
#   - Dry-run by default.
#   - If the source dir does not exist, the operation is skipped cleanly (no-op).
#   - If the destination already exists, the operation is skipped (no clobber).
#   - Idempotent: re-running after success does nothing.
#   - Refuses to run if NOTHING needs doing (reports no-op cleanly).

set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
    APPLY=1
elif [[ "${1:-}" == "--dry-run" || -z "${1:-}" ]]; then
    APPLY=0
elif [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
else
    echo "Unknown arg: $1" >&2
    echo "Usage: $0 [--dry-run | --apply]" >&2
    exit 1
fi

if [[ $APPLY -eq 1 ]]; then
    echo "[migrate] APPLY mode — changes will be made"
else
    echo "[migrate] DRY-RUN mode — no changes will be made. Re-run with --apply to commit."
fi

# -------- helpers --------

announce() { echo "[migrate] $*"; }

do_or_echo() {
    if [[ $APPLY -eq 1 ]]; then
        "$@"
    else
        echo "  would run: $*"
    fi
}

# Track whether we did anything real
ACTIONS=0

# -------- 1. ~/.greymatter → ~/.the-brain --------

OLD_HOME_DIR="$HOME/.greymatter"
NEW_HOME_DIR="$HOME/.the-brain"

announce "Check: $OLD_HOME_DIR → $NEW_HOME_DIR"

if [[ -d "$OLD_HOME_DIR" && ! -e "$NEW_HOME_DIR" ]]; then
    announce "  source exists, dest missing — will rename"
    do_or_echo mv "$OLD_HOME_DIR" "$NEW_HOME_DIR"
    ACTIONS=$((ACTIONS + 1))
elif [[ -d "$OLD_HOME_DIR" && -e "$NEW_HOME_DIR" ]]; then
    announce "  both exist — SKIP (manual merge required)"
elif [[ ! -d "$OLD_HOME_DIR" && -d "$NEW_HOME_DIR" ]]; then
    announce "  already migrated (dest exists, no source)"
else
    announce "  neither exists — nothing to do"
fi

# -------- 2. Per-project pointer files --------
#
# Scan known worktree roots for `.greymatter/memory_root` pointer files.
# For each:
#   a) Rename the containing `.greymatter/` dir to `.the-brain/`.
#   b) sed any `/.greymatter/` substring inside the file content to `/.the-brain/`.
#
# Scan roots: $HOME (top-level projects) and common project workspace locations.
# Uses `find -maxdepth` to avoid walking huge trees like node_modules.

announce ""
announce "Check: worktree pointer files (.greymatter/memory_root)"

SCAN_ROOTS=(
    "$HOME/io-projects"
    "$HOME/git-repos"
    "$HOME/claude-io"
    "$HOME/.openclaw/workspace"
)

for root in "${SCAN_ROOTS[@]}"; do
    [[ -d "$root" ]] || continue
    # maxdepth 4 catches: $root/<project>/.greymatter/memory_root
    #                and: $root/<project>/<worktree>/.greymatter/memory_root
    while IFS= read -r -d '' pointer; do
        old_dir="$(dirname "$pointer")"                 # .../.greymatter
        project_dir="$(dirname "$old_dir")"             # parent
        new_dir="$project_dir/.the-brain"
        new_pointer="$new_dir/memory_root"

        announce "  found: $pointer"

        if [[ -e "$new_pointer" ]]; then
            announce "    dest already exists, skipping: $new_pointer"
            continue
        fi

        if [[ -e "$new_dir" && ! -L "$new_dir" ]]; then
            announce "    dest dir exists without pointer, moving file only"
            do_or_echo mv "$pointer" "$new_pointer"
        else
            announce "    renaming dir: $old_dir → $new_dir"
            do_or_echo mv "$old_dir" "$new_dir"
        fi

        # Rewrite pointer contents if it contains a /.greymatter/ path
        target_file="$new_pointer"
        if [[ $APPLY -eq 1 ]]; then
            if grep -q '/\.greymatter/' "$target_file" 2>/dev/null; then
                announce "    rewriting content paths inside: $target_file"
                sed -i 's|/\.greymatter/|/\.the-brain/|g' "$target_file"
            fi
        else
            # In dry-run mode, $target_file doesn't exist yet (we didn't move).
            # Check the source instead.
            if grep -q '/\.greymatter/' "$pointer" 2>/dev/null; then
                announce "    would rewrite content paths inside: $target_file"
                echo "      would run: sed -i 's|/\.greymatter/|/\.the-brain/|g' $target_file"
            fi
        fi

        ACTIONS=$((ACTIONS + 1))
    done < <(find "$root" -maxdepth 4 -type f -path '*/.greymatter/memory_root' -print0 2>/dev/null)
done

# -------- Summary --------

announce ""
if [[ $ACTIONS -eq 0 ]]; then
    announce "No actions needed — nothing to migrate."
    exit 0
fi

if [[ $APPLY -eq 1 ]]; then
    announce "Done. $ACTIONS action(s) applied."
else
    announce "Dry-run complete. $ACTIONS action(s) would be applied. Re-run with --apply."
fi
