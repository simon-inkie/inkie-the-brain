# the-brain

> Long-term memory for AI coding agents. Survives compaction. Searchable across sessions. Filesystem-first.

**Status:** v0.2.0 — single-agent MVP. OpenClaw + Claude Code adapters shipping. Built around Qdrant + Gemini embeddings + a hook-driven observation pipeline.

> **Looking for the design intuition?** See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — explains *why* this matters and how the hook architecture works.

---

## 🤖 Install with AI (recommended — 2 minutes)

Got Claude Code, Cursor, or another agentic AI? Paste this prompt to it:

> I'd like you to install **the brain** on my machine. It's an open-source memory layer for AI coding agents — gives them long-term memory, observation across sessions, and a shared knowledge vault any agent (Claude Code, Cursor, etc.) can read.
>
> Repo: <https://github.com/simon-inkie/the-brain>
>
> Please:
> 1. Clone the repo, read the README, follow `QUICKSTART.md`
> 2. Wire it into my Claude Code config (hooks + MCP server)
> 3. Verify it works with a test memory query (`pnpm search "hello"`)
> 4. Walk me through what's running and how to use it
>
> Use my existing tools where you can (Node version manager, Docker if I have it, etc.). Ask me before installing anything system-wide. If the README doesn't answer something, surface it rather than guessing.

(Or follow the manual install in [`QUICKSTART.md`](./QUICKSTART.md).)

---

## What this does

Claude Code (and every other long-running agent) eventually compacts your conversation. When it does, you lose:

- Why you went a particular direction
- Hard-won debugging state
- Spec decisions made mid-session
- The shape of rejected alternatives

The brain captures all of that to disk *before* compaction destroys it, and re-injects it into the next session's first turn. You ship the same agent forward, with continuity.

**Five components:**

- **Context engine** — per-turn memory-block injection via `UserPromptSubmit` hook
- **Observer** — event-driven observation extraction at `Stop` + `PreCompact`
- **Indexer** — embeds observations, reflections, brain vault, conversations, and multimodal assets into Qdrant
- **MCP server** — exposes the `remembering` tool to any MCP-aware client (Claude Code, Cursor, etc.) for semantic recall
- **Daemon** — file-watcher for live re-index when content changes

---

## Quick install

Manual path. See [`QUICKSTART.md`](./QUICKSTART.md) for the 5-minute walkthrough with troubleshooting.

```bash
# 1. Prerequisites: Node 22+, pnpm, Docker
docker run -d -p 6333:6333 -p 6334:6334 qdrant/qdrant

# 2. Clone + build
git clone https://github.com/simon-inkie/the-brain
cd the-brain
pnpm install
pnpm build

# 3. Set Gemini API key (Google AI Studio → free tier works)
mkdir -p ~/.the-brain
echo 'GEMINI_API_KEY=your-key-here' >> ~/.the-brain/.env

# 4. Wire the Claude Code hooks (full config in QUICKSTART.md)
# Edit ~/.claude/settings.json — add UserPromptSubmit, Stop, PreCompact

# 5. First index
pnpm cli index

# 6. Verify
pnpm cli search "your query"
```

---

## Repo layout

```
core/              platform-agnostic logic (context-engine, observer, indexer, embedder, qdrant, etc.)
adapters/          platform bindings (core MUST NOT import from adapters)
  openclaw/        OpenClaw plugin + hook pack
  claude-code/     Claude Code hooks (PreCompact / Stop / UserPromptSubmit)
mcp/               MCP server — exposes `remembering` tool for semantic recall
daemon/            file watcher (incremental reindex)
cli/               one-shot commands (index, search, stats, cross-link, ...)
templates/         observation + era-compression prompt templates
scripts/           ops scripts (snapshot-qdrant, systemd units, health-check)
test/              vitest suites organised by core module
docs/              architecture
```

**Invariant:** `core/` MUST NOT import from `adapters/`.

---

## Qdrant collections

| Collection | Sources |
|---|---|
| `brain-vault` | `~/brain/ideas`, `~/brain/decisions`, `~/brain/work`, `~/brain/projects`, `~/brain/learnings` |
| `agent-observations` | `memory/observations/*.md` (per-agent silo) |
| `agent-reflections` | `memory/reflections/*.md` + `MEMORY.md` |
| `agent-messages` | Claude Code session JSONL files |
| `agent-assets` | `~/brain/assets/**/*` (images / PDFs / audio — multimodal) |

---

## Configuration

Single-agent v0: every observation routes to `process.env.AGENT_NAME` (defaulting to `"default"`). For per-project memory namespacing, set `AGENT_NAME` per worktree via that worktree's `.claude/settings.json`:

```jsonc
{
  "env": {
    "AGENT_NAME": "my-agent",
    "USER_NAME": "Your Name"
  }
}
```

`AGENT_NAME` and `USER_NAME` are also substituted into prompt templates at runtime (observation + era-compression), so the LLM speaks about *your* agent and *you* by name rather than generic placeholders.

Multi-agent auto-mapping by project dir is planned for v1.

---

## What's different about this

- **Memory survives compaction.** The pre-compact hook captures observations *before* Claude Code's compaction destroys session detail. Other memory layers wait for next-turn-injection; we capture at the moment of loss.
- **Filesystem-first.** Observations, reflections, era summaries are markdown files on disk. Diffable. Git-able. Editable. No magic blob store.
- **Multi-runtime.** OpenClaw + Claude Code adapters today; the core is runtime-agnostic so adding more is small.
- **Multimodal.** The asset pipeline indexes images, PDFs, and audio into the same searchable vector space (Gemini Embedding 2).
- **Structured observations.** XML-tagged extraction (`<observations>`, `<current-task>`, `<suggested-response>`) so the same captured memory feeds both *recall* and *continuation*.

---

## Roadmap

- [x] OpenClaw plugin + hook pack
- [x] Claude Code hooks (PreCompact / Stop / UserPromptSubmit)
- [x] MCP server with `remembering` tool
- [x] Qdrant + Gemini Embedding 2 multimodal indexing
- [x] Era compression (memory ageing)
- [ ] Cursor adapter (planned)
- [ ] Multi-agent auto-mapping (v1)
- [ ] Hosted Qdrant alternative (Qdrant Cloud free tier supported today as escape hatch)
- [ ] Reference example silo with anonymised demo data
- [ ] One-shot installer (`pnpm dlx the-brain init`)

---

## Contributing

Issues and PRs welcome. The codebase is tight (~10K LOC core), tests live under `test/`, and the architecture doc explains the moving parts.

If you've got an adapter for a runtime that isn't already supported, that's the highest-leverage contribution.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Credits

Built by **Simon Dixon** ([@inkie](https://inkie.ink)) starting April 2026, originally as the memory layer for his autonomous agent **Io**. Open-sourced May 2026 after the design proved out across multiple agents and runtimes.
