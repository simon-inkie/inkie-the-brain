/**
 * Shared `fs/promises` write-half mock modelling the atomic write-then-rename
 * that every indexer `saveState` performs.
 *
 * The indexer suites mock `fs/promises` wholesale, so once `saveState` stopped
 * calling `writeFile(statePath, ...)` directly they all needed a `rename` in
 * their mock. Rather than paste a hand-rolled fake filesystem into ~10 mock
 * factories, they share this one, which actually MODELS the semantics instead
 * of stubbing them: bytes land in a pending temp file and only become visible
 * at the target when `rename` publishes them.
 *
 * That matters for more than convenience. A mock where `writeFile` published
 * straight to the target would keep passing if someone reverted `saveState` to
 * a plain overwrite — the suites would assert nothing about atomicity. With
 * this mock a plain overwrite writes to the target path, `onPublish` never
 * fires, and the state assertions go red.
 *
 * NOTE: `mkdir` is deliberately NOT part of this helper. `writeFileAtomic`
 * creates the state directory itself, so every consuming factory still needs
 * its own `mkdir` entry; keeping it out of the spread means a factory that
 * forgets one fails loudly rather than being silently patched over here.
 */

import { vi, type Mock } from "vitest";

export interface AtomicStateFsMock {
  /** Spread into a `vi.doMock("fs/promises", ...)` factory. */
  writeFile: Mock<(path: string, data: string) => Promise<void>>;
  rename: Mock<(from: string, to: string) => Promise<void>>;
  unlink: Mock<(path: string) => Promise<void>>;
  /**
   * Temp files written but never renamed away or cleaned up. MUST be empty
   * after a successful save — a non-empty list is litter left on disk.
   */
  leftovers: () => string[];
  /** Every temp path used, in call order. Distinctness is the anti-collision proof. */
  tempPaths: () => string[];
}

/**
 * @param statePath the real target path; a rename onto it calls `onPublish`
 * @param onPublish receives the fully-written payload as it becomes visible
 */
export function atomicStateFsMock(
  statePath: string,
  onPublish: (data: string) => void,
): AtomicStateFsMock {
  /** Temp files that exist but have not been renamed into place yet. */
  const pending = new Map<string, string>();
  const seenTempPaths: string[] = [];

  return {
    writeFile: vi.fn(async (path: string, data: string) => {
      if (path === statePath) {
        // The whole point of the fix: the live target is never opened for
        // writing. Fail loudly rather than silently tolerating a regression.
        throw new Error(
          `non-atomic write straight to the state file: ${path}. ` +
            `saveState must write to a temp sibling and rename over the target.`,
        );
      }
      seenTempPaths.push(path);
      pending.set(path, data);
    }),

    rename: vi.fn(async (from: string, to: string) => {
      if (!pending.has(from)) {
        throw Object.assign(
          new Error(`ENOENT: rename of a temp file that was never written: ${from}`),
          { code: "ENOENT" },
        );
      }
      const data = pending.get(from)!;
      pending.delete(from);
      if (to === statePath) onPublish(data);
    }),

    unlink: vi.fn(async (path: string) => {
      pending.delete(path);
    }),

    leftovers: () => [...pending.keys()],
    tempPaths: () => [...seenTempPaths],
  };
}

/**
 * Just the three `fs/promises` functions an atomic save touches, for mock
 * factories that never inspect the persisted state and only need the write path
 * to work. Spread it into the factory:
 *
 *   vi.doMock("fs/promises", () => ({
 *     readFile: ...,
 *     mkdir: vi.fn().mockResolvedValue(undefined),
 *     ...atomicStateFsStub(PATH),
 *   }));
 *
 * Still enforces the contract — a direct write to `statePath` throws.
 */
export function atomicStateFsStub(
  statePath: string,
): Pick<AtomicStateFsMock, "writeFile" | "rename" | "unlink"> {
  const { writeFile, rename, unlink } = atomicStateFsMock(statePath, () => {});
  return { writeFile, rename, unlink };
}
