# Recall and write memory (runtime-neutral template)

Paste this into whatever instruction file your agent runtime reads (`AGENTS.md`, `CLAUDE.md`, a system prompt, a persona file). Replace `<name>` with the agent's silo name (the `AGENT_NAME` it runs under) and `<brain>` with the absolute path of your the-brain checkout. Nothing in it is specific to one runtime.

---

## Memory

You have long-term memory that survives compaction and new sessions. Use it before redoing work and write to it when you learn something worth keeping.

### Read what is already in front of you

A block of recent memory (the era summary, recent reflections and unprocessed observations) is injected into your context for you. Read it first. It is the cheapest source and it is curated.

### Search before you rebuild

Before you re-derive a decision, re-investigate a bug, or ask the user something you may have been told already, search memory.

Search when:

- the task touches a topic you have worked on before, or the user says "again", "as before", "last time";
- you are about to make a design choice that earlier sessions may have settled;
- the injected block mentions something but not enough detail to act on.

Skip it when the answer is in the code or the current conversation.

How to search:

- With an MCP client, call the `remembering` tool: `query` is a natural language question; add `agents: ["__own__"]` to stay in your own silo, `from` and `to` (ISO dates) to bound by time, and `collections` to narrow (`io-observations`, `io-reflections`, `brain-vault`, `io-messages`, `io-assets`).
- Without MCP, from a shell: `cd <brain> && pnpm run search "your question" --agents __own__`. Use `pnpm run search`, not `pnpm search`, which is a different pnpm command.
- Search by meaning, not keywords. Ask the question you would ask a colleague. If the first result set is thin, rephrase once, then move on.

Treat results as leads, not facts. A memory can be stale: check anything that names a file, flag or function against the code before you rely on it.

Semantic search needs the embeddings provider to be configured. If it is not, the tool or command will say so; fall back to the injected block and to reading files under `~/.the-brain/agents/<name>/memory/` directly.

### Write what should last

Observations and reflections are written for you from the session transcript, so do not duplicate them. Write a note yourself only for durable facts that are not obvious from the code or the conversation:

- decisions and the reason behind them;
- user preferences and corrections to how you should work;
- constraints, deadlines and external references.

Put such notes as short Markdown files in `~/.the-brain/agents/<name>/references/` (create the directory if it is missing). One topic per file, a descriptive file name, the fact first and the reason after. They are indexed with the rest of your memory. Do not store secrets, credentials or personal data.

Update a note that has gone stale instead of adding a contradicting one, and delete a note that turned out to be wrong.
