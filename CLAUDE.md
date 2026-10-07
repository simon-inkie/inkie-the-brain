# inkie-the-brain

Long-term memory for AI coding agents. Filesystem-first, runtime-agnostic.

## Shared rules

This file is a pointer. The rules for every agent runtime are in
[AGENTS.md](AGENTS.md), imported below, and the workflow is in
[DEVELOPMENT.md](DEVELOPMENT.md); read both before your first change. There is
exactly one copy of the rules, so nothing here can drift.

@AGENTS.md

The `start-issue` skill lives once in `.agents/skills/start-issue/` and is
reachable from Claude Code through the `.claude/skills/start-issue` symlink.
Edit the canonical copy, not the link.
