# #16: review log

Every finding from each review round on the pull request, with what was done
and the commit. The reviews were automated reviews posted by the maintainer;
they are described here as "a reviewer" and "an automated review". Commits are
short hashes on the branch.

Severity is as the review labelled it. Where a review gave no label the cell
says "unlabelled" (the first two reviews numbered their blocking problems
without a severity word). "Round 3" is the review of head `ec5a0ee`, "round 4"
the review of head `946d89d`, "round 5" the review of head `ca11aad`.

## Round 1: first review (head 1039b5b)

| Finding | Severity | Outcome | Commit |
|---|---|---|---|
| Two runs reclaiming a stale `mkdir` lock at once can both hold it, and losers can exit 1 | unlabelled (blocking) | Fixed: reclaim by atomic rename; every losing step skips with exit 0. Later superseded by the kernel lock (round 3) | cf5051b |
| A lock directory with no pid file is never reclaimed; trap set too late | unlabelled (blocking) | Fixed: trap set before the lock is taken; old pid-less lock reclaimed. Later superseded by the kernel lock (round 3) | cf5051b |
| Header comments still said the lock is flock only | Minor | Fixed | cf5051b |
| PR text omitted the fourth failing test (antigravity on-stop) | Minor | Fixed in the PR text | n/a |
| `_log.sh` uses GNU-only `date` `%3N` | Minor | Deferred, listed as a follow-up (outside this diff) | n/a |
| New tests ran bash 5, not 3.2; add a pid-less lock test | Minor | Pid-less tests added; `/bin/bash` use done in round 2 | cf5051b |

## Round 2: re-review (head 07b24e2)

| Finding | Severity | Outcome | Commit |
|---|---|---|---|
| `file_mtime` fell back from `stat -c` to `stat -f` per call, which prints a block under GNU stat and could exit 1 | unlabelled (blocking) | Fixed: flavour probed once; failures skip | 4194bff |
| Clearing a stale guard (age check then removal) is not atomic | unlabelled (blocking) | Narrowed and documented first (guard renamed away, limitation recorded); removed entirely in round 3 when the guard went away | 4194bff, a736ebb |
| Test shim had the same per-call fallback | unlabelled (part of the first problem) | Fixed: shim probes once | 4194bff |
| Lock tests should run under `/bin/bash` | Minor | Fixed | 4194bff |
| A test shim bug failed one test on the macOS runner (real stat is BSD there) | unlabelled (CI failure) | Fixed | 07b24e2 |

## Round 3: two reviews of head ec5a0ee, plus an automated review

| Finding | Severity | Outcome | Commit |
|---|---|---|---|
| A live owner can lose its lock (pid-less lock judged stale during pid publication) | Major | Fixed by replacing the pid-file lock with a kernel flock(2) lock; no pid file or reclaim remains | a736ebb |
| The `flock` and `mkdir` paths do not exclude each other | Major | Fixed: one protocol, taken with `flock` or perl on the same descriptor | a736ebb |
| Settings temp file briefly readable under a loose umask (code from an earlier change) | Major | Fixed: created with `wx` and mode 0600 before writing; final mode applied before the rename; tests added | a736ebb |
| Concurrency test did not exercise the vulnerable interval | Minor | Fixed: tests pause a run at a controlled point while it holds the lock, kill a holder, and cover mixed PATHs | a736ebb |
| An unreadable mtime aborts the rebuild | Minor | Fixed: `mtime_of` defaults to 0 at both call sites; test added | a736ebb |
| Automated review: empty mtime breaks the numeric comparison (same two call sites) | Minor | Fixed with the item above | a736ebb |
| 30 second delay before a dead reclaimer's guard is cleared | Minor | Accepted as a trade-off at the time; moot once the guard was removed | a736ebb |
| Branch carries commits from earlier changes | Minor | Not applicable: `origin/main` had not moved, so merging it was a no-op and the diff against it is only this issue's files | n/a |
| Earlier commits carry trailers and a personal author email | unlabelled | Left alone; rewriting would need a force-push, so it is for the maintainer to decide | n/a |
| One macOS run failed once in the antigravity on-stop teardown (ENOTEMPTY) | unlabelled (CI flake) | Fixed: teardown retries removal | 946d89d |

## Round 4: review of head 946d89d

| Finding | Severity | Outcome | Commit |
|---|---|---|---|
| "perl-only holder excludes a flock(1) run" assumes the host has `flock`; fails on macOS | Major | Fixed: skipped with a stated reason when the host has no `flock(1)`; the bin builder now throws if a requested tool is missing | c219fa8 |
| Two mixed-tool tests pass on macOS without testing what they say | Minor | Fixed: same skip, same guard in the bin builder | c219fa8 |
| perl reported every `flock` failure as "held" | Minor | Fixed: `EWOULDBLOCK` is 1, any other error is 3 and takes the warned, unlocked path; test added | c219fa8 |
| "Unlocked but still atomic" overstated: temp file in `$TMPDIR` can make `mv` a copy; other state can race | Minor | Fixed: temp files created next to their targets; wording narrowed in the script, CHANGELOG, SPEC and PR text; test for leftover temp files added | c219fa8 |
| `writeSync` may write partially; temp file left if the rename fails | Nit | Fixed: `writeFileSync(fd, ...)`; temp file removed if the rename fails | c219fa8 |
| Teardown retry does not wait for the detached rebuild | Nit | Left as is (reviewer called it acceptable); waiting would be a larger test change | n/a |
| Commit identity and trailers on the earlier commits | Nit | New commits use the default configured identity; earlier commits untouched; the identity question is left to the maintainer | c219fa8 |

## Round 5: review of head ca11aad (approved)

| Finding | Severity | Outcome | Commit |
|---|---|---|---|
| The flock(1)-vs-perl tests run on no CI host (macOS skips them, the Docker job does not run vitest) | Minor | Not fixed in CI (workflows and runners are out of scope). Wording corrected in the PR text, SPEC and test comments to say they run only on hosts with `flock` and are not run by the current CI; running them in CI is a SPEC follow-up | 0f0d093, plus the docs commit that adds this section |
| This log said the reviews came from people and an automated review | Minor | Reworded: automated reviews posted by the maintainer | 0f0d093, plus the docs commit that adds this section |
| Severities given for items the review never labelled | Nit | Marked "unlabelled" and the intro explains it | 0f0d093, plus the docs commit that adds this section |
| SPEC heading "third review round" disagreed with this log's "Round 4"; a long SPEC line | Nit | Heading renamed "review round 4"; line wrapped at 80 | 0f0d093, plus the docs commit that adds this section |
| A failed write leaves `MEMORY.md.XXXXXX` or `live-state.json.XXXXXX` next to user files | Nit | Fixed: the splice and the state write remove their temp files on failure (still returning non-zero); two tests added | 0f0d093, plus the docs commit that adds this section |
| Commit identity wording in this log | Nit | Made generic ("the default configured identity") | 0f0d093, plus the docs commit that adds this section |
| Commit identity itself | Maintainer's decision | Nothing done | n/a |
