# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning loosely follows [SemVer](https://semver.org/) — pre-1.0 is best-effort and breaking changes can land in any minor.

## [Unreleased]

### Fixed

- **The background indexer could silently fail to start after a context compaction.** The `PreCompact` hook opens a diagnostic log for the indexer's stdout and stderr, and that setup shared a try block with the spawn itself, so anything that stopped the log being created or opened (a permissions or ownership change on `~/.the-brain/logs`, ENOSPC, fd exhaustion, an ordinary file sitting where the directory should be) landed in the spawn's catch and the indexer was never started at all. Observability had quietly become a hard prerequisite for the work it was meant to observe. The two are now independent: a log that cannot be opened falls back to discarding the child's output, and the spawn goes ahead regardless. Spawn attempts, spawn errors and child exits are recorded in `hook-activity.jsonl` under one trace id, and the hook now waits briefly on the event loop after spawning so a failure such as `node` not resolving on `PATH` is logged before the hook process exits rather than lost to the race. The log descriptor is closed in a `finally`, so repeated compactions cannot leak one.

## [0.3.0] — 2026-08

Three months of work on the private side, brought across and re-scrubbed. The headline changes are the shape of the observation loop, a third adapter, and cost becoming a first-class control. Every documented command in `README.md` and `QUICKSTART.md` was run against this tree and its output matched to the doc.

### Added

- **Antigravity (agy) adapter** (`adapters/antigravity/`). `PreInvocation` and `Stop` hooks, running from the checkout via `tsx`. Its hook schema differs from Claude Code's by one nesting level and fails silently when wrong, so the adapter ships with its own README documenting the trap and the verified payload contract.
- **`SessionStart` persona and observation injection** (`adapters/claude-code/hooks/persona-inject.sh`, `obs-inject.sh`). Both are per-agent opt-ins wired in the user's own `settings.json`, not in the plugin manifest. `persona-inject` injects a distilled `CORE.md` into the cached session prefix under a 9,500-byte cap; `scripts/core-guard.mjs` enforces the same cap at build time so an oversized persona cannot reach a live session. `obs-inject` moves the observation block into the cached prefix, gated on `BRAIN_OBS_VIA_SESSIONSTART=1`.
- **Shared embedding spend gate** (`core/embedder/gate.ts`). One choke point for every embedding call across text, images, PDFs and audio: `EMBED_DRY_RUN` for a no-spend run, `MAX_EMBEDS_PER_TICK` as a system-wide kill switch, and a rolling daily spend ledger with a soft warning threshold and a hard cap.
- **Era summary byte cap with a re-distill loop.** `ERA_SUMMARY_MAX_BYTES` (default 12,000) with up to three re-distill passes through a new `templates/prompts/compress-era-cap.md`, replacing unbounded growth. Fails open if the prompt is missing.
- **Per-agent `references/` as a fourth index source**, routed into the reflections collection. Hand-written durable captures sat beside `memory/` and so fell outside every source glob.
- **Blue-green transcript rebuilds.** `BRAIN_MESSAGES_COLLECTION` and `BRAIN_MESSAGE_INDEX_STATE` let a full re-index build into a fresh collection against fresh state, and `scripts/blue-green-swap.sh` performs a verify-before-destroy alias cutover. Dry run unless `--confirm`.
- **`poke-agy` inbox watcher** in the daemon. Wakes a dormant agy-runtime agent through tmux when a new inbox message lands, since an agy agent cannot arm a watcher for itself. Scoped to agents whose `.runtime` file reads `agy`.
- **`BRAIN_ENV_FILE`** override for the env file location, ahead of both default paths.
- **Leak gate and licence gate** (`scripts/leak-gate.mjs`, `scripts/licence-gate.mjs`) with `check:leaks`, `check:leaks:self-test` and `check:licence` scripts. The self-test proves every rule still fires and that every carve-out is still load-bearing, so a dead exemption fails the build rather than quietly covering the next thing to land in that file.
- **`agent init` seeds the era-compression prompt set** into `memory/prompts/` alongside the observation contract.
- **`scripts/index-codex-normalized.ts`** for backfilling normalised transcripts.

### Changed

- **Observation is now compaction-driven.** `PreCompact` (both the automatic and the `/compact` trigger) forces an observation sweep. `Stop` fires at most once per session as a session-end flush, and only when the session has never been observed and there is unobserved content. Previously `Stop` ran the evaluator every turn, which produced a burst of LLM calls whenever an agent restarted with many turns queued. A useful side effect is that the memory block is now stable between compactions, which is what makes the cached `SessionStart` injection worthwhile.
- **Transcript indexing hardened.** Streamed reads from a verified byte offset instead of whole-file loads; work sized to the remaining tick budget with resumable partial checkpoints; retry with exponential backoff and jitter on rate limits and transient server errors; embedding concurrency reduced from 5 to 3. Dry-run no longer advances session state, so it is genuinely repeatable.
- **`scripts/health-check.sh` discovers agent silos** by listing the agents root rather than iterating a hardcoded roster, and the Qdrant container and systemd unit names are overridable with `QDRANT_CONTAINER` and `WATCHER_UNIT`. The previous defaults named units this repository does not ship, so the check reported two guaranteed failures on any honest install.
- **Daemon debounce raised to 5s** with a minimum re-embed interval per file, so a chatty path cannot tight-loop the embedder.
- **Collection routing for `references/`** requires both an `/agents/` and a `/references/` path segment, so a vault path containing a `references` directory is not mis-routed into a per-agent collection.
- **Systemd units and ops scripts derive their paths** from the script location or `%h` rather than assuming one checkout location, and carry an explicit note where a path still needs adjusting.
- **`README.md`, `QUICKSTART.md` and `docs/ARCHITECTURE.md` rewritten** against the current tree. The architecture document was a forward-looking port plan with phase estimates and open questions; it is now a description of what exists.

