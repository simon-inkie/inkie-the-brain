# QUICKSTART — the-brain in 5 minutes

Goal: from zero → running brain → first `remembering` query in five minutes.

If you'd rather have an AI install it for you, see the **🤖 Install with AI** block at the top of [`README.md`](./README.md). The manual path below is what that prompt is asking your AI to follow.

---

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node 22+** | Runtime for hooks, MCP server, CLI | `node --version` |
| **pnpm** | Package manager (faster, less disk than npm) | `pnpm --version` — install via `corepack enable && corepack prepare pnpm@latest --activate` |
| **Docker** (or **Qdrant Cloud** account) | Vector store | `docker --version` |
| **Gemini API key** | Embeddings + observation LLM | Free tier at <https://aistudio.google.com/app/apikey> |
| **Claude Code** | Where the hooks fire | Installed and working |

If something's missing, install it first — the steps below assume the prerequisites are in place.

---

## 1. Start Qdrant

**Path A — local Docker (default, recommended):**

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v "$HOME/.the-brain/qdrant:/qdrant/storage" \
  qdrant/qdrant
```

Verify:

```bash
curl -s http://localhost:6333/healthz
# expected: {"title":"qdrant - vector search engine","version":"...","status":"ok"}
```

**Path C — Qdrant Cloud (escape hatch, free tier works):**

Sign up at <https://cloud.qdrant.io>, create a free cluster, grab the URL + API key. Set in your env:

```bash
export QDRANT_URL=https://xyz.eu-central.aws.cloud.qdrant.io:6333
export QDRANT_API_KEY=your-cloud-key
```

Same data shape; the brain doesn't care which side of the network it's talking to.

---

## 2. Clone, install, build

```bash
git clone https://github.com/simon-inkie/the-brain
cd the-brain
pnpm install
pnpm build
```

`pnpm build` runs `scripts/build.mjs` — bundles the Claude Code hook entry points into `dist/claude-code/bin/*.sh` (executable, with shebangs).

---

## 3. Set environment

The brain reads its API keys + config from `~/.the-brain/.env`:

```bash
mkdir -p ~/.the-brain
cat >> ~/.the-brain/.env <<EOF
GEMINI_API_KEY=your-gemini-key
# Optional — only if using Qdrant Cloud:
# QDRANT_URL=https://xyz.eu-central.aws.cloud.qdrant.io:6333
# QDRANT_API_KEY=your-cloud-key
EOF
```

Hooks load this file at startup (sandboxed envs don't inherit your shell's vars).

---

## 4. Wire the Claude Code hooks

Three hooks in `~/.claude/settings.json`. If you already have a `hooks` block, merge — don't replace.

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/the-brain/dist/claude-code/bin/user-prompt-submit.sh",
          "timeout": 5
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/the-brain/dist/claude-code/bin/on-stop.sh",
          "timeout": 5
        }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/the-brain/dist/claude-code/bin/on-pre-compact.sh",
          "timeout": 10
        }]
      },
      {
        "matcher": "manual",
        "hooks": [{
          "type": "command",
          "command": "<absolute-path-to>/the-brain/dist/claude-code/bin/on-pre-compact.sh",
          "timeout": 10
        }]
      }
    ]
  }
}
```

Replace `<absolute-path-to>` with the result of `pwd` from your `the-brain` checkout.

> **Where does this go?** Either `~/.claude/settings.json` (global — applies to every Claude Code session) or `<project>/.claude/settings.json` (per-project). Global is fine for v0; per-project lets you scope memory per worktree.

---

## 5. Wire the MCP server

The MCP server exposes the `remembering` tool to any MCP client (Claude Code, Cursor, etc.).

In `~/.claude/settings.json` (same file, separate section):

```jsonc
{
  "mcpServers": {
    "the-brain": {
      "command": "node",
      "args": ["<absolute-path-to>/the-brain/dist/mcp/server.js"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

Restart Claude Code so the MCP server registers.

---

## 6. First index + first query

```bash
# Index everything currently on disk
pnpm cli index

# expected: lines like "✓ indexed N points into agent-observations" etc.

# First semantic search
pnpm cli search "hello"

# expected: ranked results from anything you have in your brain vault
# (may be empty on a fresh install — that's fine)
```

If both commands run cleanly, the brain is alive.

---

## 7. Test the full loop

Open Claude Code, drop a meaningful prompt, and finish a turn:

```
> Tell me three interesting things about octopuses, then explain what an MCP server does.
```

After the turn ends, check that an observation landed:

```bash
ls -la ~/.the-brain/agents/default/memory/observations/
# expected: a fresh YYYY-MM-DD-HH-MM-SS.md file
```

Then verify the next session sees it:

```bash
pnpm cli search "octopus"
# expected: the observation showing up in results
```

If you see the observation file *and* it shows up in search, the full loop is working.

---

## Per-agent setup (optional)

If you want memory namespaced per project / per agent rather than one global silo, set `AGENT_NAME` in that worktree's `.claude/settings.json`:

```jsonc
{
  "env": {
    "AGENT_NAME": "my-cool-agent",
    "USER_NAME": "Your Name"
  }
}
```

`USER_NAME` and `AGENT_NAME` are also substituted into the observation + era-compression prompt templates so the LLM speaks about *you* and *your agent* by name. Both fall back to "the user" / "the agent" if unset — the system works without them.

---

## Troubleshooting

**`Qdrant connection refused`** — Docker container not running. Check `docker ps` shows the qdrant container. If it crashed, `docker logs qdrant` for the reason.

**`GEMINI_API_KEY not set`** — `~/.the-brain/.env` not being read. Check the file exists and the key is on its own line with no quotes. Hook scripts read the env file at startup — restart Claude Code after editing.

**No observations are landing after a turn** — check the hook is firing:

```bash
# Tail the brain's hook log:
tail -f ~/.the-brain/logs/hook-activity.jsonl
```

You should see `Stop` events on every turn-end. If nothing appears, the hook isn't wired into Claude Code (recheck `~/.claude/settings.json`).

**MCP server not showing up in Claude Code** — restart Claude Code after editing `~/.claude/settings.json`. Confirm with `claude mcp list` (or whichever your version's command is).

**Search returns nothing** — make sure you ran `pnpm cli index` at least once. The first index can take a few minutes if you have a populated `~/brain/` vault.

---

## What's next

- Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the design intuition
- Browse [`templates/OBSERVATION-PROMPT.md`](./templates/OBSERVATION-PROMPT.md) to see how observations are extracted
- Wire up the daemon (`pnpm watch`) for live re-indexing as you add files to `~/brain/`
- Set up the systemd units in `scripts/` (Linux only) for unattended operation
