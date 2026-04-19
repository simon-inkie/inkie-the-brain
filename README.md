# the-brain

Unified memory + context engine for agentic CLIs.

**Status**: v0.2.0 — unified successor to the legacy `greymatter` + `io-memory` + `io-memory-hooks` repos. (Project renamed from `greymatter` → `the-brain` on 2026-04-19.) See `docs/merge-plan.md` for the migration rationale.

## What this does

- **Context engine** (per-turn): slice message history, inject memory block — bounds contents growth in long sessions
- **Observer** (event-driven): extract observations from conversations, reflect, compress
- **Indexer**: embed brain + observations + reflections + messages + assets into Qdrant
- **MCP server**: expose semantic search to agents
- **Daemon**: file watcher for live reindex

## Adapters

- `adapters/openclaw/plugin/` — OpenClaw context-engine plugin
- `adapters/openclaw/hooks/` — OpenClaw hook pack (observer, message-indexer, media-filer)
- `adapters/claude-code/` — *(planned)* Claude Code plugin format

## Install (once merge lands)

```bash
openclaw plugins install ~/io-projects/the-brain/adapters/openclaw/plugin
openclaw plugins install ~/io-projects/the-brain/adapters/openclaw/hooks
```

## Layout

```
core/              platform-agnostic logic (context-engine, observer, indexer, embedder, qdrant, etc.)
adapters/          platform bindings — core MUST NOT import from adapters
mcp/               MCP server entry point
daemon/            watcher
cli/               one-shot commands
memory-tools/      shell scripts + prompts (observe.sh, reflect.sh, build-context.sh, compress-era.sh)
scripts/           ops scripts (snapshot-qdrant, systemd units)
test/              vitest suites, organized by core module
docs/              handover, spec, decisions
```

**Invariant**: `core/` MUST NOT import from `adapters/`. Platform-specific code stays in adapter directories.

## Components

| Module | Role |
|---|---|
| `core/context-engine/` | Per-turn message slicing, memory-block injection, first-user preservation |
| `core/observer/` + `adapters/openclaw/hooks/io-observer/` | Event-driven observation + reflection pipeline (transcript-pointer pattern) |
| `core/indexer/files.ts` | Indexes brain + memory markdown into `brain-vault`, `io-observations`, `io-reflections` |
| `core/indexer/messages.ts` | Indexes OpenClaw session JSONL into `io-messages` |
| `core/indexer/assets.ts` | Images / PDFs / audio → `io-assets` (multimodal embeddings) |
| `core/embedder/` | Gemini Embedding 2 wrapper (text + multimodal), 768-dim |
| `core/qdrant/client.ts` | Thin Qdrant client with collection management + drift-aware counts |
| `core/cross-linker/` | Auto-adds `## Related` wiki links between semantically similar brain files |
| `core/media-filer/` | Watches `~/.openclaw/media/inbound/`, files into `brain/assets/` with sidecars |
| `mcp/server.ts` | MCP server exposing the `remembering` tool for semantic search |
| `daemon/watcher.ts` | Long-running file watcher — incremental reindex |
| `cli/index.ts` | One-shot commands (`index`, `search`, `stats`, `cross-link`, etc.) |
| `memory-tools/*.sh` | Bash scripts for observe / reflect / build-context / compress-era |

## Collections (Qdrant)

| Collection | Sources |
|---|---|
| `brain-vault` | `brain/ideas`, `brain/decisions`, `brain/work`, `brain/projects`, `brain/learnings` |
| `io-observations` | `memory/observations/*.md` |
| `io-reflections` | `memory/reflections/*.md` + `MEMORY.md` |
| `io-messages` | `~/.openclaw/agents/main/sessions/*.jsonl` |
| `io-assets` | `brain/assets/**/*` (images / PDFs / audio) |

## Docs

- `docs/context-engine-handover.md` — the-brain context engine design
- `docs/openclaw-context-engine.md` — plugin integration details
- `docs/transcript-pointer-refactor.md` — observer architecture
- `docs/merge-plan.md` — three-repo → one-repo migration plan
