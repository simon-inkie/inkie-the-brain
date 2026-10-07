# the-brain

> Long-term memory for AI coding agents. Survives compaction. Searchable across sessions. Filesystem-first.

**Status:** v0.3.0. Adapters for Claude Code, Antigravity (agy) and OpenClaw all ship. Built around Qdrant, a pluggable embeddings provider (Gemini by default) and a hook-driven observation pipeline.

> **Looking for the design intuition?** See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), which explains why this matters and how the pieces fit together.

---

## 🤖 Install with AI (recommended, about 2 minutes)

Got Claude Code, Cursor, or another agentic AI? Paste this prompt to it:

> I'd like you to install **the brain** on my machine. It's an open-source memory layer for AI coding agents, giving them long-term memory, observation across sessions, and a shared knowledge vault any agent (Claude Code, Cursor, etc.) can read.
>
> Repo: <https://github.com/simon-inkie/inkie-the-brain>
>
> Please:
> 1. Clone the repo, read the README, follow `QUICKSTART.md`
> 2. Wire it into my Claude Code config (hooks + MCP server)
> 3. Verify it works with a test memory query (`pnpm run search "hello"`)
> 4. Walk me through what's running and how to use it
>
> Use my existing tools where you can (Node version manager, Docker if I have it, etc.). Ask me before installing anything system-wide. If the README doesn't answer something, surface it rather than guessing.

(Or follow the manual install in [`QUICKSTART.md`](./QUICKSTART.md).)

---

## What needs what

Two layers, with different requirements. Nothing in the memory loop needs an embeddings key.

