# greymatter

Unified memory + context engine for agentic CLIs.

**Status**: v0.2.0 — in-progress merge of three repos (greymatter plugin, io-memory, io-memory-hooks) into one package. See `docs/MERGE-PLAN.md` and `brain/projects/greymatter-merge/PLAN.md`.

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
openclaw plugins install ~/io-projects/greymatter/adapters/openclaw/plugin
openclaw plugins install ~/io-projects/greymatter/adapters/openclaw/hooks
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
