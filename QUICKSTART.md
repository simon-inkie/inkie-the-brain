# QUICKSTART: the-brain in 5 minutes

Goal: from zero, to a running brain, to a first `remembering` query in five minutes.

If you'd rather have an AI install it for you, see the **🤖 Install with AI** block at the top of [`README.md`](./README.md). The manual path below is what that prompt is asking your AI to follow.

---

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node 22+** | Runtime for hooks, MCP server, CLI | `node --version` |
| **pnpm 9 or 10** | Package manager | `pnpm --version`. Install with `corepack enable && corepack prepare pnpm@9.15.0 --activate` |
| **Docker** (or a **Qdrant Cloud** account) | Vector store | `docker --version` |
| **Gemini API key** | Embeddings and the observation LLM | Free tier at <https://aistudio.google.com/app/apikey> |
| **An agent runtime** | Where the hooks fire | Claude Code, Antigravity (agy) or OpenClaw. This guide wires Claude Code; see [`README.md`](./README.md#adapters) for the other two. |

Pin pnpm rather than taking `pnpm@latest`: CI and the Docker install-test image both use `9.15.0`, and the committed lockfile is version 9.0. pnpm 10 works too. pnpm 11 wants to rewrite the lockfile and will refuse to reuse a `node_modules` installed by an older major.

If something's missing, install it first. The steps below assume the prerequisites are in place.

---

## 1. Start Qdrant

**Path A, local Docker (default, recommended):**

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v "$HOME/.the-brain/qdrant:/qdrant/storage" \
  qdrant/qdrant
```

Verify:

```bash
curl -s http://localhost:6333/healthz
# expected: healthz check passed
```

`/healthz` returns that one line of plain text, not JSON. If you want the version banner instead, hit the root:

```bash
curl -s http://localhost:6333/
# expected: {"title":"qdrant - vector search engine","version":"...","commit":"..."}
```

**Path B, Qdrant Cloud (escape hatch, free tier works):**

Sign up at <https://cloud.qdrant.io>, create a free cluster, grab the URL and API key. Set them in your env (or in the `.env` file in step 3):

```bash
export QDRANT_URL=https://xyz.eu-central.aws.cloud.qdrant.io:6333
export QDRANT_API_KEY=your-cloud-key
```

Same data shape; the brain doesn't care which side of the network it's talking to.

---

## 2. Clone, install, build

```bash
git clone https://github.com/simon-inkie/inkie-the-brain
cd inkie-the-brain
pnpm install
pnpm build
```

`pnpm build` runs `scripts/build.mjs`. It bundles the Claude Code hook entry points into `dist/claude-code/bin/*.sh` (executable, with shebangs), copies the shared `memory-tools/` shell layer in beside them, builds the OpenClaw plugin and hook pack into `dist/plugin` and `dist/hooks`, and then runs the CORE guard. Expect `[build] CORE guard passed ...` and `[build] build complete` near the end, followed by three lines telling you where the three install targets landed.

The Antigravity adapter is **not** bundled. It runs from the checkout, so there is nothing to build for it.

---

## 3. Set environment

The brain reads its API keys and config from `~/.the-brain/.env`:

```bash
mkdir -p ~/.the-brain
cat >> ~/.the-brain/.env <<EOF
GEMINI_API_KEY=your-gemini-key
# Optional, only if using Qdrant Cloud:
# QDRANT_URL=https://xyz.eu-central.aws.cloud.qdrant.io:6333
# QDRANT_API_KEY=your-cloud-key
EOF
```

Hooks load this file at startup, because sandboxed environments don't inherit your shell's variables.

Every entry point resolves the env file the same way, first hit winning:

1. `$BRAIN_ENV_FILE`, if you set it, which is the escape hatch for a non-standard location
2. `~/.the-brain/.env`, the documented default and the one this guide uses
3. `~/io-data/.env`, a legacy location kept so installs that predate the `~/.the-brain/` layout keep working

Variables already present in the environment always win. The file only fills gaps, so exporting `GEMINI_API_KEY` in your shell overrides whatever the file says.

The full list of supported variables is in [`README.md`](./README.md#environment-variables). Two worth knowing on day one: `EMBED_DRY_RUN=true` runs the indexer end to end without making a single Gemini call, and `MAX_EMBEDS_PER_TICK` is the kill switch that stops a runaway index.

---

## 4. Wire the Claude Code hooks

Three hooks in `~/.claude/settings.json`. If you already have a `hooks` block, merge; don't replace.

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/inkie-the-brain/dist/claude-code/bin/user-prompt-submit.sh",
          "timeout": 5
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/inkie-the-brain/dist/claude-code/bin/on-stop.sh",
          "timeout": 5
        }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/inkie-the-brain/dist/claude-code/bin/on-pre-compact.sh",
          "timeout": 10
        }]
      },
      {
        "matcher": "manual",
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/inkie-the-brain/dist/claude-code/bin/on-pre-compact.sh",
          "timeout": 10
        }]
      }
    ]
  }
}
```

Replace `<absolute-path-to>` with the result of `pwd` from your checkout.

Both `PreCompact` matchers matter. `auto` is Claude Code compacting on its own; `manual` is you typing `/compact`. Wiring only one leaves half your compactions uncaptured.

> **Where does this go?** Either `~/.claude/settings.json` (global, applies to every Claude Code session) or `<project>/.claude/settings.json` (per project). Global is fine to start with; per project lets you scope memory per worktree.

### What each hook does

- **`UserPromptSubmit`** injects the current memory block as `additionalContext` on every prompt, so the model sees curated long-term memory even immediately after a compaction.
- **`PreCompact`** forces an observation sweep, ignoring cooldowns, because compaction is about to destroy the detail.
- **`Stop`** fires at most **once per session**, as a session-end flush, and only if that session has never been observed and there is unobserved content. It is not a per-turn trigger. If you are watching for an observation after every single turn, you will not see one, and that is correct behaviour.

### Optional: `SessionStart` injection

`adapters/claude-code/hooks/` also carries `persona-inject.sh` and `obs-inject.sh`. They are **not** in the plugin's `hooks.json`, because they are per-agent opt-ins you wire yourself in `~/.claude/settings.json` under a `SessionStart` block, exactly like the three above.

- `persona-inject.sh` injects `~/agents/$AGENT_NAME/CORE.md` into the cached session prefix. It does nothing unless `AGENT_NAME` is set. `pnpm build` fails if any `CORE.md` would exceed the 9,500-byte cap.
- `obs-inject.sh` moves the observation block from the per-turn injection into the cached session prefix, which is cheaper because that block only changes at compaction. It is inert until you set `BRAIN_OBS_VIA_SESSIONSTART=1`, and the same flag switches the per-turn hook off, so the block is never injected twice.

Skip both on a first install. Come back to them once the basic loop is working.

---

## 5. Wire the MCP server

The MCP server exposes the `remembering` tool to any MCP client (Claude Code, Cursor, etc.). It runs straight from source via `tsx`; there is no separate build step for it, and no `dist/mcp/` is produced.

In `~/.claude/settings.json` (same file, separate section):

```jsonc
{
  "mcpServers": {
    "the-brain": {
      "command": "npx",
      "args": ["tsx", "<absolute-path-to>/inkie-the-brain/mcp/server.ts"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

Restart Claude Code so the MCP server registers. Confirm with `claude mcp list` (or whichever your version's command is): you should see `the-brain` listed, exposing one tool, `remembering`.

---

## 6. First index and first query

```bash
# Index everything currently on disk
pnpm index

# expected: "Ensuring collections exist...", one "Indexing brain: <dir>" line per
# vault subdirectory, then a summary line of the form
#   Done: N files indexed (M chunks), K unchanged, R removed
# On a first run you will also see "Created collection: brain-vault" and the
# other four, plus "Created payload index: ..." lines.

# First semantic search
pnpm run search "hello"

# expected: ranked blocks, each headed "--- [0.693] <title> ---" (the number is
# the similarity score) with Source, Collection and a content preview, then a
# trailing "N results found."
# On a fresh install with nothing indexed yet, "No results found." is the
# correct answer, and the command still exits 0.
```

> **Use `pnpm run search`, never `pnpm search`.** pnpm has its own built-in `search` command that queries the npm registry, and a built-in wins over a `package.json` script of the same name. `pnpm search "hello"` will happily print npm packages and exit without any error to tell you what happened. No other script in this repo collides, so `pnpm index`, `pnpm build`, `pnpm watch` and the rest are fine as written.

If both commands run cleanly, the brain is alive.

---

## 7. Test the full loop

Open Claude Code, drop a meaningful prompt, and finish a turn:

```
> Tell me three interesting things about octopuses, then explain what an MCP server does.
```

The `Stop` hook flushes an observation once per session, so the first completed turn with real content is the one that produces a file.

**Work out where your silo is first.** With no configuration, memory is namespaced by the *directory name* of the project you're in, so a session started in `~/code/web-api/` writes to `~/.the-brain/agents/web-api/memory/`. There is no `default` silo unless you explicitly set `AGENT_NAME=default`. The full resolution chain is in [`README.md`](./README.md#where-agent-memory-lands).

```bash
# substitute your own project directory name
ls -la ~/.the-brain/agents/"$(basename "$PWD")"/memory/observations/
# expected: a fresh YYYY-MM-DD-HH-MM-SS.md file

# or just look at all of them
ls -la ~/.the-brain/agents/*/memory/observations/
```

Then verify the next session sees it:

```bash
pnpm run search "octopus"
# expected: the observation showing up in results
```

If you see the observation file *and* it shows up in search, the full loop is working.

Prefer a named silo to the auto-named one? Run this **from your checkout of this repository** (`pnpm` resolves scripts from the nearest `package.json`, so it will not work from your project directory):

```bash
cd <absolute-path-to>/inkie-the-brain
pnpm agent init my-agent --link /path/to/your/project
```

That creates `~/.the-brain/agents/my-agent/` with the full seed kit (observation contract, era-compression prompt set, live-state and `MEMORY.md`) and writes `/path/to/your/project/.the-brain/memory_root` pointing at it. Add `.the-brain/` to that project's `.gitignore`: the pointer is local machine state and would resolve to a different path for anyone else on the repo.

---

## Per-agent setup (optional)

If you want memory namespaced per project or per agent explicitly rather than by directory name, set `AGENT_NAME` in that worktree's `.claude/settings.json`:

```jsonc
{
  "env": {
    "AGENT_NAME": "my-cool-agent",
    "USER_NAME": "Your Name"
  }
}
```

`USER_NAME` and `AGENT_NAME` are also substituted into the observation and era-compression prompt templates, so the LLM speaks about *you* and *your agent* by name. Both fall back to "the user" / "the agent" if unset, and the system works without them.

---

## Troubleshooting

**`Qdrant connection refused`**: the Docker container isn't running. Check `docker ps` lists the `qdrant` container. If it crashed, `docker logs qdrant` for the reason. If you started Qdrant without `--name qdrant`, use the name or ID that `docker ps` actually shows.

**`GEMINI_API_KEY not set`**: `~/.the-brain/.env` isn't being read. Check the file exists and the key is on its own line with no quotes. Hook scripts read the env file at startup, so restart Claude Code after editing it. If your key lives somewhere else, point `BRAIN_ENV_FILE` at it rather than moving it.

**`pnpm search` returned npm packages**: that's pnpm's own `search` command, not this one. Use `pnpm run search "your query"`.

**No observations are landing after a turn**: first check you're looking in the right silo (see step 7; it is named after the project directory, not `default`). Then check the hook is firing:

```bash
# Tail the brain's hook log:
tail -f ~/.the-brain/logs/hook-activity.jsonl
```

You should see `"component":"user-prompt-submit","event":"hook-fired"` entries on every prompt. When an observation is attempted you also get a `"component":"observe-trigger"` entry whose `data` carries the originating `event` (`Stop` or `PreCompact`), a `fired` boolean and, when it didn't fire, the `reason`. If nothing appears at all, the hooks aren't wired into Claude Code (recheck `~/.claude/settings.json`). If `observe-trigger` says it didn't fire, remember `Stop` only flushes once per session; force an observation with `/compact`, which fires `PreCompact` and always observes. Setting `BRAIN_DEBUG=1` also makes the handlers print the same decision to stderr.

**MCP server not showing up in Claude Code**: restart Claude Code after editing `~/.claude/settings.json`. Confirm with `claude mcp list` (or whichever your version's command is).

**Search returns nothing**: make sure you ran `pnpm index` at least once. The first index can take a few minutes if you have a populated `~/brain/` vault.

**Indexing is spending more than you expected**: run it with `EMBED_DRY_RUN=true` to see exactly what it would embed without making any Gemini calls, and lower `MAX_EMBEDS_PER_TICK` from its default of 5,000. The daily ledger at `~/.the-brain/logs/embed-spend-ledger.json` records what has actually been spent.

---

## What's next

- Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the design intuition
- Browse [`templates/OBSERVATION-PROMPT.md`](./templates/OBSERVATION-PROMPT.md) to see how observations are extracted
- Wire up the daemon (`pnpm watch`) for live re-indexing as you add files to `~/brain/`
- Run `scripts/health-check.sh` for a one-shot report on Qdrant, the collections, the services and every agent silo
- Set up the systemd units in `scripts/` (Linux only) for unattended operation. They use `%h` for your home directory but still assume the checkout is at `%h/the-brain`, so adjust that path if yours differs.
