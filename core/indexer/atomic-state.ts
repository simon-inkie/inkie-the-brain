/**
 * Crash-safe state persistence for the indexers.
 *
 * Every indexer keeps a JSON state file that drives cross-tick resume
 * (`index-state.json`, the message-index state, the asset-index state). All
 * three used to persist with a plain `writeFile` overwrite, which truncates the
 * real target and then streams the new bytes into it. A crash, SIGKILL, OOM
 * kill or power loss between the truncate and the last byte leaves a TRUNCATED
 * JSON file on disk. The next tick's `loadState()` does `JSON.parse` inside a
 * `try { } catch { return empty }`, so the corruption is SILENT: the indexer
 * does not error, it just decides it has never indexed anything and the resume
 * checkpoint is gone. State corruption of that shape has already killed
 * semantic recall workspace-wide once, and it took days to spot precisely
 * because nothing failed loudly.
 *
 * The fix is the standard POSIX write-then-rename dance:
 *
 *   1. write the full new payload to a temp file in the SAME directory
 *   2. `rename()` the temp file over the real target
 *
 * `rename(2)` is atomic when source and destination are on the same
 * filesystem: a concurrent reader sees either the complete old file or the
 * complete new file, never a torn one, and the real target is never opened for
 * writing at all. Keeping the temp file as a sibling of the target (rather than
 * in `os.tmpdir()`) is what guarantees "same filesystem" — a cross-device
 * rename fails with EXDEV and degrades to a non-atomic copy.
 *
 * DURABILITY BOUNDARY, deliberate: this covers process death (crash, SIGKILL,
 * OOM, uncaught throw), which is the failure mode actually observed in this
 * codebase — the page cache survives the process, so the kernel still holds the
 * complete bytes. It does NOT add `fsync` before the rename, so a kernel panic
 * or power cut could in principle order the rename ahead of the data. Closing
 * that last gap needs an fsync of the file (and strictly, of the directory).
 * That was consciously left out: it is outside the observed failure mode and
 * would widen the fs surface every caller's tests have to model. Documented
 * here so the gap is visible rather than silently assumed away.
 */

import { writeFile, rename, unlink, mkdir } from "fs/promises";
import { dirname } from "path";
import { randomBytes } from "crypto";

/**
 * Monotonic per-process counter. Two `writeFileAtomic` calls that are in flight
 * at the same instant in the same process must not share a temp path (see
 * `tempPathFor`), and the pid alone cannot separate them.
 */
let writeCounter = 0;

/**
 * Build the temp path for one atomic write of `targetPath`.
 *
 * Always a sibling of the target (same directory => same filesystem => the
 * rename is atomic rather than EXDEV).
 *
 * The suffix is pid + per-process counter + random, and every component earns
 * its place:
 *
 * - **pid** separates concurrent PROCESSES. Two CLI runs, or a CLI run
 *   overlapping the watcher daemon, legitimately write the same state file.
 * - **counter** separates concurrent CALLS INSIDE ONE PROCESS. This is not
 *   theoretical: `daemon/watcher.ts` arms a SEPARATE debounce `setTimeout` per
 *   changed file (`timers` is keyed by file path, so it only collapses repeats
 *   of the SAME file). Two files changing within the debounce window produce two
 *   independent async callbacks, each running `indexFile` -> `saveState`, with
 *   no mutex or queue between them. The unlink-side path is worse: the `unlink`
 *   handler calls `deleteAsset(path).catch(...)` as a FLOATING promise, outside
 *   the timer machinery entirely, so it can overlap an in-flight
 *   `indexAssetFile`. A pid-only temp name would put both writers in the same
 *   temp file and rename the interleaved result into place — reintroducing
 *   exactly the torn-write corruption this module exists to prevent.
 * - **random** separates a fresh process from the debris of a dead one. Pids are
 *   recycled, and a hard kill leaves its temp file behind; without the random
 *   component a new process inheriting that pid could collide with the corpse.
 *
 * NOTE: atomic rename prevents TORN state files. It does NOT serialise the
 * read-modify-write cycle around them — two concurrent `loadState -> mutate ->
 * saveState` sequences still last-writer-wins and one can drop the other's
 * entry. That is a separate (pre-existing) concern and is not what this module
 * claims to solve.
 */
export function tempPathFor(targetPath: string): string {
  writeCounter += 1;
  const unique = randomBytes(6).toString("hex");
  return `${targetPath}.tmp-${process.pid}-${writeCounter}-${unique}`;
}

/**
 * Write `data` to `targetPath` atomically: full write to a sibling temp file,
 * then rename over the target.
 *
 * The target's directory is created first, recursively. That is not a caller
 * convenience bolted on here, it is intrinsic to the primitive: the temp file
 * has to be a SIBLING of the target for the rename to be atomic, so the
 * directory must exist before the temp write, not merely before the final one.
 * On a fresh install the state directory does not exist yet, and owning the
 * `mkdir` here is what stops each new call site having to remember it.
 *
 * On failure the temp file is cleaned up best-effort and the original error is
 * rethrown, so a failed save leaves the PREVIOUS state file intact and no
 * litter behind. Callers keep whatever error handling they already had.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: string,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = tempPathFor(targetPath);
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, targetPath);
  } catch (err) {
    // Best-effort cleanup. Deliberately a try/catch and not `.catch()`: this
    // must swallow a synchronous throw too, and it must never mask `err`.
    try {
      await unlink(tempPath);
    } catch {
      /* the temp file may never have been created — nothing to clean */
    }
    throw err;
  }
}
