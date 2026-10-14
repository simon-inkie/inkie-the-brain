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
- `_log.sh` uses GNU-only `date` `%3N` (milliseconds); BSD `date` prints a
  literal `3N`. Not changed here; it does not fail tests but log timestamps
  are wrong on macOS.
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

### 2026-10-14: review fixes for the mkdir lock
- What changed: reclaiming a stale lock is now serialised by a guard
  directory and the stale lock is renamed (`mv`) before removal, so a lock
  taken by another run in between is never deleted; the EXIT trap is set
  before the lock is taken and only removes a lock this run created (a flag);
  a lock with no pid is reclaimed once it is 5 seconds old; a guard left by a
  killed reclaimer is cleared after 30 seconds. Every run that loses a step
  takes the exit 0 skip path. Header comments no longer say the lock is only
  flock. Tests added: old pid-less lock reclaimed, fresh pid-less lock
  respected, 6 concurrent runs over a stale lock give exactly 5 skips.
- Why: review found that two runs seeing a dead pid could both `rm -rf` and
  `mkdir`, the second deleting the first's live lock (two holders, some
  losers exiting 1 under `set -e`), and that a run killed between `mkdir` and
  the pid write blocked all later runs forever.
- Note: the concurrency test passes on the previous revision too in this
  sandbox (the race is timing dependent), so it guards the property but did
  not reproduce the original race here; the other new test (old pid-less
  lock) does fail on the previous revision.
- Also: the antigravity failures in the original log are 3 PreInvocation plus
  1 `on-stop.test.ts` (30 total = 26 build-context + 3 + 1); all share the
  flock cause.
- Supersedes: the lock description in the previous entry.
