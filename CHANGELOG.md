# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning loosely follows [SemVer](https://semver.org/) — pre-1.0 is best-effort and breaking changes can land in any minor.

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

- **`core/indexer/cc-agent-mapping.ts` → `core/indexer/cc-session-discovery.ts`.** The old file hardcoded internal personas (Inkie team) and project-dir → agent mappings. Replaced with a generic single-agent discovery that respects `AGENT_NAME`. Multi-agent auto-mapping deferred to v1.
- **`scripts/health-check.sh`** — io-auto-mode classifier checks now optional. Skip with a friendly message if not installed; override path with `IO_AUTO_MODE_DIR` env var.
- **Systemd unit files** (`scripts/the-brain-watcher.service`, `scripts/snapshot-qdrant.service`, `scripts/snapshot-qdrant.timer`) — use `%h` (user-mode home expansion) instead of hardcoded `/home/simon`, so units resolve per-user without edit.
- **Test files** — generic `/home/test-user` placeholder paths. 18 pre-existing test failures fixed; suite is now 177/177 passing on a clean clone.

### Removed

- 9 internal/persona-bleed documents removed from the repo (preserved in a private archive). Brings the repo down to a clean OSS-shaped doc set.
- `cc-agent-mapping.ts` (replaced — see Changed).

### Security

- No committed secrets, `.env` files, JSONL silo data, or API keys (verified by full `git log -p --all` audit pre-launch).

---

## Older history (pre-public)

The project was developed privately under the name `greymatter`, then renamed to `the-brain` 2026-04-19, then re-architected for Claude Code in late April 2026 (the OpenClaw → Claude Code port). The pre-public history is preserved on the private GitLab mirror for the original author's own reference; it included internal personas, agent coordination notes, and other Inkie-team-specific content not relevant to public users.
