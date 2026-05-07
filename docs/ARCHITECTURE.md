# The Brain — Architecture & Claude Code Integration

**Goal:** memory that survives compaction. The brain wires Claude Code's hook system to a structured observation pipeline so an agent's lived context (decisions, in-flight tasks, accumulated facts) persists across sessions and surfaces back via semantic recall when the next session opens.

This document explains the design intuition and the hook architecture. For install steps, see `QUICKSTART.md`. For the API surface, see `README.md`.

---

## 1. The framing shift

The Brain in OpenClaw is a **context engine** — it slices the conversation array down to a bounded window and injects a memory block each turn. Its reason for existing is to fight OpenClaw's unbounded `contents` growth.

The Brain in Claude Code is a **memory system** — it exposes curated, compaction-proof long-term memory to the model via hook-level context injection. Claude Code handles context bounding natively via its own compaction. The Brain's value moves up the stack: **memory that survives compaction.**

This is the same codebase with the same observer pipeline, just reframed for what Claude Code actually needs.

### Why it matters

Claude Code compaction is destructive to session-local detail. Even with Opus 4.7 and 1M context, compaction fires eventually and summarises away:
- Why you went a particular direction
- Hard-won debugging state
- Spec decisions made mid-session
- The shape of rejected alternatives

The Brain's memory lives on disk (`memory/observations/`, `memory/reflections/`, `MEMORY.md`). After compaction, the next turn re-injects the live memory block. Continuity is restored, even though the session itself got summarised.

---

## 2. What ports, what doesn't

| Component | Fate | Mechanism |
|---|---|---|
| Message slicing (`sliceRecent`, `recentTurnCount`) | ❌ drop | Claude Code hooks cannot modify conversation history. Compaction is Claude Code's job. |
| Memory block injection (`readInjectedMemoryBlock`, `buildContext`) | ✅ port | `UserPromptSubmit` hook → emit `additionalContext` JSON |
| Observer pipeline (transcript-pointer, 3-trigger + cooldown) | ✅ port | `Stop` hook fires evaluator, same trigger logic |
| Pre-compaction capture | ✅ **new capability** | `PreCompact` hook → force observation sweep before destruction |
| Reflection + era-compression (shell scripts) | ✅ port as-is | `observe.sh`, `reflect.sh`, `build-context.sh`, `compress-era.sh` triggered by Node handlers |
| MCP server (semantic search) | ✅ wire up | Already standalone at `mcp/server.ts`; register in Claude Code MCP config |
| Multi-session coordination | ✅ natural fit | `cwd` in every hook payload → per-project (per-agent) memory namespacing |

---

## 3. Architecture

```
[user submits prompt]
        │
        ▼
   UserPromptSubmit hook ─── reads MEMORY.md live block (three-zone)
        │                     emits additionalContext: <memory> + <user prompt>
        ▼
   [Claude Code processes turn]
        │
        ▼
   Stop hook (per turn)
        │
        ▼
   evaluateShouldObserve() ── checks 3 triggers + 25min cooldown
        │
        ├─ fires → observe.sh (LLM pass) → memory/observations/*.md
        │         + reflection trigger check
        │         + build-context.sh (regenerates MEMORY.md live block)
        │
        └─ skips → exits silently

                                   [Claude Code compacts]
                                          │
                                          ▼
                                   PreCompact hook
                                          │
                                          ▼
                                   FORCE observation sweep
                                   (bypass cooldown — compaction is about
                                    to destroy context, capture now)

[next turn] → UserPromptSubmit again → re-injects fresh MEMORY.md → continuity restored
```

### Three hooks

| Hook | Matcher | Purpose |
|---|---|---|
| `UserPromptSubmit` | - | Inject MEMORY.md live block as `additionalContext` |
| `Stop` | - | Trigger observation sweep (respects cooldown) |
| `PreCompact` | `"auto"`, `"manual"` | Force observation sweep (bypasses cooldown) |

