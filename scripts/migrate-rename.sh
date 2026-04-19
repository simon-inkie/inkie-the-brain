#!/bin/bash
# migrate-rename.sh — idempotent migration from `greymatter` → `the-brain`.
#
# What it does:
#   1. Renames ~/.greymatter/  → ~/.the-brain/  (user-global memory dir + config)
#   2. Walks known agent worktrees and renames per-project pointer dirs:
#        <worktree>/.greymatter/memory_root  →  <worktree>/.the-brain/memory_root
#      Also sed-updates the *content* of each memory_root file to rewrite any
#      literal `/.greymatter/` path references inside the pointer target path.
#   3. Patches ~/.openclaw/openclaw.json to rewrite the 7 known `greymatter`
#      references (hook pack id, source/install paths, MCP server path, plugin
#      key, contextEngine slot binding). Backs up to openclaw.json.bak first.
#   4. Renames Claude Code project memory slug dirs under ~/.claude/projects/
#      that contain `greymatter` in the slug — CC derives the slug from cwd,
#      so a repo-dir rename would otherwise orphan existing session memory.
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
#   - openclaw.json is backed up to openclaw.json.bak before any edit.
#
# DEPLOY PLAYBOOK (run these steps AROUND this script):
#   1. Stop the OpenClaw gateway (if running)
#   2. Close any Claude Code sessions in the greymatter repo
#   3. Rename the repo dir:   mv ~/io-projects/greymatter  ~/io-projects/the-brain
#   4. Rebuild in new path:   ( cd ~/io-projects/the-brain && node scripts/build.mjs )
#   5. Run this script:       ~/io-projects/the-brain/scripts/migrate-rename.sh --apply
#   6. Reinstall OpenClaw hook pack:
#        openclaw plugins uninstall greymatter-openclaw-hooks
#        openclaw plugins install ~/io-projects/the-brain/dist/hooks
#      (openclaw.json entry is now `the-brain-openclaw-hooks` after step 5)
#   7. Restart OpenClaw gateway
#   8. Verify plugin load in a fresh session: memory hook should fire and emit
#      `<the-brain>` tags on UserPromptSubmit; observations land in
#      ~/.the-brain/agents/<name>/memory/observations/

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

# -------- 3. openclaw.json patch --------
#
# The OpenClaw gateway config pins 7 greymatter references that will break
# plugin load after the repo dir rename. Three sed substitutions cover them:
#   - "greymatter-openclaw-hooks"  → "the-brain-openclaw-hooks"   (hook pack id, install dir)
#   - "/io-projects/greymatter/"   → "/io-projects/the-brain/"    (sourcePath, MCP path, plugin path)
#   - "\"greymatter\""             → "\"the-brain\""              (plugin key, contextEngine slot)

OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"

announce ""
announce "Check: $OPENCLAW_JSON (OpenClaw gateway config)"

if [[ ! -f "$OPENCLAW_JSON" ]]; then
    announce "  not present — skipping"
elif ! grep -q 'greymatter' "$OPENCLAW_JSON" 2>/dev/null; then
    announce "  already migrated (no greymatter refs)"
else
    STALE_COUNT=$(grep -c 'greymatter' "$OPENCLAW_JSON")
    announce "  found $STALE_COUNT greymatter reference(s) — will patch"
    if [[ $APPLY -eq 1 ]]; then
        cp "$OPENCLAW_JSON" "$OPENCLAW_JSON.bak"
        announce "    backed up to: $OPENCLAW_JSON.bak"
        sed -i \
            -e 's|greymatter-openclaw-hooks|the-brain-openclaw-hooks|g' \
            -e 's|/io-projects/greymatter/|/io-projects/the-brain/|g' \
            -e 's|"greymatter"|"the-brain"|g' \
            "$OPENCLAW_JSON"
        announce "    patched in place"
        REMAINING=$(grep -c 'greymatter' "$OPENCLAW_JSON" 2>/dev/null || echo "0")
        if [[ "$REMAINING" -gt 0 ]]; then
            announce "  ⚠️  $REMAINING greymatter ref(s) still present — inspect manually"
            grep -n 'greymatter' "$OPENCLAW_JSON" | sed 's/^/      /'
        fi
    else
        echo "      would run: cp $OPENCLAW_JSON $OPENCLAW_JSON.bak"
        echo "      would run: sed -i (3 substitutions) $OPENCLAW_JSON"
        announce "    affected lines:"
        grep -n 'greymatter' "$OPENCLAW_JSON" | sed 's/^/      /'
    fi
    ACTIONS=$((ACTIONS + 1))
fi

# -------- 4. Claude Code project memory slug rename --------
#
# CC derives the project-memory slug from cwd:
#   /foo/bar → -foo-bar   (and leading `.` becomes `-` too)
# So ~/io-projects/greymatter becomes  ~/.claude/projects/-home-simon-io-projects-greymatter
# and renaming the repo dir orphans the slug. We rename all slugs containing
# `greymatter` in their name to the equivalent `the-brain` slug.

CC_PROJECTS_DIR="$HOME/.claude/projects"

announce ""
announce "Check: CC project memory slug dirs under $CC_PROJECTS_DIR"

if [[ ! -d "$CC_PROJECTS_DIR" ]]; then
    announce "  $CC_PROJECTS_DIR not present — skipping"
else
    FOUND_SLUGS=0
    while IFS= read -r -d '' old_slug_path; do
        old_slug="$(basename "$old_slug_path")"
        # Replace both `greymatter-dev` → `the-brain-dev` AND `greymatter` → `the-brain`.
        # Order matters: compound token first so the standalone rewrite doesn't eat it.
        new_slug="${old_slug//greymatter-dev/the-brain-dev}"
        new_slug="${new_slug//greymatter/the-brain}"
        new_slug_path="$CC_PROJECTS_DIR/$new_slug"

        if [[ "$old_slug" == "$new_slug" ]]; then
            continue
        fi

        FOUND_SLUGS=$((FOUND_SLUGS + 1))
        announce "  found: $old_slug"
        announce "    → $new_slug"

        if [[ -e "$new_slug_path" ]]; then
            announce "    dest already exists — SKIP (manual merge required)"
            continue
        fi

        do_or_echo mv "$old_slug_path" "$new_slug_path"
        ACTIONS=$((ACTIONS + 1))
    done < <(find "$CC_PROJECTS_DIR" -maxdepth 1 -mindepth 1 -type d -name '*greymatter*' -print0 2>/dev/null)

    if [[ $FOUND_SLUGS -eq 0 ]]; then
        announce "  no greymatter slug dirs found — already migrated"
    fi
fi

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
