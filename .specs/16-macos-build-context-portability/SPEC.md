# #16: install-test fails every day on macOS: build-context tests fail

- Issue: #16
- Branch: claude/brain-16-macos-l1
- Started: 2026-10-14

## TL;DR

The macOS (native) L1 job fails because `build-context.sh` is not portable to
stock macOS. The first failure is `flock: command not found` (macOS has no
`flock`): the script read that as "another instance is running" and exited 0
without rebuilding, so every test that expects a rebuilt `MEMORY.md` failed.
Behind that, the script also used GNU `stat -c`, bash 4.3 negative array
subscripts, and empty-array expansion under `set -u` (an error in bash 3.2),
which broke the `--emit` and `--cached` paths that the antigravity
PreInvocation hook uses. All four are fixed in the script; regression tests run
it on Linux with `flock` hidden and a BSD-style `stat`.

Not verified here: a real macOS run (see Test plan). The acceptance criterion
of three green scheduled runs on `main` can only be met after merge.

## Scope

In scope:
- `build-context.sh`: portable lock, `stat`, array handling.
- Regression tests in `test/context-engine/build-context.test.ts`.
- CHANGELOG entry.

Out of scope:
- The non-fatal `ENOENT` for the embed spend ledger under `~/.the-brain/logs/`
  seen in the macOS log. It does not fail any test; left for a separate issue.
- `LC_ALL=C.UTF-8` at the top of the script. Whether macOS has that locale is
  unconfirmed; the macOS job will show it if it matters.

## Test plan

- `pnpm exec vitest run` on Linux: all suites pass.
- New tests (4 of 6 fail on the old script): without `flock` the block is
  rebuilt, lock is released, a live lock skips, a dead lock is reclaimed; no
  negative array subscripts in the source.
- Not run: macOS and bash 3.2 (no macOS or bash 3.2 available in the sandbox;
  bash 3.2 sources and the Docker daemon were unreachable). The empty-array
  guards use the bash 3.2 safe `${a[@]+"${a[@]}"}` form, reviewed by reading,
  not executed under 3.2. The macOS job in CI is the real check.
- `pnpm install --frozen-lockfile` fails in the sandbox (a git-tarball
  dependency of `openclaw` is blocked); tests ran with every dependency except
  `openclaw`, so `tsc` reports only `openclaw` module errors.

## Follow-ups

- Spend ledger `ENOENT` on a fresh runner (non-fatal).
- Confirm three consecutive green scheduled `install-test` runs on `main`
  after merge (the issue's acceptance).

## Log

### 2026-10-14: root cause and fix
- What changed: `build-context.sh` uses `flock` when present and an atomic
  `mkdir` lock otherwise; `file_mtime` helper (GNU then BSD `stat`); no
  `[-1]` subscripts; `${a[@]+"${a[@]}"}` for arrays that can be empty.
- Why: first causal failure in the latest scheduled macOS log was
  `build-context.sh: line 82: flock: command not found`, turned into a silent
  skip. Later lines show `REFLECTIONS[-1]: bad array subscript` and
  `REFLECTIONS[@]: unbound variable` (bash 3.2).
- Supersedes: nothing, additive. Follows up the note in the SPEC for #11.