### MCP server

`mcp/server.ts` stays unchanged. Register once globally in `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "io-memory": {
      "command": "node",
      "args": ["<absolute-path-to>/the-brain/dist/mcp/server.js"],
      "env": { "GEMINI_API_KEY": "…", "QDRANT_API_KEY": "…" }
    }
  }
}
```

Provides the `remembering` tool — semantic search over brain + observations + reflections + messages + assets.

---

## 4. Per-agent namespacing

`cwd` is in every hook payload. Use it to scope memory per-agent (per-project):

```
~/.openclaw/workspace/           ← primary agent memory dir (existing)
├── memory/
│   ├── observations/
│   ├── reflections/
│   ├── observer-pointers/        ← per-session JSONL byte offsets
│   ├── observer-state.json
│   └── era-summary.md
└── MEMORY.md

~/claude-io/designer/             ← future designer agent
├── memory/
│   ├── observations/
│   └── …
└── MEMORY.md

~/claude-io/social/               ← future social-media agent
├── memory/
└── MEMORY.md
```

**Hook behaviour:** on fire, derive `MEMORY_DIR` from `cwd`:

- If `cwd/memory/` exists → use `cwd/memory/`
- Else check for `cwd/.the-brain/memory_root` override file
- Else fall back to a user-global default (`~/.the-brain/memory/` or `BRAIN_MEMORY_DIR` env)

**Parallel sessions in the same project** (same `cwd`) naturally share the same memory dir. They coordinate via the existing `observationInFlight` lock in `observer-state.json`.

---

## 5. Repo layout

Mirror the io-auto-mode dual-adapter pattern:

```
the-brain/
├── core/                                # platform-agnostic (unchanged)
│   ├── context-engine/
│   ├── observer/                        # (new split from adapter — see §7)
│   ├── indexer/
│   ├── embedder/
│   ├── qdrant/
│   ├── cross-linker/
│   ├── media-filer/
│   ├── config.ts
│   └── env.ts
├── adapters/
│   ├── openclaw/                        # existing, unchanged
│   │   ├── plugin/
│   │   └── hooks/
│   └── claude-code/                     # NEW
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── hooks/
│       │   └── hooks.json
│       ├── bin/
│       │   ├── user-prompt-submit.sh
│       │   ├── on-stop.sh
│       │   └── on-pre-compact.sh
│       └── src/
│           ├── user-prompt-submit.ts    # reads MEMORY.md, emits additionalContext
│           ├── on-stop.ts               # wraps evaluator + observe.sh trigger
│           ├── on-pre-compact.ts        # force-fire observation
│           └── memory-root.ts           # cwd → MEMORY_DIR resolution
├── mcp/server.ts                        # unchanged
├── daemon/watcher.ts                    # unchanged
├── cli/index.ts                         # unchanged
├── memory-tools/                        # scripts stay as-is
└── scripts/build.mjs                    # updated: also bundles claude-code hooks
```

---

## 6. Config

### Global defaults: `~/.the-brain/config.json`

```jsonc
{
  "memoryDir": "~/.openclaw/workspace/memory",   // fallback if no cwd/memory/
  "observer": {
    "messageThreshold": 6,
    "charThreshold": 500,                         // TODO: token-based (§9)
    "maxAgeMs": 14400000,                         // 4 hours
    "minGapMs": 1500000                           // 25 min cooldown
  },
  "memoryInjection": {
    "enabled": true,
    "maxChars": 40000,
    "source": "file",                             // "file" | "none"
    "memoryFile": "${memoryDir}/../MEMORY.md"     // live block lives inside MEMORY.md
  }
}
```

### Per-project override: `${cwd}/.the-brain/config.json`

Additive merge over global (same pattern as io-auto-mode). Per-project can tune thresholds for busy vs idle projects.

### Observer profile presets

