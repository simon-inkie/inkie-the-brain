# Observation contract: identity-aware observations

**Status:** v1, shipped 2026-04-17. Canonical template: [`templates/OBSERVATION-PROMPT.md`](./templates/OBSERVATION-PROMPT.md).

---

## 1. The failure this contract prevents

The memory pipeline runs like this:

```
Any Claude Code session, in any working directory
  └─ Stop hook → observe.sh → LLM → observation.md → build-context.sh → MEMORY.md
                                                                          │
                                                                          ▼
              The agent that owns that memory dir ─── reads MEMORY.md on prompt
                                                      → acts on <current-task>
```

An observation is not only a record. It can also carry a `<current-task>` block,
which the owning agent reads on its next turn as *what I was doing*. That makes
the observer's output a task queue, and a task queue is only safe if every entry
in it belongs to the agent reading it.

The failure mode, observed in practice: a Claude Code session working in an
unrelated project hit a build error. The observer captured it correctly.
`build-context.sh` promoted it into the `<current-task>` block of a memory dir
that a *different*, long-running agent reads. That agent's next turn read the
live block, decided the build error was its job, and started running package
manager commands against a repository it had never seen and had no context on.

The pipeline worked exactly as designed. The **semantics** were wrong: the
observer emitted a continuation directive for a session that was not the
reading agent's own.

## 2. The contract

Observations serve two distinct purposes, and only one of them is safe to emit
for an arbitrary session:

| Purpose | Consumer | Output |
|---|---|---|
| **Memory** | Any future session that reads the vault | `<observations>` — captured information, nothing directive |
| **Continuation** | The owning agent, resuming its own work after compaction | `<current-task>` + `<suggested-response>` — a directive for what to do next |

**Rule:** continuation tags are valid only when the source conversation is the
owning agent's own. Emitting them for any other session produces a false
task-queue entry that the owning agent will try to action, with no context on
the work it is picking up.

## 3. Detection mechanism

The observation-prompt LLM decides which of the two shapes to emit from the
**speaker label** used for the assistant's turns in the transcript slice. The
template is parameterised on `{AGENT_NAME}`, substituted at seed time:

| Assistant label in the transcript | Source | Action |
|---|---|---|
| `{AGENT_NAME}` | The owning agent's own session | Full format: observations + current-task + suggested-response |
| `Assistant` | A Claude Code session (any agent) | `<observations>` only |
| `Claude` | Another Claude deployment | `<observations>` only |
| Anything else | Unknown | `<observations>` only |

Producing that label is the adapter's job:

- `adapters/openclaw/hooks/hooks/io-observer/handler.ts` formats with
  `$USER_NAME:` / `$AGENT_NAME:` (falling back to `User:` / `Agent:`), so a
  session hosted by that adapter is labelled as the owning agent.
- `adapters/claude-code/src/observe-trigger.ts` and
  `adapters/antigravity/src/observe-agy.ts` both format with `User:` /
  `Assistant:`, the canonical labels of those runtimes.

Both label schemes give the LLM an unambiguous signal. **Any new adapter must
choose labels that make the session's identity clear at the transcript level**,
or its sessions will be observed under the wrong half of this contract.

## 4. Template location and seeding

Source of truth: [`templates/OBSERVATION-PROMPT.md`](./templates/OBSERVATION-PROMPT.md).

`scripts/build.mjs` copies it into both adapter bundles:

- `dist/hooks/templates/OBSERVATION-PROMPT.md` (OpenClaw hook pack)
- `dist/claude-code/templates/OBSERVATION-PROMPT.md` (Claude Code adapter)

At runtime, `observe.sh` reads `${MEMORY_DIR}/OBSERVATION-PROMPT.md`, with an
embedded fallback prompt if the file is missing. A memory dir therefore needs
its own copy.

`the-brain agent init <name>` seeds one, along with the era-compression prompt
set, when it creates the silo:

```bash
the-brain agent init <name>
# → ~/.the-brain/agents/<name>/memory/OBSERVATION-PROMPT.md
# → ~/.the-brain/agents/<name>/memory/prompts/compress-era-*.md
```

For a memory dir that predates the CLI, or one created by hand, copy the
template in directly:

```bash
cp templates/OBSERVATION-PROMPT.md <memory-dir>/OBSERVATION-PROMPT.md
```

## 5. Why per-agent memory dirs make this structural

With one shared memory dir, this contract is the only thing standing between an
unrelated session and another agent's task queue, and it is enforced by a
prompt: real, but soft.

With per-agent memory dirs — `~/.the-brain/agents/<name>/memory/`, resolved by
`resolveMemoryDir()` in `adapters/claude-code/src/memory-root.ts` — the
cross-contamination becomes structurally impossible instead. A session running
in its own directory resolves to its own silo and never writes into another
agent's. The prompt-level contract stays as defence in depth for the cases
where several sessions genuinely do share a memory dir.

## 6. Deliberately out of scope

This spec covers the **observation stage** only. Two downstream concerns are
left open on purpose:

1. **The task-action boundary.** Even with correct observations, an agent's own
   instructions can treat `<current-task>` as *something it saw* rather than
   *a command*, for example by requiring a check with the user before acting on
   a task that references a directory outside its usual workspace. That is a
   deeper safety gate than this contract, and it belongs to the agent's own
   configuration, not to the memory layer.
2. **Retrospective cleanup.** A MEMORY.md written before this contract landed
   may still hold a cross-contaminated `<current-task>`. `build-context.sh`
   overwrites the live block on the next observation cycle, so it resolves on
   its own; if that cycle is not due soon, trimming the block by hand is the
   fix.

## 7. Changelog

- **2026-04-17** — v1. Identity detection via speaker label. Canonical template
  seeded into `templates/`; the build copies it into both adapter bundles.
