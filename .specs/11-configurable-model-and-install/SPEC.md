# 11: Configurable memory-loop model + non-interactive install

Issue: #11. Deck-side companion: simon-inkie/inkie-deck#21.

## TL;DR

Let a downstream project (Deck) wire tier-3 agent memory with no prompts and no code edits: a configurable model CLI and ID for the memory loop, a config seam for the embedding provider, one idempotent install command, a scriptable `agent init`, path-agnostic systemd units with the extra watchers opt-in, and a runtime-neutral recall template. Docs say plainly that the loop needs only the host's model CLI and that only semantic search (M2) needs an embeddings key.

## Scope

In:

1. `observe.sh`, `reflect.sh`, `compress-era.sh` read the model CLI and ID from configuration, defaulting to today's behaviour.
2. Embedding provider seam for text embeddings (`EMBED_PROVIDER`), Gemini stays the default; an OpenAI-compatible endpoint covers a local offline model.
3. README and QUICKSTART corrected; keyless dry run confirmed.
4. `scripts/install.sh`: build, merge hooks into a target `settings.json`, optionally seed a silo.
5. `agent init <name>` scriptable: no prompts, idempotent, stable exit codes.
6. Systemd watcher unit takes the checkout path as a parameter; media-filer and poke-agy watchers become opt-in.
7. Runtime-neutral recall and memory template; setup skill no longer assumes `~/the-brain/`.

Out (see Follow-ups): non-Gemini providers for image, PDF and audio embeddings; the snapshot timer unit; wiring the MCP server in the installer.

## Acceptance

- `scripts/install.sh --settings <file> --agent <name>` run twice against a checkout with any directory name leaves one entry per hook (`UserPromptSubmit`, `Stop`, `PreCompact` auto and manual), existing hooks and other settings untouched, and a seeded silo.
- README and QUICKSTART say the loop needs only the model CLI; a key is only for semantic search.
- `agent init <name>` never prompts; rerun exits 0; documented exit codes are stable and tested.
- Model CLI and ID come from configuration in all three scripts; unset means the old defaults; existing tests pass.
- `EMBED_PROVIDER` and friends change the embedder with no code edits; dry run works with no key.
- The watcher starts no extra watcher unless asked.

## Test plan

- vitest: hook merge (fresh file, existing hooks, stale path from another checkout, rerun, invalid JSON), `agent init` (create, rerun, repair, link conflict, exit codes), model configuration (stub CLI records its argv), embedder provider selection, watcher extras parsing.
- Shell: run `install.sh` twice into a temp HOME against a renamed copy of the checkout; run `observe.sh` with a stub model CLI and no keys.
- `pnpm typecheck`, `pnpm test`, `pnpm check:leaks`, `pnpm check:licence`, `pnpm build`.

## Decisions log

(Updated alongside the code.)

## Follow-ups

(Items noticed but deliberately not done.)

## Review feedback

(None yet.)