### Fixed

- **The documented env file was read by nothing.** `README.md` and `QUICKSTART.md` both told users to write `GEMINI_API_KEY` into `~/.the-brain/.env`, but every env loader (five inline TypeScript preambles, four shell scripts, a snapshot script and a systemd unit) resolved a different path. A fresh install following the documentation put its key somewhere the code never looked, and the failure surfaced as `GEMINI_API_KEY not set`. All eleven sites now resolve `$BRAIN_ENV_FILE`, then `~/.the-brain/.env`, then the legacy location, which is kept so existing installs keep working.
- **`scripts/index-all.sh` invoked a CLI path that has never existed** in this repository. The same stale path in the CLI's own usage text is corrected too.
- **`pnpm search` does not run this project's search.** pnpm ships a built-in `search` command that queries the npm registry, and a built-in beats a `package.json` script of the same name, so the documented command returned npm packages and exited successfully. Documentation now says `pnpm run search`, and the install-test harness check, which had the same bug, is fixed.
- **Type errors in the media filer** that had been suppressed with `continue-on-error` in CI and an escape hatch in the install-test build check. Both suppressions are removed and typecheck gates again.
- **QUICKSTART inaccuracies found by running every documented command**: the Qdrant `/healthz` endpoint returns a line of plain text, not the JSON banner shown; and with no configuration the memory silo is named after the project directory, not `default`, so the documented verification path did not exist on a default install.

### Removed

- **Vendor analytics telemetry** from the embedding path. The spend gate's own controls (dry run, kill switch, ledger, local telemetry) are untouched.
- **Three migration scripts** for a rename that predates the public release.
- **Agent-home and harness configuration files** that were published by mistake in the first release, along with the deployment-specific material inside two design documents. `OBSERVATION-CONTRACT-SPEC.md` was rewritten around the mechanism that actually ships rather than deleted, and its claims were re-checked against the code.

### Security

- Every published file is now scanned by the leak gate on demand, covering real names, private paths and hostnames, private repository and tracker identifiers, credential blocks, and a class of filenames that must never ship. Two carve-outs remain, both for the maintainer contact address, both narrow (one exact path plus one exact rule each) and both proven still necessary by the self-test.

---

## [0.2.0] — 2026-05 — first public release

The brain becomes open-source as a single-agent v0. Multi-agent auto-mapping is deferred to v1.

### Added

- **`docs/ARCHITECTURE.md`** — design intuition + Claude Code hook architecture (the killer-feature framing: memory-that-survives-compaction). Lifted out of an internal port spec and rewritten for the OSS audience.
- **`QUICKSTART.md`** — five-minute install walk-through covering Qdrant (Docker default + Cloud escape hatch), Gemini API key, hook wiring, MCP server, first index + first search, full-loop verification, troubleshooting.
- **`README.md`** — full rewrite. Front-of-file AI-install prompt block (paste into Claude Code or Cursor; the agent does the install), single-paragraph pitch, manual-install snippet, configuration via `AGENT_NAME` + `USER_NAME` envs, "what's different" framing.
- **`LICENSE`** — MIT (already declared in `package.json`; file was missing).
- **`SECURITY.md`** — vulnerability reporting flow.
- **`pnpm build`** — alias to `node scripts/build.mjs`. Documented in QUICKSTART.
- **Multi-agent attribution via `basename(cwd)`** — `core/indexer/cc-session-discovery.ts` reads each session's `cwd` from its first JSONL line and uses `basename(cwd)` as the agent name. Falls back to `process.env.AGENT_NAME`, then `"default"`. No persona names hardcoded; agents-as-directories.
- **Persona-name parameterisation** in observation + era-compression prompts. `{USER_NAME}` and `{AGENT_NAME}` are substituted at runtime by `observe.sh` / `reflect.sh` / `compress-era.sh` from env vars (defaults: "the user" / "the agent" so the system works with no setup).

### Changed

- **`core/indexer/cc-agent-mapping.ts` → `core/indexer/cc-session-discovery.ts`.** The old file hardcoded a private deployment's personas and its project-dir → agent mappings. Replaced with a generic single-agent discovery that respects `AGENT_NAME`. Multi-agent auto-mapping deferred to v1.
- **`scripts/health-check.sh`** — checks for an external classifier tool made optional. Skip with a friendly message if it is not installed, rather than failing the whole health check.
- **Systemd unit files** (`scripts/the-brain-watcher.service`, `scripts/snapshot-qdrant.service`, `scripts/snapshot-qdrant.timer`) — use `%h` (user-mode home expansion) instead of an absolute path under one real home directory, so units resolve per-user without edit.
- **Test files** — generic `/home/test-user` placeholder paths. 18 pre-existing test failures fixed; suite is now 177/177 passing on a clean clone.

### Removed

- 9 internal/persona-bleed documents removed from the repo (preserved in a private archive). Brings the repo down to a clean OSS-shaped doc set.
- `cc-agent-mapping.ts` (replaced — see Changed).

### Security

- No committed secrets, `.env` files, JSONL silo data, or API keys (verified by full `git log -p --all` audit pre-launch).

---

## Older history (pre-public)

The project was developed privately under the name `greymatter`, then renamed to `the-brain` 2026-04-19, then re-architected for Claude Code in late April 2026 (the OpenClaw → Claude Code port). That pre-public history is not part of this repository: it carried personas, agent coordination notes and other deployment-specific material with no meaning outside the private setup it grew in. The public history starts at the first tagged release.
