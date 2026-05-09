---
title: "Memory that survives compaction is the brain's killer feature"
date: 2026-05-09
tags: [ideas, framing, claude-code, compaction]
type: idea
---

# Memory survives compaction

Claude Code (and every long-running coding agent) eventually compacts the conversation. When it does, you lose:

- Why you went a particular direction
- Hard-won debugging state
- Spec decisions made mid-session
- The shape of rejected alternatives

The brain captures all of that to disk *before* compaction destroys it via a `PreCompact` hook. Then re-injects it into the next session's first turn via `UserPromptSubmit`. You ship the same agent forward, with continuity.

## Why this is the right framing

Other memory layers in the agentic-dev space wait for next-turn-injection. The brain captures at the moment of loss — that's a different place in the lifecycle and it changes what's recoverable. Filesystem-first storage keeps it diffable, git-able, editable; no magic blob store.

## Fixture relevance

This file is in the fixture corpus to verify search returns multi-doc relevance: a query like "compaction" should return both this file and the architecture doc.
