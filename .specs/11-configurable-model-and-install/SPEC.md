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

1. **One sourced helper, `_model.sh`.** The three scripts differ only in whether they pass `--no-session-persistence`, so a single `brain_model_call <ephemeral> <system-prompt>` keeps every invocation identical to before by default and gives one place to configure. It ships beside the other memory-tools scripts (added to the build's executable list).
2. **Env file read by key, not sourced.** The scripts source the env file late, and sourcing overrides the environment, which contradicts the documented "the environment wins" rule. `_model.sh` instead reads only the `BRAIN_MODEL_*` keys, and only when the variable is unset. An empty `BRAIN_MODEL_ID` is a real value meaning "pass no model flag".
3. **Model failure no longer aborts through `set -e` in `observe.sh` and `reflect.sh`.** The call ends in `|| true`, so a failing CLI reaches the existing empty-result branch, which logs `claude-call-failed` and exits 1. Same exit code, better log.
4. **Provider seam covers text embeddings only.** `EMBED_PROVIDER` is `gemini` (default) or `openai` (any OpenAI-compatible `/embeddings` endpoint). That one adapter reaches Ollama, llama.cpp, LM Studio and vLLM, so "a local offline model" needs no extra code. Image, PDF and audio embedding use Gemini-only features and stay as they were.
5. **Dimensions are configuration, with a loud guard.** `EMBED_DIMENSIONS` (default 768) sizes the collections; a provider returning another size throws with a message naming the fix. Existing installs are unaffected.
6. **Non-Gemini providers are not priced.** The spend ledger uses a Gemini rate, so it would mislead for anything else; the per-tick kill switch still applies.
7. **Install = `install.sh` + a pure merge module.** The merge logic lives in `scripts/lib/merge-hooks.mjs` so it is unit tested without touching a real settings file. Our hooks are recognised by the command's tail (`claude-code/bin/<script>.sh`), which is what makes a renamed or moved checkout update in place instead of duplicating. Invalid JSON or an unexpected shape exits 3 and writes nothing; the first change to an existing file leaves a one-time `.the-brain.bak`.
8. **`agent init` is create-if-missing, never overwrite.** A rerun exits 0 (it used to exit 1 with "refusing to overwrite") and restores any missing seed file. `--link` is validated before anything is created, and an existing pointer to a different silo exits 3 unless `--relink` is given. Exit codes: 0 done, 1 bad arguments, 2 environment, 3 conflict. This changes the old "already exists" exit code from 1 to 0 on purpose, since idempotent is the requirement.
9. **Both optional watchers are opt-in, not just one.** The issue says "the extra watcher"; the media filer and `poke-agy` are both runtime-specific extras, so `BRAIN_WATCH_EXTRAS` (`media-filer`, `poke-agy`, `all`) governs both. This changes the default for existing OpenClaw or agy users, who must now set it; recorded in the changelog.
10. **Units are rendered, not symlinked or hand-edited.** `install-watcher.sh` and `install-timer.sh` fill `@PLACEHOLDER@` templates through `scripts/lib/render-unit.sh` (bash parameter expansion, so odd paths need no sed escaping; `%` is doubled for systemd). `install-timer.sh` also removes the symlinks the old version created. The snapshot timer was in scope because it had the same fixed-path assumption.
11. **Recall template is a plain Markdown block** (`templates/RECALL-INSTRUCTIONS.md`), not a skill, and `agent init` does not seed it (the seed kit is unchanged).
12. **Keyless dry run.** `EMBED_DRY_RUN=true` needs no key and makes no provider call; this is now tested. Index and search commands still contact Qdrant even in dry run, and the docs say so rather than implying otherwise.
13. **Test environment.** `pnpm install --frozen-lockfile` fails in the cloud sandbox because one transitive git-tarball dependency of `openclaw` is blocked by its proxy. Tests were run with every dependency except `openclaw` installed from the same versions. `tsc` there reports only errors from `openclaw` types and one Qdrant client typing (`core/qdrant/client.ts`), none in changed files.

## Follow-ups

- Route image, PDF and audio embedding through the provider seam (needs a multimodal-capable alternative).
- A provider-aware spend ledger, if hosted non-Gemini providers are used at volume.
- `agent init` imports the Qdrant client at startup, which prints a "Failed to obtain server version" warning to stderr when Qdrant is down. Harmless to the exit code; lazy-loading the client would silence it.
- Have `install.sh` optionally wire the MCP server entry in `settings.json`, as QUICKSTART step 5 does by hand.
- A migration helper for switching embedding provider on an existing install (new collections plus reindex).
- Windows-native support remains out of scope (bash-based loop).

## Review feedback

(None yet.)