Current thresholds (`messageThreshold: 6`, `charThreshold: 500`, `minGapMs: 25min`) were tuned for Gemini/OpenClaw with cost-conscious defaults. Different users want different aggressiveness:

```jsonc
// Three preset profiles — users pick one in config, or roll their own
"observer": {
  "profile": "balanced",   // "lean" | "balanced" | "generous" | "custom"
  "custom": { /* only used when profile: "custom" */ }
}
```

| Profile | msgThreshold | charThreshold | minGapMs | Use case |
|---|---|---|---|---|
| `lean` | 10 | 2000 | 45min | API-key users, cost-sensitive |
| `balanced` (default) | 6 | 500 | 25min | Current shipped defaults |
| `generous` | 3 | 250 | 10min | Max plan / unlimited subscription |

Profile just expands to explicit values at load time. `custom` lets advanced users set their own. This keeps v1 simple (one knob) while accommodating both ends of the cost spectrum.

---

## 7. Code changes needed in `core/`

The OpenClaw adapter currently has the observer handler in `adapters/openclaw/hooks/hooks/io-observer/handler.ts`. Most of that logic (evaluator, transcript reader, pointer management, noise filter) is platform-agnostic and should move into `core/observer/`:

```
core/observer/
├── evaluator.ts          # evaluateShouldObserve()
├── transcript.ts         # readTranscriptFromOffset(), pointer I/O
├── noise-filter.ts       # shouldSkipMessage(), SKIP_PATTERNS
├── state.ts              # observer-state.json I/O
└── types.ts              # Pointer, BufferedMessage, EvaluateParams, etc.
```

Both adapters (`openclaw` and `claude-code`) then import from `core/observer/` and handle only the event-binding + transcript-path derivation specific to their platform.

**Key invariant preserved:** `core/` must not import from `adapters/`.

---

## 8. Implementation phases

| Phase | Task | Est. |
|---|---|---|
| 0 | Extract observer internals from `adapters/openclaw/hooks/hooks/io-observer/handler.ts` into `core/observer/`. Update OpenClaw adapter to import from there. Verify 106/106 tests still pass. | 1-2h |
| 1 | Write `adapters/claude-code/src/memory-root.ts` — cwd → MEMORY_DIR resolution with override/fallback chain | 30m |
| 2 | Write `src/user-prompt-submit.ts` — read MEMORY.md live block, emit `additionalContext` JSON. Use existing `readInjectedMemoryBlock()` from `core/context-engine/`. | 1h |
| 3 | Write `src/on-stop.ts` — wraps `evaluateShouldObserve()` + fires `observe.sh` when due. Uses transcript-pointer logic from `core/observer/`. | 1-2h |
| 4 | Write `src/on-pre-compact.ts` — force-fire observation regardless of cooldown. `PreCompact` hook payload + behaviour verified via quick live test. | 1h |
| 5 | Build script — extend `scripts/build.mjs` to bundle the three Claude Code hooks alongside existing the-brain dist. | 30m |
| 6 | `adapters/claude-code/.claude-plugin/plugin.json` + `hooks/hooks.json` | 30m |
| 7 | MCP wiring — verify `mcp/server.ts` runs under Claude Code's MCP config. | 30m |
| 8 | Local install flow — `pnpm build && claude --plugin-dir ./dist/claude-code` (dev) or bake into `~/.claude/settings.json` (permanent) | 30m |
| 9 | Live UAT — observe memory/observations/ growing during a real session, verify re-injection after a `/compact` | 1h |
| 10 | Commit + update spec with any deltas | 30m |

**Total: ~8-11h.** Roughly a weekend build.

---

## 9. Out of scope (future work)

### Token-based thresholds (not char-based)

Current: `charThreshold: 500` — cheap but noisy. Code blocks and prose at same char count have very different information density.

Future: switch to token counting via `@anthropic-ai/tokenizer` or similar. Benefits:
- Maps directly to what the model sees
- Consistent across content types
- Aligns with cost/budget thinking
- Enables "we're at X% of context window, trigger early" logic

