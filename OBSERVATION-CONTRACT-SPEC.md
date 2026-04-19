# Observation Contract Spec — Agent-Identity-Aware Observations

**Status:** v1 shipped 2026-04-17. Template canonical at `templates/OBSERVATION-PROMPT.md`.
**Context:** [CLAUDE-CODE-PORT-SPEC.md](./CLAUDE-CODE-PORT-SPEC.md), [multi-agent architecture](#future-multi-agent-implications).

---

## 1. The bug that surfaced this contract

The Brain's memory pipeline works like this:

```
Claude Code session (any cwd)
  └─ Stop hook → observe.sh → LLM → observation.md → build-context.sh → MEMORY.md
                                                                          │
                                                                          ▼
  OpenClaw-hosted Io session ─── reads MEMORY.md on prompt → acts on <current-task>
```

On 2026-04-17, Simon's `~/git-repos/inkie-app-v2-feature3` Claude Code session hit a vite bundle error. The observer captured it. `build-context.sh` promoted it into MEMORY.md's `<current-task>` block. Io's next turn read the live block, decided "fix npm run dev vite corruption" was its job, and tried to execute `pnpm add @dnd-kit/*` + `npm run dev` against Simon's working repo via OpenClaw's exec tool. io-auto-mode flagged the unfamiliar path → Telegram approval requests fired.

The memory pipeline worked flawlessly. The **semantics** were wrong: the observer emitted a `<current-task>` that wasn't Io's task.

## 2. The contract

Observations serve two distinct purposes:

| Purpose | Consumer | Output |
|---|---|---|
| **Memory** | Any future session that reads the vault | `<observations>` — pure captured information |
| **Continuation** | Io specifically, resuming its own work after compaction | `<current-task>` + `<suggested-response>` — directive for what Io should do next |

**Rule:** continuation tags are only valid when the source conversation is Io's own. Emitting them for any other agent's session produces a false task-queue entry that Io will try to action, with no context on the other agent's work.

## 3. Detection mechanism

The observation-prompt LLM detects agent identity by the **speaker label** used in the transcript slice:

| Transcript format | Source | Action |
|---|---|---|
| `[HH:MM] Io: ...` | OpenClaw-hosted Io session | Emit full format (obs + current-task + suggested-response) |
| `[HH:MM] Assistant: ...` | Claude Code session (any agent) | Emit `<observations>` only |
| `[HH:MM] Claude: ...` | Other Claude deployment | Emit `<observations>` only |
| Anything else | Unknown | Emit `<observations>` only |

Transcript formatting is the responsibility of the adapter:

- `adapters/openclaw/hooks/hooks/io-observer/handler.ts::triggerObservation` → formats with `Simon:` / `Io:` (OpenClaw's canonical labels)
- `adapters/claude-code/src/observe-trigger.ts::formatTranscript` → formats with `User:` / `Assistant:` (Claude Code's canonical labels)

Both adapters therefore give the LLM an unambiguous signal. Any future adapter must choose labels that make the agent's identity clear at the transcript level.

## 4. Template canonical location

Source of truth: `templates/OBSERVATION-PROMPT.md` in The Brain repo.

Build pipeline copies it to:

- `dist/hooks/templates/OBSERVATION-PROMPT.md` (OpenClaw hook pack)
- `dist/claude-code/templates/OBSERVATION-PROMPT.md` (Claude Code adapter)

Runtime consumption: `observe.sh` reads `${MEMORY_DIR}/OBSERVATION-PROMPT.md` with an embedded fallback prompt if the file is missing. New memory directories need to seed the template explicitly — **no runtime auto-seeding today**.

### Manual seeding (today)

```bash
# For a new agent directory
cp dist/claude-code/templates/OBSERVATION-PROMPT.md <agent-memory-dir>/OBSERVATION-PROMPT.md
```

### Planned seeding (future, unstarted)

When `claude-io/<agent>/` worktrees are scaffolded (see [multi-agent architecture](#future-multi-agent-implications)), seeding should happen at agent-creation time as part of the bootstrap flow. Target helper:

```bash
the-brain agent init <agent-name>
# → creates ~/.the-brain/agents/<name>/memory/
# → seeds OBSERVATION-PROMPT.md, OBSERVATION-PROMPT-NON-IO.md (if we split)
# → writes <agent-worktree>/.the-brain/memory_root pointer
```

## 5. Future: multi-agent implications

Once the multi-agent platform (`claude-io/<agent>/` worktrees + per-agent memory at `~/.the-brain/agents/<name>/`) is live, the identity model generalises:

**Per-agent memory dirs resolve via tier 1 of `resolveMemoryDir()`**, so each agent's observations stay private to its own memory. Cross-contamination (the bug that motivated this spec) becomes structurally impossible — the feature3 session would resolve to `~/.the-brain/agents/feature3/memory/`, never touching Io's.

The master agent's role then becomes **promotion**: read each agent's reflections, decide what belongs in the shared `brain/` vault, commit on main. At no point does one agent's `<current-task>` leak into another's action queue.

See [project_multi_agent_worktree_architecture.md](./memory/project_multi_agent_worktree_architecture.md) in auto-memory for the architecture sketch.

## 6. Downstream enforcement (not in scope)

This spec addresses the **observation stage**. The `<current-task>` block still lands in MEMORY.md for Io's sessions. Two downstream concerns are deliberately left open:

1. **Task-action boundary in Io's identity.** Even with correct observations, Io's identity prompt could be strengthened to treat `<current-task>` as *a hint it saw*, not *a command*. E.g., "check with Simon before acting on a task that references a directory outside your usual workspace." Tightens the safety gate a level deeper.
2. **Retrospective cleanup.** Existing MEMORY.md may already contain cross-contaminated `<current-task>` entries from before this fix. `build-context.sh` will overwrite on the next observation cycle, so this resolves naturally. If that cycle doesn't fire soon, manual trim of MEMORY.md is the fix.

## 7. Changelog

- **2026-04-17** — v1. Added agent-identity detection via speaker label. Seeded canonical template into `templates/`. Build script copies into both adapter dists. Spec written.
