# Security policy

## Supported versions

The brain is in early-stage open-source release (v0.x). Only the latest published release receives fixes. Pre-1.0 versions may be replaced rather than patched if the fix is invasive.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security-sensitive reports — the issue tracker is for general bugs and feature requests.

Instead, email **simon@inkie.ink** with:

- A clear description of the issue (one paragraph is fine)
- Steps to reproduce, or a minimal proof-of-concept if relevant
- Your assessment of impact (what an attacker could do)
- Whether you'd like to be credited in the fix changelog

You can expect:

- Acknowledgement within 72 hours (often the same day)
- An honest read on whether the report is in-scope and what the timeline looks like
- A public advisory + changelog entry once a fix lands, with credit unless you'd rather stay anonymous

## What's in scope

- Code execution paths in the brain itself: hooks, MCP server, indexer, observer pipeline, daemon, CLI
- Insecure handling of secrets: API keys, `.env` files, transcript content, observation content
- Path-traversal or write-zone escape in the agent silo / brain vault layout
- Prompt-injection vectors that compromise the observer or memory-injection path

## What's out of scope (you'll get a friendly "not in scope" response)

- Vulnerabilities in third-party services we depend on (Qdrant, Google Gemini API, Anthropic API). Report those upstream.
- Issues that require an attacker to already have arbitrary code execution on the host running the brain.
- Issues in the user's own integration code (e.g. their custom hook scripts).
- Theoretical issues without a demonstrated impact.

## Why this matters

The brain holds ambient context from its user's coding sessions: code snippets, decisions, partial keys mistakenly pasted into a prompt, file paths, project structure. A compromise of the brain's storage layer or recall API is a compromise of that ambient context. We take this seriously — please flag anything that looks wrong.
