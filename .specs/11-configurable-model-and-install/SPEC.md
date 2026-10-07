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
14. **Quoting by consumer.** Hook commands are single-quoted (shell), unit paths are double-quoted (systemd), `Documentation=` is percent-encoded (URL). One escaping scheme would be wrong for at least one of them.
13. **Test environment.** `pnpm install --frozen-lockfile` fails in the cloud sandbox because one transitive git-tarball dependency of `openclaw` is blocked by its proxy. Tests were run with every dependency except `openclaw` installed from the same versions. `tsc` there reports only errors from `openclaw` types and one Qdrant client typing (`core/qdrant/client.ts`), none in changed files.

## Follow-ups

- Route image, PDF and audio embedding through the provider seam (needs a multimodal-capable alternative).
- A provider-aware spend ledger, if hosted non-Gemini providers are used at volume.
- `agent init` imports the Qdrant client at startup, which prints a "Failed to obtain server version" warning to stderr when Qdrant is down. Harmless to the exit code; lazy-loading the client would silence it.
- Have `install.sh` optionally wire the MCP server entry in `settings.json`, as QUICKSTART step 5 does by hand.
- A migration helper for switching embedding provider on an existing install (new collections plus reindex).
- Make `build-context.sh` macOS-portable (no `flock`, bash 3.2 empty-array expansion under `set -u`); its suite and the antigravity suites fail on macOS on main too.
- `isOurs` matches any command with our tail (a user's own wrapper with that tail would be rewritten); a dangling symlinked `settings.json` is replaced rather than written through; hook quoting assumes a POSIX shell.
- `BRAIN_MODEL_CLI` and `BRAIN_MODEL_ARGS` cannot carry an argument containing a space (split on whitespace); a wrapper script is the workaround.
- Windows-native support remains out of scope (bash-based loop).

## Review feedback

Opus review of PR 17: changes needed. Each point and the response:

1. **Blocker: hook commands unquoted.** Confirmed. `merge-hooks.mjs` now single-quotes the path, escaping any `'`. The recognition check already strips quotes, so reruns are idempotent and a legacy unquoted entry is upgraded in place. Tests run the written command through bash with a path containing a space, `$(...)`, `;` and a quote.
2. **Blocker: snapshot unit breaks on a spaced path.** Confirmed. `ExecStart` is quoted like the watcher's, and `Documentation=` uses a percent-encoded path (`urlencode_path`). Paths with a double quote, backslash or newline are refused (exit 1) instead of half-escaped. Test renders both units from a checkout with a space.
3. **Symlinked settings.json replaced, permissions loosened.** Confirmed. `install-hooks.mjs` resolves the real path before writing and copies the original mode onto the temp file. Test covers a symlink to a mode 600 file.
4. **Stale docs on the exit-code change.** Setup skill and `scripts/reindex-agent-silo.ts` updated. The PR body now says a rerun exits 0 and that exit 3 is a new failure path callers must handle.
5. **"No extra cost" overstated.** Reworded in README and QUICKSTART: no separate key, runs on the existing model CLI and its plan.

Re-review (approved with nits) follow-up:

- **Custom `--dist` not named `claude-code` duplicated hooks on rerun.** Confirmed. A hook now also counts as ours when its command exactly equals the one being installed, so reruns with the same custom dist are idempotent. Moving a custom dist still adds a second entry (no tail to match); documented in `merge-hooks.mjs`. Test added.
- Left as follow-ups: a user's own wrapper ending in the same tail would be rewritten; a dangling symlinked `settings.json` is replaced; quoting assumes a POSIX shell.

CI follow-up (macOS job):

- Two of this PR's tests failed on macOS and are fixed: the model-config tests now run the scripts from a copy whose `build-context.sh` is a no-op (that script needs `flock` and a newer bash than macOS ships, and has its own suite), and the spaced-path unit test compares against the resolved path (`/var` is `/private/var` there). `observe.sh` also piped the extracted system prompt through `head -n -0`, a no-op that BSD `head` rejects ("illegal line count"), so the script exited 1 on macOS before reaching the model call; the pipe is removed (output unchanged on GNU). The remaining macOS failures (`build-context`, antigravity) also fail on `main` at 5a80cf8 and are not changed here.

Nits:

- Log JSON escaping: done (`BRAIN_MODEL_CLI_LOG`, `BRAIN_MODEL_ID_LOG`).
- Whitespace splitting of `BRAIN_MODEL_CLI` and `BRAIN_MODEL_ARGS`: documented in `_model.sh` (wrap such a CLI in a script).
- Hook already under matcher `""` or `*`: now recognised for events without a matcher, so no duplicate.
- Opt-in watchers as a silent change: upgrade note added to the changelog; PR body calls out that both watchers were covered although the issue said "the extra watcher".
- Hosted `openai` provider not priced: now stated in the README.

### macOS: observe.sh sed

CI log showed `sed: extra characters at the end of } command` from `observe.sh`: BSD sed needs `;` before a closing brace. Fixed in `observe.sh` (nested block now ends `; }; }`). The remaining macOS L1 failures are `build-context.test.ts` (no `flock`, bash 3.2 empty-array handling), which also fail on main and are out of scope here.
