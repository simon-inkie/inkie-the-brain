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

The lock is now one protocol on every host: an flock(2) lock on the lock file's
descriptor, taken with `flock(1)` when available and with `perl` (shipped with
macOS) otherwise. The kernel drops it when the holder exits, so there is no pid
file or stale-lock reclaim, a live owner cannot lose its lock, and runs that
found different tools still exclude each other. With neither tool the run
proceeds unlocked and says so on stderr (also when `flock` fails for a reason
other than contention; perl reports that as status 3).

Not verified here: a real macOS run (see Test plan). The acceptance criterion
of three green scheduled runs on `main` can only be met after merge.

## Scope

In scope:
- `build-context.sh`: portable lock, `stat`, array handling, mtime defaults.
- `scripts/install-hooks.mjs`: create the temp settings file exclusively with
  mode 0600 before writing (review finding on the code path this branch
  inherits from #11), with tests.
- Regression tests in `test/context-engine/build-context.test.ts`.
- CHANGELOG entry.

Out of scope:
- The non-fatal `ENOENT` for the embed spend ledger under `~/.the-brain/logs/`
  seen in the macOS log. It does not fail any test; left for a separate issue.
- `LC_ALL=C.UTF-8` at the top of the script. Whether macOS has that locale is
  unconfirmed; the macOS job will show it if it matters.

## Test plan

- `pnpm exec vitest run` on Linux: all suites pass.
- New build-context tests (run under `/bin/bash` on a PATH without `flock` and
  with a BSD-style `stat`): rebuild instead of skipping; lock released at exit;
  a run paused right after it takes the lock (controlled gate at the lock step,
  held for 5.5s, past the old 5s staleness limit) keeps it against three
  contenders and then finishes; a run paused after opening the lock file but
  before locking neither blocks nor corrupts; a holder killed at the
  pause point frees the lock with no reclaim step; mixed PATH in both
  directions (`flock(1)` holder vs perl-only run, and the reverse); neither
  tool available (rebuilds, warns); a non-contention flock failure (warns,
  runs unlocked, does not skip); no temp files left beside the targets, also
  when the splice or a state write fails; six concurrent runs over mixed PATHs
  give exactly five skips; an unreadable mtime defaults to 0 with no numeric
  error; no negative array subscripts in the source.
- The mixed-tool cases (`flock(1)` holder vs perl run, the reverse, six
  concurrent mixed runs) need a real `flock(1)`. They are skipped with a stated
  reason on hosts without one (stock macOS), and the bin builder refuses to
  silently drop a requested tool. They therefore run only on a host that has
  `flock` and runs vitest; the current CI does not run them (the macOS job
  skips them and the Docker job does not run vitest).
- New install-hooks tests: a 0600 settings file stays 0600 under umask 022 with
  no temp file left; a loose-mode temp file left by a crashed run is replaced;
  a symlink planted at the temp path is not written through.
- Not run: macOS and bash 3.2 (no macOS or bash 3.2 available in the sandbox;
  bash 3.2 sources and the Docker daemon were unreachable). The empty-array
  guards use the bash 3.2 safe `${a[@]+"${a[@]}"}` form, reviewed by reading,
  not executed under 3.2. The macOS job in CI is the real check.
- `pnpm install --frozen-lockfile` fails in the sandbox (a git-tarball
  dependency of `openclaw` is blocked); tests ran with every dependency except
  `openclaw`, so `tsc` reports only `openclaw` module errors.

## Known limitations

- The lock is advisory and per host (flock(2) on a local file). A child
  process that inherits fd 9 and outlives the run keeps the lock until it
  exits, as with `flock(1)` before this change.
- With neither `flock` nor `perl` on the PATH the run is unlocked (it warns).
  Only the MEMORY.md splice stays atomic (its temp file is created next to the
  target so the final `mv` is a rename); concurrent unlocked runs can still
  race on `live-state.json` (read-modify-write) and `era-summary.md`.

## Follow-ups

- Spend ledger `ENOENT` on a fresh runner (non-fatal).
- Run the mixed-tool lock tests in CI (for example install a `flock(1)` on the
  macOS runner, or run vitest in the Linux job); no CI job runs them today.
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

### 2026-10-14: CI run 163 on the first commit (macOS L1)
- Result: all `build-context`, `pre-invocation` and `on-stop` tests that
  failed in run 162 passed on the macOS runner. 449 of 450 passed; the one
  failure was a bug in this PR's own test shim: it forwarded to the real
  `stat -c`, which on macOS is BSD `stat` and rejects `-c`. The shim now
  tries `-c %Y` then `-f %m`.
- Supersedes: the claim above that the macOS job was unverified; the earlier
  entries stay as written.

### 2026-10-14: second review (stat flavour, guard clearing, tests)
- What changed: `file_mtime` is chosen once by probing (`stat -c %Y .`, then
  `stat -f %m .`) instead of falling back per call, because GNU `stat -f %m`
  treats `%m` as a filename and prints a multi-line block if the path vanished
  between calls. `path_age` fails (so the caller skips) on any unreadable
  mtime; the pid write no longer fails the run. A stale guard is renamed away
  and then removed rather than `rmdir`-ed after a separate age check. The
  guard-clearing race is narrowed, not eliminated: see Known limitations.
  Tests: stale guard cleared then lock reclaimed, fresh guard left alone, the
  test `stat` shim probes the real stat once, and the lock tests run the script
  with `/bin/bash`.
- Why: re-review at 07b24e2 (CI run 165 green on macOS and Docker) found the
  per-call fallback could exit 1 under `set -u`, and the guard clearing was not
  atomic.
- Supersedes: the guard-clearing description in the "review fixes" entry.

### 2026-10-15: one kernel lock protocol, install-hooks permissions
- What changed: the `mkdir` lock, pid file, guard directory and age-based
  stale handling are removed. The lock is a flock(2) lock on fd 9
  (`memory/.live-block.lock`), acquired with `flock(1)` if present, else with
  perl; exit status 1 means held (skip, exit 0), anything else means no usable
  lock tooling and the run continues with a warning. `file_mtime` remains a
  probe-once helper; a new `mtime_of` defaults an unreadable mtime to 0 at both
  call sites (latest reflection, each observation). `install-hooks.mjs` creates
  its temp file with `wx` and mode 0600 before writing, removes a leftover temp
  file first, then applies the final mode before the rename.
- Why: review found (1) a live owner could lose a pid-file lock if another run
  judged it stale in the window around pid publication, (2) the `flock` and
  `mkdir` paths did not exclude each other when two runs saw different PATHs,
  (3) the settings temp file was briefly readable under a loose umask, and (4)
  an empty mtime broke the numeric comparison. A kernel lock has none of the
  stale-lock states, so the first two cannot occur, and the earlier
  best-effort limitation about clearing a stale guard no longer applies.
- Dead ends: keeping the `mkdir` lock and publishing the pid atomically via a
  symlink still needed a compare-and-delete to reclaim a dead owner, which has
  the same window; it was dropped in favour of the kernel lock.
- Branch history: `origin/main` has not moved since this branch was created, so
  merging it is a no-op. The branch diff against `main` is exactly these 8
  files: `.specs/16-macos-build-context-portability/SPEC.md`,
  `.specs/16-macos-build-context-portability/REVIEW.md`, `CHANGELOG.md`,
  `adapters/openclaw/hooks/memory-tools/build-context.sh`,
  `scripts/install-hooks.mjs`, `test/antigravity/helpers.ts`,
  `test/context-engine/build-context.test.ts` and
  `test/scripts/install-hooks.test.ts`. The install-hooks and antigravity helper
  changes come from review findings and CI flakes, not from the issue's own
  scope (the build-context portability fix).
- Supersedes: the lock descriptions and the Known limitations of the earlier
  entries; those entries stay as written.
- Also: macOS CI run 166 failed once in `antigravity/on-stop.test.ts` teardown
  (ENOTEMPTY): the Stop hook starts `build-context.sh` detached, so it can
  still be writing into the silo when the directory is removed. Teardown now
  retries removal (`maxRetries`); the same code passed in the next run, so it
  was a flake rather than a product bug.

### 2026-10-15: review round 4
- What changed: the three mixed-tool tests are skipped when the host has no
  `flock(1)` and the test bin builder throws if a requested `flock` or `perl`
  is missing; perl reports a non-contention `flock` error as 3, which takes the
  warned, unlocked path instead of the "held" skip; the splice and
  `live-state.json` temp files are created next to their targets
  (`mktemp "$target.XXXXXX"`) so `mv` is a rename; the unlocked-run wording is
  narrowed (see Known limitations); `install-hooks.mjs` writes with
  `writeFileSync(fd, ...)` and removes its temp file if the rename fails. A test
  for the status-3 path and one for leftover temp files were added.
- Why: see REVIEW.md. The macOS job failed on one test that assumed a host
  `flock`.
- Left alone: the antigravity teardown retry (acceptable as is; waiting for the
  detached rebuild would be a larger test change).
- Supersedes: the "still replaced atomically" claim for the unlocked path.

### 2026-10-15: review round 5
- What changed: the splice and the `live-state.json` write now remove their
  temp files if the write or the rename fails (a failed step returns non-zero
  as before); two tests cover that. Wording corrected: the mixed-tool lock
  tests run only on a host with `flock` and are not run by the current CI;
  running them in CI is listed as a follow-up. REVIEW.md corrected and given a
  round 5 section. This heading and the one above now match the numbering in
  REVIEW.md.
- Why: see REVIEW.md round 5.
- Supersedes: the "third review round" label of the entry above.

### 2026-10-15: review round 8
- What changed: the lock pause test now pauses at the lock step itself, right
  after the lock exists, by wrapping whatever the script uses to take it
  (`flock`, `perl`, or `mkdir` of a lock directory), holds the pause for 5.5s
  and checks that three contenders still skip; a second test pauses after the
  lock file is open but before the lock is taken. The install-hooks tests gain
  one that records the temp file's mode at the moment its contents are written,
  via a preload that wraps the fs write calls. The scope sentence in the
  branch-history note above is corrected to the actual 8 files.
- Why: the earlier pause test gated the first `jq` call, which runs after the
  old directory lock had already published its owner id, so it could not
  expose the interval that mattered; the earlier permission test only checked
  the final mode.
- Verified to fail on the earlier code: the new pause test fails against the
  directory-lock script from `ec5a0ee` (a contender after 5.5s reclaims the
  owner-less lock and rebuilds); the permission-observer test fails against the
  `ec5a0ee` `install-hooks.mjs` (`path-after-write 644`).
- Not possible: pausing exactly at the `open` of the lock file; there is no
  hook there without changing the script. The nearest points are covered: after
  open and before locking, and right after locking.
- Supersedes: the "paused while holding the lock" description in the test plan.