Defer until after v1 ships. Current thresholds work in practice.

### Revisit default thresholds post-launch

Current defaults assumed cost-conscious Gemini/OpenClaw usage. With Claude Code + Max plan, the real usage pattern is way more conversation per unit time. Defaults may need to shift:
- `balanced` profile might want `charThreshold: 1000` or higher (less frequent fires = less noise in observations)
- `minGapMs` of 25min is fine; the bottleneck shifts to *how much* we capture per fire, not *how often*

Plan: ship v1 with current `balanced` defaults, watch real observation logs for a week, tune based on data. The profile-preset mechanism makes this a config change, not a code change.

### Dynamic compaction-aware triggers

Read Claude Code's context-usage % from somewhere (`/context` command output? settings API?) and bias observation firing earlier when context is 70%+ full. Pre-empts PreCompact with a gentler version.

### Agent-scoped Qdrant

Current: single Qdrant instance with global collections. For directory-as-agent, each agent should query its own memory by default + optionally cross-search.

Options: metadata-filtered (agent_id field on each point) or collection-per-agent. Defer until we have 2+ agents running.

### Sub-agent awareness

When the main agent spawns a sub-Claude in a different directory (via Agent tool), the sub-Claude inherits that directory's memory. Parent agent's observer should capture the spawn + the result. Needs thinking about transcript-pointer ownership across processes.

### Cross-session memory lease

If I open 3 parallel sessions in the same project, do they all keep writing to the same observations/reflections? Current answer: yes, and they coordinate via `observationInFlight`. But what if session A and session B are having totally different conversations? Do we care?

v1 answer: share. Observations are per-agent (per-project), not per-session. If that causes noise, revisit.

---

## 10. Migration strategy

The Brain's OpenClaw adapter stays live throughout. The Claude Code adapter is additive — both can coexist:

- OpenClaw agents keep using the OpenClaw plugin + hook pack
- New Claude Code agents use the Claude Code adapter
- Both write to the same Qdrant collections + share the same brain/memory dirs (if they're in the same project)
- MCP server exposes memory identically to both

Eventual cutover: once your primary agent migrates to Claude Code, OpenClaw goes cold. Keep the OpenClaw adapter for a while as a compatibility shim, then retire when confident.

No big-bang migration. Parallel running is the default state.

---

## 11. Open questions

- [ ] What's the `PreCompact` hook payload look like? Does it pass the about-to-be-summarized message range, or just a trigger? (need to test)
- [ ] `Stop` hook — does it fire on every sub-agent stop too, or only main? If every sub-agent, we might over-observe
- [ ] `UserPromptSubmit` — can `additionalContext` be 40k chars, or is there a limit? Test empirically
- [ ] Does Claude Code dedup `additionalContext` if the same text is injected every turn? Or does the memory block repeat itself into the conversation? Might need to hash + skip if unchanged
- [ ] Session resume — does `/resume` fire `SessionStart` with `source: "resume"`? If so, we can skip cold-start observation check
- [ ] How does the MCP server access the right memory dir? It's project-scoped now (per-agent), but MCP is global. Either pass `cwd` into every tool call, or make the `remembering` tool take an explicit `agent` param

---

## 12. Success criteria

- [ ] During a normal Claude Code session, observations accumulate in `memory/observations/` at the expected cadence (roughly every 25-30 min of active chat)
- [ ] After a manual `/compact`, the next prompt injects MEMORY.md and the model demonstrably remembers pre-compaction facts
- [ ] `PreCompact` hook fires and captures a final observation before the compaction finishes
- [ ] MCP `remembering` tool returns relevant hits on brain files from within a Claude Code session
- [ ] Multiple parallel sessions in the same project share memory cleanly (no lost observations, no duplicate fires)
- [ ] Installation is a single edit to `~/.claude/settings.json` + `pnpm build`
