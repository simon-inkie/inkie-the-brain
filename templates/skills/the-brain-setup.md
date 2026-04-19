---
name: the-brain-setup
description: Set up the-brain memory for a new project or worktree — creates a dedicated agent memory silo and wires up a pointer file so observations, reflections, and era summaries land in the right place. Use when the user asks about setting up the-brain, creating a new agent, linking a worktree to a persona, or "getting memory working" for a repo.
---

# The Brain — Agent Setup

Guide the user through setting up a dedicated agent memory silo for the current repo/worktree, so the-brain knows where to store their observations and what persona owns them.

## Prerequisites — verify these first

Run these checks silently. Surface the first one that fails; skip the skill's main flow until the user fixes it.

1. **the-brain repo checked out.** Expected at `~/io-projects/the-brain/`. If missing, tell the user to clone `git@gitlab.com:simondixon/the-brain.git` there first.
2. **Build exists.** Expected `~/io-projects/the-brain/dist/claude-code/bin/user-prompt-submit.sh`. If missing, run `cd ~/io-projects/the-brain && pnpm install && node scripts/build.mjs` for them.
3. **Hooks wired into ~/.claude/settings.json.** Grep for `the-brain/dist/claude-code/bin/user-prompt-submit.sh` in `~/.claude/settings.json`. If missing, tell the user the permanent install hasn't been done yet — that's a separate one-time step (see the repo's README) and NOT part of this skill.

If all three pass, continue.

## Gather the persona name

Ask the user (ONE question, AskUserQuestion if available):

> What should this agent be called? The name becomes the memory dir under `~/.the-brain/agents/<name>/` and sticks with the persona across renames/moves of the worktree. Examples: `voice-polish-bot`, `ink-322-video`, `the-brain-dev`.

Validation (enforce silently, don't re-prompt unless violated):
- Alphanumeric + hyphens only
- No spaces, no slashes, no leading hyphen

If the user suggests something that doesn't fit, propose a kebab-case normalisation and confirm.

## Detect the target dir

The "target dir" is where the pointer file goes — usually the repo/worktree root the user is currently in.

- Default: `$PWD` (the cwd Claude Code is running from).
- If the cwd is NOT a git worktree / repo root (e.g. the user is in a subdir), walk up until you find `.git` and use that. Mention which dir you chose.
- If there's no git context at all, ask the user for the path explicitly.

## Check for collisions

Before creating anything:

1. Does `~/.the-brain/agents/<name>/` already exist? If yes, surface: "An agent named `<name>` already exists. Options: (a) reuse it — add the pointer only; (b) pick a new name." Don't silently clobber.
2. Does `<target>/.the-brain/memory_root` already exist? If yes, read it. If it points at the same agent, you're done. If it points at a DIFFERENT agent, surface: "This worktree is already linked to `<other-agent>`. Override?" Don't clobber silently.

## Run the init

From the the-brain repo dir, run:

```bash
cd ~/io-projects/the-brain
pnpm agent init <name> --link <target>
```

Expected output (first line): `✅ Created agent dir: /home/<user>/.the-brain/agents/<name>`

Expected output (after `--link` line): `✅ Linked <target>/.the-brain/memory_root → /home/<user>/.the-brain/agents/<name>/memory`

## Gitignore the pointer

Add `.the-brain/` to `<target>/.gitignore` if not already present. The pointer is local machine state — different devs on the same repo would resolve to different paths, so it must NOT be committed.

If the worktree has previously committed a `.the-brain/memory_root` file, untrack it without deletion:

```bash
git rm --cached .the-brain/memory_root
```

## Verify

Silent checks — only surface if one fails:

1. `~/.the-brain/agents/<name>/memory/OBSERVATION-PROMPT.md` exists
2. `~/.the-brain/agents/<name>/memory/live-state.json` exists and is valid JSON
3. `<target>/.the-brain/memory_root` exists and its first line resolves to step-1's dir

## Tell the user what happens next

Write this back to the user (adapt names to what they chose):

> Done. Memory for `<name>` now lives at `~/.the-brain/agents/<name>/memory/`.
>
> **To activate**: close this Claude Code session and open a fresh one in `<target>`. On first prompt, the UserPromptSubmit hook will inject an (initially empty) `<the-brain>` live block. After a few turns, Stop will fire `observe.sh` and the first observation will land at `memory/observations/`.
>
> Memory will persist across `/compact`, sessions, and even renaming/moving the worktree (the pointer file travels with it).

## Skip / stop conditions

- Don't create dirs while user is mid-conversation if they didn't ask for it.
- Don't touch `<target>` outside `.the-brain/` and (if relevant) `.gitignore`.
- Never edit `~/.claude/settings.json` here — that's the permanent-install step, out of scope.
- If any step fails (non-zero exit, missing file post-init), surface the raw error and stop. Don't silently retry.
