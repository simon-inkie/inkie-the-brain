---
name: the-brain-setup
description: Set up the-brain memory for a new project or worktree — creates a dedicated agent memory silo and wires up a pointer file so observations, reflections, and era summaries land in the right place. Use when the user asks about setting up the-brain, creating a new agent, linking a worktree to a persona, or "getting memory working" for a repo.
---

# The Brain — Agent Setup

Guide the user through setting up a dedicated agent memory silo for the current repo/worktree, so the-brain knows where to store their observations and what persona owns them.

## Prerequisites — verify these first

Run these checks silently. Surface the first one that fails; skip the skill's main flow until the user fixes it.

1. **the-brain repo checked out.** Find it rather than assuming a name: it is the directory holding `cli/index.ts` and `scripts/install.sh`. Check `$BRAIN_ROOT` if set, the current directory and its parents, then the directory a `the-brain` command on `PATH` resolves into (`readlink -f "$(command -v the-brain)"`, two levels up). If none is found, ask the user for the path or tell them to clone `https://github.com/simon-inkie/inkie-the-brain.git` first. Use that path, whatever the directory is called, wherever `<repo>` appears below.
2. **Build exists.** Expected `<repo>/dist/claude-code/bin/user-prompt-submit.sh`. If missing, run `cd <repo> && pnpm install && node scripts/build.mjs` for them.
3. **Hooks wired into ~/.claude/settings.json.** Grep for `claude-code/bin/user-prompt-submit.sh` in `~/.claude/settings.json` (match the tail only, since the checkout directory can have any name). If missing, tell the user the permanent install hasn't been done yet. It is a separate one-time step, `<repo>/scripts/install.sh` (idempotent, no prompts; see the README), and NOT part of this skill.

If all three pass, continue.

## Gather the persona name

Ask the user (ONE question, AskUserQuestion if available):

> What should this agent be called? The name becomes the memory dir under `~/.the-brain/agents/<name>/` and sticks with the persona across renames/moves of the worktree. Examples: `voice-polish-bot`, `video-pipeline`, `the-brain-dev`.

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

1. Does `~/.the-brain/agents/<name>/` already exist? If yes, surface: "An agent named `<name>` already exists. Options: (a) reuse it — add the pointer only; (b) pick a new name." `agent init` never overwrites existing files (a rerun exits 0 and only restores missing seed files), so (a) is safe; the question is whether the user meant a different agent.
2. Does `<target>/.the-brain/memory_root` already exist? If yes, read it. If it points at the same agent, you're done. If it points at a DIFFERENT agent, surface: "This worktree is already linked to `<other-agent>`. Override?" Don't clobber silently.

## Run the init

From the the-brain repo dir, run:

```bash
cd <repo>
pnpm agent init <name> --link <target>
```

`agent init` never prompts and is safe to re-run. Exit codes: `0` done (created, repaired or already in place), `1` bad arguments, `2` environment problem, `3` the pointer already names a different agent (add `--relink` to repoint it, after confirming with the user).

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
3. `~/.the-brain/agents/<name>/memory/prompts/` contains the five era-compression prompts (`compress-era-level-0..3.md` and `compress-era-cap.md`)
4. `~/.the-brain/agents/<name>/MEMORY.md` exists and contains the anchor comments
5. `<target>/.the-brain/memory_root` exists and its first line resolves to step-1's dir

## Tell the user what happens next

Write this back to the user (adapt names to what they chose):

> Done. Memory for `<name>` now lives at `~/.the-brain/agents/<name>/memory/`.
>
> **To activate**: close this Claude Code session and open a fresh one in `<target>`. On first prompt, the UserPromptSubmit hook will inject an (initially empty) `<the-brain>` live block. At the end of the first turn with real content, the Stop hook fires its once-per-session flush and the first observation lands at `memory/observations/`. After that, Stop no-ops for the rest of the session and observation is driven by compaction: `/compact` (or an automatic compaction) always captures.
>
> Memory will persist across `/compact`, sessions, and even renaming/moving the worktree (the pointer file travels with it).
>
> To teach the agent when to search and what to write down, paste `<repo>/templates/RECALL-INSTRUCTIONS.md` into its instruction file (`CLAUDE.md`, `AGENTS.md` or equivalent).

## Skip / stop conditions

- Don't create dirs while user is mid-conversation if they didn't ask for it.
- Don't touch `<target>` outside `.the-brain/` and (if relevant) `.gitignore`.
- Never edit `~/.claude/settings.json` here — that's the permanent-install step, out of scope.
- If any step fails (non-zero exit, missing file post-init), surface the raw error and stop. Don't silently retry.
