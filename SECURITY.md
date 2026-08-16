# Security policy

## Supported versions

The brain is in early-stage open-source release (v0.x). Only the latest published release receives fixes. Pre-1.0 versions may be replaced rather than patched if the fix is invasive.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security-sensitive reports. The issue tracker is for general bugs and feature requests.

Instead, email **simon@inkie.ink** with:

- A clear description of the issue (one paragraph is fine)
- Steps to reproduce, or a minimal proof-of-concept if relevant
- Your assessment of impact (what an attacker could do)
- Whether you'd like to be credited in the fix changelog

You can expect:

- Acknowledgement within 72 hours (often the same day)
- An honest read on whether the report is in scope and what the timeline looks like
- A public advisory and changelog entry once a fix lands, with credit unless you'd rather stay anonymous

## What's in scope

- Code execution paths in the brain itself: the hook handlers, the shared `memory-tools/` shell scripts, the MCP server, indexer, observer pipeline, daemon and CLI
- Insecure handling of secrets: API keys, `.env` files (including the `BRAIN_ENV_FILE` override and the legacy fallback location), transcript content, observation content
- Path traversal or write-zone escape in the agent silo or brain vault layout, including the `<project>/.the-brain/memory_root` pointer file and the `AGENT_NAME` silo-routing path
- Prompt-injection vectors that compromise the observer or the memory-injection path, including anything that can get attacker-controlled text spliced into `MEMORY.md` between the live-block markers, or into a `SessionStart` injection
- Cross-silo recall leakage: anything that lets one agent's scoped `remembering` query return another silo's content when it should not
- Cost-exhaustion paths that bypass the shared embedding gate in `core/embedder/gate.ts`, since that gate is the only thing standing between a malformed corpus and an unbounded embedding bill
- Command injection in the `poke-agy` tmux wake path, which builds and sends keystrokes to a live terminal session

## What's out of scope (you'll get a friendly "not in scope" response)

- Vulnerabilities in third-party services we depend on (Qdrant, Google Gemini API, Anthropic API). Report those upstream.
- Issues that require an attacker to already have arbitrary code execution on the host running the brain.
- Issues in the user's own integration code, for example their custom hook scripts or their `~/.claude/settings.json` wiring.
- Theoretical issues without a demonstrated impact.
- The fact that observation and reflection content is sent to a third-party LLM. That is the design, it is documented, and choosing which model sees your transcripts is the operator's call.

## Why this matters

The brain holds ambient context from its user's coding sessions: code snippets, decisions, partial keys mistakenly pasted into a prompt, file paths, project structure. A compromise of the brain's storage layer or its recall API is a compromise of that ambient context. It also runs inside the agent's own hook path, so a compromise there is a compromise of the agent. We take this seriously; please flag anything that looks wrong.