| Layer | What it does | Needs |
|---|---|---|
| **Memory loop** (M1) | Observes, reflects, compresses eras and injects the memory block. Files on disk. | Only the model CLI your host already has (by default `claude`). No API key from this project; it runs on your existing model CLI and its plan (a Haiku-class call per observation, reflection and era compression). |
| **Semantic search** (M2) | Indexes into Qdrant and answers `remembering` / `pnpm run search`. | Qdrant, plus an embeddings provider. The default is a Google Gemini API key (free tier works); a local offline model works too, see [Embeddings provider](#embeddings-provider). |

`EMBED_DRY_RUN=true` runs the embedder with no key at all, which is the keyless way to check an install.

---

## What this does

Claude Code, and every other long-running agent, eventually compacts your conversation. When it does, you lose:

- Why you went a particular direction
- Hard-won debugging state
- Spec decisions made mid-session
- The shape of rejected alternatives

The brain captures all of that to disk *before* compaction destroys it, and re-injects it into the next session. You ship the same agent forward, with continuity.

**The moving parts:**

- **Context engine**: reads the live memory block (era summary, hot reflections, unprocessed observations) out of `MEMORY.md` and hands it to the `UserPromptSubmit` hook for injection. The block itself is assembled by `build-context.sh` in the shared shell layer.
- **Observer**: extracts structured observations from the transcript, driven by compaction rather than by every turn (see below)
- **Indexer**: embeds observations, reflections, references, brain vault files, conversation transcripts and multimodal assets into Qdrant
- **Embedder + spend gate**: one shared gate governs every embedding call, with a dry-run mode, a per-tick kill switch and a daily spend ledger
- **MCP server**: exposes the `remembering` tool to any MCP-aware client (Claude Code, Cursor, etc.) for semantic recall
- **Daemon**: file watcher for live re-index when content changes. The media filer and `poke-agy` watchers are opt-in (`BRAIN_WATCH_EXTRAS`)

### Observation is compaction-driven

Earlier versions fired an observation pass on a cooldown at every `Stop`. That produced a burst of LLM calls whenever an agent restarted and many turns had queued up. The current shape:

- **`PreCompact`** (both the automatic and the `/compact` trigger) forces an observation sweep, ignoring cooldowns. Compaction is the moment detail is about to be destroyed, so that is when capture has to happen.
- **`Stop`** fires **at most once per session**, as a session-end flush, and only when the session has never been observed and there is unobserved content. Every later `Stop` in that session is a no-op.

The knock-on effect is that the memory block is stable between compactions, which is what makes the optional `SessionStart` injection below worth having.

### Era compression has a byte cap

Reflections age into an era summary. That summary is capped (`ERA_SUMMARY_MAX_BYTES`, default 12,000 bytes): if a fusion pass produces something bigger, it is fed back through a re-distill prompt for up to `ERA_SUMMARY_CAP_PASSES` passes (default 3) rather than being allowed to grow without limit. If the cap prompt is missing, the loop is skipped and the run continues, with a warning.

---

## Quick install

Manual path. See [`QUICKSTART.md`](./QUICKSTART.md) for the five-minute walkthrough with troubleshooting.

```bash
# 1. Prerequisites: Node 22+, pnpm, Docker
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant

# 2. Clone + build
git clone https://github.com/simon-inkie/inkie-the-brain
cd inkie-the-brain
pnpm install
pnpm build

# 3. Semantic search only: set an embeddings key (Google AI Studio, free tier works).
#    Skip this for the memory loop alone, or to use a local model (see below).
mkdir -p ~/.the-brain
echo 'GEMINI_API_KEY=your-key-here' >> ~/.the-brain/.env

# 4. Wire the Claude Code hooks into ~/.claude/settings.json (idempotent, no prompts)
scripts/install.sh --skip-build

# 5. First index
pnpm index

# 6. Verify
pnpm run search "your query"
```

Steps 2 and 4 are one command in `scripts/install.sh`; see [Scripting the install](#scripting-the-install).

> **`pnpm run search`, not `pnpm search`.** pnpm ships a built-in `search` command that queries the npm registry, and a built-in beats a `package.json` script of the same name. `pnpm search "octopus"` will return npm packages and no error. Every other script in this repo (`index`, `build`, `stats`, `watch`, `agent`, ...) has no such collision and works either way.

---

## Adapters

Three runtimes ship, all reading and writing the same silos and the same Qdrant collections.

| Adapter | Path | Wiring | Notes |
|---|---|---|---|
| **Claude Code** | `adapters/claude-code/` | `hooks/hooks.json` (plugin) or `~/.claude/settings.json` | `UserPromptSubmit`, `Stop`, `PreCompact` (`auto` + `manual`). Built by `pnpm build` into `dist/claude-code/`. |
| **Antigravity (agy)** | `adapters/antigravity/` | `~/agents/<name>/.agents/hooks.json` | `PreInvocation` + `Stop`. Runs from the checkout via `tsx`; `pnpm build` does not bundle it. Read [`adapters/antigravity/hooks/README.md`](./adapters/antigravity/hooks/README.md) first: agy's hook schema is one nesting level different from Claude Code's and getting it wrong fails silently. |
| **OpenClaw** | `adapters/openclaw/` | `openclaw plugins install dist/plugin` and `dist/hooks` | Plugin plus hook pack. Built by `pnpm build`. |

**The shared shell layer lives inside the OpenClaw adapter, and that is not a mistake.** `adapters/openclaw/hooks/memory-tools/` holds `observe.sh`, `reflect.sh`, `build-context.sh` and `compress-era.sh`: the LLM-calling scripts that actually write observations, fold reflections, assemble the memory block and compress eras. All three adapters shell out to those same scripts. The Claude Code and Antigravity handlers resolve them through `CLAUDE_PLUGIN_ROOT` / `AGY_PLUGIN_ROOT` when installed, and fall back to `adapters/openclaw/hooks/memory-tools/` when running from a checkout, and `pnpm build` copies the directory into every adapter's `dist/` output. The location is historical: this layer was written when OpenClaw was the only runtime, and it has not been relocated because moving it would churn three adapters' resolution paths for no behavioural gain. Treat it as `memory-tools/` that happens to live under `openclaw/`, not as an OpenClaw-specific component.

### Optional: `SessionStart` injection

`adapters/claude-code/hooks/` also carries two `SessionStart` hooks. **Neither is listed in `hooks.json`**, deliberately: they are per-agent opt-ins, wired in your own `~/.claude/settings.json` rather than shipped as part of the plugin manifest.

- **`persona-inject.sh`** emits `~/agents/<AGENT_NAME>/CORE.md` inline, plus a first-action instruction to read the fuller persona files. It only does anything when `AGENT_NAME` is set. Note the path: persona files live under `~/agents/<name>/`, which is a *different* directory from the memory silo at `~/.the-brain/agents/<name>/`. One holds who the agent is, the other holds what it remembers. Claude Code truncates hook output over 10,000 characters, so the hook enforces a 9,500-byte cap on the assembled block and emits the read-wrapper alone (with a loud log line) rather than a truncated CORE. `pnpm build` runs `scripts/core-guard.mjs`, which recomputes the same arithmetic and fails the build if any `CORE.md` is too large, so an oversized CORE cannot reach a live session.
- **`obs-inject.sh`** moves the observation block out of the per-turn `UserPromptSubmit` injection and into the cached session prefix, which is cheaper because the block only changes at compaction. It is gated on `BRAIN_OBS_VIA_SESSIONSTART=1` and emits nothing while the flag is off. The flag governs both sides, so the block is never injected twice. Turn it on per agent, verify on that agent's next compaction, then move on.

### Optional: `statusLine` context bar

`adapters/claude-code/hooks/context-statusline.cjs` is a third opt-in, wired via the `statusLine` field in your project or user `~/.claude/settings.json` rather than `hooks.json`:

```json
{ "statusLine": { "type": "command", "command": "node /path/to/context-statusline.cjs" } }
```

It renders `<agent> │ <model> │ <dir> │ <context bar> <used>%`, normalising Claude Code's reported `remaining_percentage` against the auto-compact buffer (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, default 16.5%) so the bar reflects the usable window rather than the raw total. `AGENT_NAME` is read optionally and the segment is dropped when unset; it exists for a multi-agent setup that sets it per agent home (`~/agents/<name>/.claude/settings.json`), not something a normal single-user install needs. As a side effect it best-effort writes Claude Code's own `rate_limits` stdin field to `~/.the-brain/usage/rate-limits.json`, for anything that wants a real weekly-window usage percentage rather than a token-count proxy.

---

## Repo layout

```
core/              platform-agnostic logic
  context-engine/    memory block assembly
  observer/          trigger evaluation, transcript pointers, noise filter
  indexer/           files, messages, assets, collection routing, session discovery
  embedder/          text + asset embedding, and the shared spend gate
  qdrant/            client, collection bootstrap, search
  cross-linker/      related-file backlinks
  media-filer/       inbound media triage
  poke-agy/          wakes dormant agy-runtime agents on a new inbox message
adapters/          platform bindings (core MUST NOT import from adapters)
  claude-code/       Claude Code hooks + optional SessionStart injection
  antigravity/       agy PreInvocation + Stop hooks
  openclaw/          OpenClaw plugin + hook pack + the shared memory-tools/ layer
mcp/               MCP server, exposes the `remembering` tool
daemon/            file watcher (incremental reindex)
cli/               one-shot commands (index, search, stats, cross-link, agent, ...)
bin/               launchers for the CLI and the MCP server
templates/         observation + era-compression prompts, agent seed kit
scripts/           build, gates, ops (health-check, snapshots, blue-green swap)
test/              vitest suites organised by module
install-test/      Docker harness that runs the documented install on a clean image
docs/              architecture
```

**Invariant:** `core/` MUST NOT import from `adapters/`.

---

## Qdrant collections

| Collection | Sources |
|---|---|
| `brain-vault` | `~/brain/ideas`, `~/brain/decisions`, `~/brain/work`, `~/brain/projects`, `~/brain/learnings` |
| `io-observations` | `~/.the-brain/agents/<name>/memory/observations/*.md` |
| `io-reflections` | `~/.the-brain/agents/<name>/memory/reflections/*.md`, `references/*.md`, and each agent's `MEMORY.md` |
| `io-messages` | Claude Code session JSONL transcripts under `~/.claude/projects/` |
| `io-assets` | `~/brain/assets/**/*` (images, PDFs, audio) |

The `io-` prefix is the published schema and is load-bearing for existing installs, so it has not been renamed. Only the messages collection is env-overridable, because a full transcript rebuild wants somewhere fresh to build into (see Blue-green rebuilds below).

---

## Configuration

### Where agent memory lands

Each Claude Code session resolves its memory directory through this chain, first match winning:

1. `AGENT_NAME` env var, giving `~/.the-brain/agents/$AGENT_NAME/memory/`
2. `<project>/memory/` if it exists
3. `<project>/.the-brain/memory_root`, a file containing the path to use
4. `BRAIN_MEMORY_DIR` env var
5. `~/.the-brain/memory/` if it exists
6. `~/.the-brain/agents/<basename-of-project-dir>/memory/`

Tier 6 is the default for an install with no configuration, so a session started in `~/code/web-api/` writes to `~/.the-brain/agents/web-api/memory/`. There is no `default` silo unless you set `AGENT_NAME=default`.

Set `AGENT_NAME` and `USER_NAME` per worktree in that worktree's `.claude/settings.json`:

```jsonc
{
  "env": {
    "AGENT_NAME": "my-agent",
    "USER_NAME": "Your Name"
  }
}
```

Both are substituted into the observation and era-compression prompt templates at runtime, so the LLM speaks about *your* agent and *you* by name. Both fall back to "the agent" / "the user" if unset, and the system works without them.

Indexing attribution is derived separately and needs no configuration: `core/indexer/cc-session-discovery.ts` reads each session transcript's first-line `cwd` and uses its basename as the agent name, falling back to `AGENT_NAME` and then to `default`. There is deliberately no name table to maintain.

### Environment variables

The brain reads `~/.the-brain/.env` at startup, because hooks run in a sandboxed environment that does not inherit your shell. Resolution order is `$BRAIN_ENV_FILE`, then `~/.the-brain/.env`, then `~/io-data/.env` (a legacy location, kept so installs predating the `~/.the-brain/` layout keep working). Values already present in the environment always win; the file only fills gaps.

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | none | Semantic search only, with the default `gemini` embeddings provider. The memory loop does not use it. |
| `BRAIN_MODEL_CLI` | `claude` | CLI the memory loop (`observe.sh`, `reflect.sh`, `compress-era.sh`) calls. Reads the prompt on stdin, writes the answer to stdout. May carry leading words (`npx my-llm`). |
| `BRAIN_MODEL_ID` | `claude-haiku-4-5-20251001` | Model id passed to that CLI. Set it empty to pass no model flag. |
| `BRAIN_MODEL_ARGS` | `--print --strict-mcp-config` (plus `--no-session-persistence` for reflect and compress-era) | Fixed arguments before the model flag. Set it when the CLI is not `claude`. |
| `BRAIN_MODEL_FLAG`, `BRAIN_MODEL_SYSTEM_FLAG` | `--model`, `--system-prompt` | The flags that carry the model id and the system prompt. |
| `EMBED_PROVIDER` | `gemini` | `gemini` or `openai` (any OpenAI-compatible endpoint, including local servers). See [Embeddings provider](#embeddings-provider). |
| `EMBED_MODEL` | provider default | Embedding model. Required for `openai`. |
| `EMBED_DIMENSIONS` | `768` | Vector size of every collection. Must match the model. |
| `EMBED_BASE_URL`, `EMBED_API_KEY` | `http://localhost:11434/v1`, none | `openai` provider only. The key is optional for a local server. |
| `EMBED_QUERY_PREFIX`, `EMBED_DOCUMENT_PREFIX` | empty | `openai` provider only. Task prefixes some local models expect. |
| `EMBED_SEND_DIMENSIONS` | unset | `true` sends `dimensions` to servers that can truncate. |
| `BRAIN_WATCH_EXTRAS` | none | Extra watchers `pnpm watch` starts: `media-filer`, `poke-agy`, or `all`. |
| `BRAIN_ENV_FILE` | unset | Explicit path to the env file, ahead of both default locations. |
| `QDRANT_URL` | `http://localhost:6333` | Point at Qdrant Cloud or a non-default port. |
| `QDRANT_API_KEY` | empty | Required by Qdrant Cloud. |
| `BRAIN_VAULT_DIR` | `~/brain` | Root of the knowledge vault. |
| `BRAIN_STATE_DIR` | `~/.the-brain/state` | Where indexer state JSON files live. Falls back to `~/io-data` when that directory exists. |
| `BRAIN_MEMORY_DIR` | unset | User-global memory directory override (tier 4 above). |
| `AGENT_NAME`, `USER_NAME` | unset | Silo routing and prompt personalisation. |
| `BRAIN_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` for `~/.the-brain/logs/hook-activity.jsonl`. |
| `BRAIN_DEBUG` | unset | `1` makes the Claude Code hook handlers print their decision to stderr. |
| `BRAIN_OBS_VIA_SESSIONSTART` | unset | `1` moves the observation block from the per-turn hook to the cached `SessionStart` prefix. |
| `EMBED_DRY_RUN` | `false` | `true` returns zero-vectors, makes no embedding calls (so needs no key) and skips Qdrant mutations. Use it to watch indexer behaviour without spending. Index and search commands still need a reachable Qdrant. |
| `MAX_EMBEDS_PER_TICK` | `5000` | Hard kill switch, shared across text, image, PDF and audio paths. Exceeding it halts the tick loudly instead of bleeding cost quietly. |
| `EMBED_DAILY_BUDGET_USD` | `5` | Soft daily threshold in USD. Crossing it warns once per process per day; it does not halt. |
| `EMBED_DAILY_HARD_CAP_USD` | `20` | Hard daily threshold in USD. Crossing it halts the tick. |
| `EMBED_SPEND_LEDGER_PATH` | `~/.the-brain/logs/embed-spend-ledger.json` | The rolling spend ledger, in UTC day buckets, pruned at 30 days. |
| `GEMINI_EMBED_USD_PER_1K_TOKENS` | `0.00019` | Cost rate the ledger prices against. Override if pricing changes. |
| `EMBED_MAX_RETRIES` | `6` | Retries with exponential backoff on 429 and transient 5xx. |
| `BRAIN_MESSAGES_COLLECTION` | `io-messages` | Build a transcript re-index into a fresh collection. |
| `BRAIN_MESSAGE_INDEX_STATE` | under the state dir | Fresh state file for that rebuild, so it is a clean index rather than a delta. |
| `BRAIN_MESSAGES_SCORE_WEIGHT` | `0.93` | Ranking multiplier for the messages collection at search merge time. Must be a finite number greater than 0; anything else is ignored with a warning and the default applies. |
| `ERA_SUMMARY_MAX_BYTES` | `12000` | Byte cap on the era summary before the re-distill loop kicks in. |

---

## Embeddings provider

Semantic search embeds text through one seam, `core/embedder/provider.ts`, chosen by environment variables with no code edit. The memory loop does not use it.

| Provider | Set | Notes |
|---|---|---|
| `gemini` (default) | `GEMINI_API_KEY` | Optional `EMBED_MODEL` override. |
| `openai` | `EMBED_PROVIDER=openai`, `EMBED_MODEL`, optionally `EMBED_BASE_URL` and `EMBED_API_KEY` | Any server exposing `POST {EMBED_BASE_URL}/embeddings`: Ollama, llama.cpp, LM Studio, vLLM or a hosted service. |

A local, offline model, for example with Ollama, in `~/.the-brain/.env`:

```bash
EMBED_PROVIDER=openai
EMBED_MODEL=nomic-embed-text
EMBED_DIMENSIONS=768
EMBED_QUERY_PREFIX=search_query:
EMBED_DOCUMENT_PREFIX=search_document:
```

(after `ollama pull nomic-embed-text`).

Notes:

- **Dimensions are fixed per collection.** `EMBED_DIMENSIONS` must equal the model's output size. A wrong size fails loudly on the first call. Switching provider or model on an install that already has collections needs a fresh set: the old vectors are not comparable, and Qdrant fixes the size at creation.
- **Images, PDFs and audio stay Gemini-only.** Text, observations, reflections and transcripts go through the seam; the asset pipeline (`core/embedder/assets.ts`) still needs `GEMINI_API_KEY`.
- **Spend tracking is Gemini's.** Only the `gemini` provider is priced by the ledger; a hosted `openai` provider is not priced or capped by dollar amount, only by the per-tick kill switch. The per-tick kill switch applies to every provider.

---

## Scripting the install

For a downstream install (another project's setup script, a dependency checkout under any name), everything below is non-interactive and idempotent. Every path is derived from the checkout's own location.

```bash
scripts/install.sh --settings ~/.claude/settings.json --agent my-agent --link /path/to/worktree
```

It runs `pnpm install --frozen-lockfile` and `pnpm build` (skip with `--skip-build`), merges the hooks, then creates or repairs the silo. `--dry-run` reports the hook changes and writes nothing.

**Hook merge** (`scripts/install-hooks.mjs`). Adds `UserPromptSubmit`, `Stop` and `PreCompact` (`auto` and `manual`) to the target `settings.json`. Other settings and other hooks, including other hooks on the same event, are left alone. An entry from an earlier install is recognised by the tail of its command (`claude-code/bin/<script>.sh`), so a moved or renamed checkout has its path rewritten rather than duplicated. The original file is kept once as `settings.json.the-brain.bak`. A file that is not valid JSON is never written.

**`agent init <name> [--link DIR] [--relink]`.** Never prompts and is safe to re-run: existing files are left alone, missing seed files are restored.

| Exit | Meaning |
|---|---|
| 0 | Done: created, repaired or already in place |
| 1 | Bad arguments (missing or invalid name, unknown flag, `--link` directory absent) |
| 2 | Environment problem (a template is missing, a path is not writable) |
| 3 | `--link` already points at a different silo; pass `--relink` to repoint it |

`scripts/install.sh` exits 0 on success, 1 on bad arguments, 2 when Node, pnpm or the build is missing or fails, 3 when `settings.json` is unusable, and passes an `agent init` failure through unchanged.

**Services.** `scripts/install-watcher.sh` and `scripts/install-timer.sh` take `--root DIR` and render their systemd user units with that path.

**Telling the agent how to use memory.** [`templates/RECALL-INSTRUCTIONS.md`](./templates/RECALL-INSTRUCTIONS.md) is a runtime-neutral block (when to search, how to call search, where durable notes go) to paste into `AGENTS.md`, `CLAUDE.md` or any system prompt.

### Using a different model CLI

The memory loop shells out to one CLI, configured in `~/.the-brain/.env` or the environment (the environment wins):

```bash
BRAIN_MODEL_CLI=claude                       # the default
BRAIN_MODEL_ID=claude-haiku-4-5-20251001     # the default
```

For a CLI with other flags, set `BRAIN_MODEL_ARGS`, `BRAIN_MODEL_FLAG` and `BRAIN_MODEL_SYSTEM_FLAG` too. The CLI must read the prompt on stdin and write the answer to stdout. The loop passes it no key; the CLI authenticates itself.

---

## Operations

- **Health check.** `scripts/health-check.sh` reports on Qdrant, the collections, the systemd units, every agent silo and recent watcher activity. It **discovers** silos by listing `~/.the-brain/agents/*/` rather than reading a roster, so it needs no edit when you add an agent. Container and unit names are overridable with `QDRANT_CONTAINER` and `WATCHER_UNIT`.
- **Blue-green transcript rebuilds.** To rebuild the messages collection without downtime: index into a fresh collection with `BRAIN_MESSAGES_COLLECTION=io-messages-v2` and `BRAIN_MESSAGE_INDEX_STATE` pointing somewhere new, then cut over with `scripts/blue-green-swap.sh --new io-messages-v2`. The script is verify-before-destroy: it refuses to drop the old collection unless the new one exists and clears a minimum point count, and without `--confirm` it is a dry run that changes nothing. Always dry-run first.
- **Snapshots.** `scripts/snapshot-qdrant.sh` plus the matching systemd `.service` and `.timer` units. `scripts/install-timer.sh [--root DIR]` renders the units with your checkout's path, so the checkout can have any name and live anywhere.
- **Daemon.** `pnpm watch` runs the file watcher for live re-indexing. Two further watchers are opt-in through `BRAIN_WATCH_EXTRAS` (a comma list, or `all`): `media-filer` (OpenClaw inbound media) and `poke-agy`. Neither starts by default. `poke-agy` wakes dormant agy-runtime agents in tmux when a new inbox message arrives; it only considers agents whose `.runtime` file reads `agy`, and it expects the tmux session to be named `agents`. On any other session name it finds no window and silently does nothing.
- **Watcher as a service.** `scripts/install-watcher.sh [--root DIR] [--extras LIST]` writes a systemd user unit for a checkout at any path and enables it. Extras are off unless named.
- **Gates.** `pnpm check:leaks`, `pnpm check:leaks:self-test` and `pnpm check:licence` guard the published surface. The self-test proves every rule still fires; run it whenever you touch the rule set.

---

## What's different about this

- **Memory survives compaction.** The `PreCompact` hook captures observations *before* compaction destroys session detail. Other memory layers wait for next-turn injection; this one captures at the moment of loss.
- **Filesystem-first.** Observations, reflections and era summaries are markdown files on disk. Diffable. Git-able. Editable. No opaque blob store.
- **Multi-runtime.** Claude Code, Antigravity and OpenClaw adapters over one runtime-agnostic core, so adding another is small.
- **Multimodal.** The asset pipeline indexes images, PDFs and audio into the same searchable vector space.
- **Structured observations.** XML-tagged extraction (`<observations>`, `<current-task>`, `<suggested-response>`) so the same captured memory feeds both recall and continuation.
- **Cost is a first-class control.** Every embedding call in the system goes through one gate with a dry-run mode, a per-tick kill switch and a daily ledger. A runaway index halts instead of quietly spending.

---

## Roadmap

- [x] OpenClaw plugin + hook pack
- [x] Claude Code hooks (PreCompact / Stop / UserPromptSubmit)
- [x] Antigravity (agy) adapter
- [x] MCP server with `remembering` tool
- [x] Qdrant + Gemini multimodal indexing
- [x] Era compression with a byte cap and re-distill
- [x] Per-directory agent attribution, no roster to maintain
- [x] Shared embedding spend gate
- [ ] Codex CLI adapter
- [ ] Prompt-injection defence for agent-to-external-system communication
- [ ] Config schema and an `index-health` command
- [ ] Cursor adapter
- [ ] Hosted Qdrant alternative (Qdrant Cloud free tier works today as an escape hatch)
- [ ] Reference example silo with anonymised demo data
- [ ] One-shot installer

---

## Contributing

Issues and PRs welcome. The codebase is tight, tests live under `test/`, and the architecture doc explains the moving parts.

Before opening a PR, run `pnpm typecheck`, `pnpm test`, `pnpm check:leaks` and `pnpm check:licence`.

If you've got an adapter for a runtime that isn't already supported, that's the highest-leverage contribution.

---

## License

MIT, see [LICENSE](./LICENSE).

---

## Credits

Built by [@inkie](https://inkie.ink) starting April 2026, originally as the memory layer for a single autonomous agent. Open-sourced May 2026 after the design proved out across multiple agents and runtimes.
