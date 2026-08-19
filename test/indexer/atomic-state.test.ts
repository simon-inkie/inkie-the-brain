/**
 * Indexer state files must be written crash-safely.
 *
 * All three indexers persisted their resume checkpoint with a plain
 * `writeFile` overwrite, which truncates the live file and then streams the new
 * bytes in. Death between those two steps (crash, SIGKILL, OOM kill) leaves
 * truncated JSON, and because `loadState()` parses inside a
 * `try { } catch { return empty }` the corruption is SILENT — the indexer
 * reports no error and simply believes it has never indexed anything.
 *
 * WHAT THESE TESTS ARE FOR. Happy-path coverage is the least interesting part;
 * a plain overwrite passes a happy-path test too. The tests that carry the
 * crash-safety claim are the ones that fail against the OLD implementation:
 *
 *   - "never opens the target for writing" — the target is chmod 0444, so a
 *     plain `writeFile` overwrite gets EACCES while an atomic rename succeeds.
 *     The test asserts BOTH halves, so it is self-contained proof that the new
 *     path structurally cannot truncate the live file. This is the closest a
 *     test can get to the real property without killing a process mid-write:
 *     if the target is never opened for writing, no crash can ever catch it
 *     half-written.
 *   - "a failed write leaves the previous state intact" — the failure is
 *     injected at the exact points a crash would strike (during the temp write,
 *     and during the rename) and the ORIGINAL file is asserted byte-identical
 *     afterwards.
 *   - "concurrent writes never interleave" — the collision case that a
 *     pid-only temp name would reintroduce (see `tempPathFor`).
 *   - "creates the state directory" — the fresh-install case. The old
 *     `saveState` bodies each did their own recursive `mkdir` before writing;
 *     that responsibility moved into `writeFileAtomic`, and dropping it would
 *     break every install whose state directory does not exist yet.
 *   - the three "routes through the atomic write" cases — behaviour proven in
 *     isolation means nothing if a `saveState` does not actually call it, so
 *     each indexer is exercised through its real entry point.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  chmod,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { writeFileAtomic, tempPathFor } from "../../core/indexer/atomic-state.js";
import { atomicStateFsMock } from "./atomic-state-fs-mock.js";

// ---------------------------------------------------------------------------
// Real-filesystem suite. These exercise genuine POSIX rename semantics — the
// whole guarantee lives in the kernel, so mocking it here would assert nothing.
// ---------------------------------------------------------------------------

describe("writeFileAtomic — real filesystem", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "brain-atomic-state-"));
    target = join(dir, "index-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Temp files this module leaves behind are always siblings named `<target>.tmp-*`. */
  async function tempLitter(): Promise<string[]> {
    const entries = await readdir(dir);
    return entries.filter((e) => e.includes(".tmp-"));
  }

  it("writes the complete payload to the target", async () => {
    const state = { files: { "a.md": { hash: "abc", chunks: 3 } }, lastFullIndex: null };

    await writeFileAtomic(target, JSON.stringify(state, null, 2));

    expect(JSON.parse(await readFile(target, "utf-8"))).toEqual(state);
  });

  it("leaves no temp file behind after a successful write", async () => {
    await writeFileAtomic(target, JSON.stringify({ files: {}, lastFullIndex: null }));

    expect(
      await tempLitter(),
      "a successful save must not leave temp files in the state directory",
    ).toEqual([]);
    expect(await readdir(dir)).toEqual(["index-state.json"]);
  });

  it("creates the state directory when it does not exist yet (fresh install)", async () => {
    // On a fresh install nothing has ever written the state directory. Each
    // saveState used to mkdir it before writing; writeFileAtomic owns that now,
    // and it has to happen before the TEMP write, not just before the rename,
    // because the temp file is a sibling of the target.
    const freshTarget = join(dir, "state", "nested", "index-state.json");
    const payload = JSON.stringify({ files: {}, lastFullIndex: null });

    await writeFileAtomic(freshTarget, payload);

    expect(await readFile(freshTarget, "utf-8")).toBe(payload);
    expect(await readdir(dirname(freshTarget))).toEqual(["index-state.json"]);
  });

  it("replaces existing content wholesale, leaving no trailing bytes of the old file", async () => {
    // A longer old payload than the new one: a truncating-but-not-truncated
    // overwrite would leave the old tail dangling after the new content and
    // produce unparseable JSON. Rename cannot do that.
    const oldState = { files: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`old-${i}.md`, { hash: `h${i}`, chunks: i }]),
    ) };
    await writeFile(target, JSON.stringify(oldState, null, 2));

    const newState = { files: { "only.md": { hash: "new", chunks: 1 } } };
    await writeFileAtomic(target, JSON.stringify(newState, null, 2));

    const raw = await readFile(target, "utf-8");
    expect(JSON.parse(raw)).toEqual(newState);
    expect(raw).not.toContain("old-0.md");
  });

  it("never opens the target for writing (a read-only target is still replaced)", async () => {
    // THE crash-safety proof. Write permission on the FILE is what a plain
    // overwrite needs; write permission on the DIRECTORY is what a rename
    // needs. Stripping the former and keeping the latter separates the two
    // implementations cleanly: the old one fails here, the new one cannot
    // touch the live file even if it wanted to.
    if (process.getuid?.() === 0) {
      // root bypasses the permission bits and the discriminator vanishes.
      return;
    }

    const original = JSON.stringify({ files: { "keep.md": { hash: "orig" } } }, null, 2);
    await writeFile(target, original);
    await chmod(target, 0o444);

    // Control: the OLD implementation (plain overwrite) is refused outright.
    await expect(
      writeFile(target, "clobbered"),
      "control: a plain overwrite must be refused on a read-only target — " +
        "if this ever passes the test below proves nothing",
    ).rejects.toMatchObject({ code: "EACCES" });

    // The fix: replacing the directory entry needs no write access to the file.
    const updated = JSON.stringify({ files: { "keep.md": { hash: "updated" } } }, null, 2);
    await writeFileAtomic(target, updated);

    expect(JSON.parse(await readFile(target, "utf-8"))).toEqual(JSON.parse(updated));
    expect(await tempLitter()).toEqual([]);
  });

  it("concurrent writes to one target never interleave into a torn file", async () => {
    // The watcher runs a SEPARATE debounce timer per changed file, so several
    // saveState calls can genuinely be in flight at once in one process (see
    // tempPathFor's note). Payloads are large so an interleave would be
    // unmissable: a shared temp path would mix two writers' bytes and rename
    // the mixture into place.
    const payloads = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify(
        { writer: i, files: Object.fromEntries(
          Array.from({ length: 500 }, (_, j) => [`w${i}-file-${j}.md`, { hash: `w${i}-${j}` }]),
        ) },
        null,
        2,
      ),
    );

    await Promise.all(payloads.map((p) => writeFileAtomic(target, p)));

    const raw = await readFile(target, "utf-8");
    // Parses at all => not torn. Equals one payload exactly => no mixing.
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(
      payloads,
      "the surviving file must be exactly one writer's complete payload",
    ).toContain(raw);
    expect(
      await tempLitter(),
      "every concurrent writer must clean up after itself",
    ).toEqual([]);
  });

  it("a failed save leaves the previous state byte-identical and untouched", async () => {
    // The real function, failing for real at the temp-write step: a read-only
    // DIRECTORY refuses the new temp file. The target file itself stays
    // writable throughout, so nothing about this test protects the old
    // implementation — a plain overwrite would have gone straight through and
    // rewritten the live file. Here the live file is not even opened.
    if (process.getuid?.() === 0) return; // root ignores the permission bits

    const original = JSON.stringify({ files: { "survivor.md": { hash: "orig" } } }, null, 2);
    await writeFile(target, original);
    const before = await stat(target);

    await chmod(dir, 0o555);
    try {
      await expect(
        writeFileAtomic(target, JSON.stringify({ files: {} })),
        "a save that cannot be completed must fail loudly, not half-succeed",
      ).rejects.toMatchObject({ code: "EACCES" });

      const after = await stat(target);
      expect(await readFile(target, "utf-8"), "previous state must survive a failed save").toBe(
        original,
      );
      expect(after.mtimeMs, "the live state file must not be touched at all").toBe(before.mtimeMs);
    } finally {
      await chmod(dir, 0o755);
    }

    expect(await tempLitter(), "a failed save must not leave litter").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure handling that a real filesystem cannot be made to produce on demand.
// ---------------------------------------------------------------------------

describe("writeFileAtomic — failure handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("fs/promises");
  });

  it("creates the target's directory recursively before the temp write", async () => {
    // Order matters and cannot be asserted on a real filesystem without racing
    // it: the temp file is a SIBLING of the target, so the mkdir has to land
    // first or the temp write itself fails with ENOENT.
    const calls: string[] = [];
    const mkdirArgs: unknown[][] = [];
    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async (...args: unknown[]) => {
        mkdirArgs.push(args);
        calls.push("mkdir");
        return undefined;
      }),
      writeFile: vi.fn(async () => {
        calls.push("writeFile");
      }),
      rename: vi.fn(async () => {
        calls.push("rename");
      }),
      unlink: vi.fn(async () => undefined),
    }));

    const { writeFileAtomic: subject } = await import("../../core/indexer/atomic-state.js");
    await subject("/state/nested/index-state.json", "{}");

    expect(calls).toEqual(["mkdir", "writeFile", "rename"]);
    expect(mkdirArgs[0][0], "the state directory, not the state file").toBe("/state/nested");
    expect(mkdirArgs[0][1]).toEqual({ recursive: true });
  });

  it("propagates a write failure, never renames, and cleans up the temp file", async () => {
    const unlinked: string[] = [];
    const renameCalls: string[] = [];
    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      }),
      rename: vi.fn(async (from: string) => {
        renameCalls.push(from);
      }),
      unlink: vi.fn(async (p: string) => {
        unlinked.push(p);
      }),
    }));

    const { writeFileAtomic: subject } = await import("../../core/indexer/atomic-state.js");

    await expect(subject("/state/index-state.json", "{}")).rejects.toThrow("ENOSPC");

    expect(renameCalls, "a failed write must never be published to the target").toEqual([]);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toContain("/state/index-state.json.tmp-");
  });

  it("propagates a rename failure and cleans up the orphaned temp file", async () => {
    const written: string[] = [];
    const unlinked: string[] = [];
    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (p: string) => {
        written.push(p);
      }),
      rename: vi.fn(async () => {
        throw new Error("EXDEV: cross-device link not permitted");
      }),
      unlink: vi.fn(async (p: string) => {
        unlinked.push(p);
      }),
    }));

    const { writeFileAtomic: subject } = await import("../../core/indexer/atomic-state.js");

    await expect(subject("/state/index-state.json", "{}")).rejects.toThrow("EXDEV");

    expect(unlinked, "the orphaned temp file must be removed").toEqual(written);
  });

  it("does not mask the original error when cleanup also fails", async () => {
    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => {
        throw new Error("the real failure");
      }),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => {
        throw new Error("cleanup also failed");
      }),
    }));

    const { writeFileAtomic: subject } = await import("../../core/indexer/atomic-state.js");

    await expect(subject("/state/index-state.json", "{}")).rejects.toThrow("the real failure");
  });
});

// ---------------------------------------------------------------------------
// Temp-path scheme. Uniqueness is the property the concurrency safety rests on,
// and unlike the end-to-end race it can be asserted deterministically.
// ---------------------------------------------------------------------------

describe("tempPathFor — collision resistance", () => {
  it("returns a distinct path on every call for the same target", () => {
    const target = "/state/index-state.json";
    const paths = Array.from({ length: 1000 }, () => tempPathFor(target));

    expect(
      new Set(paths).size,
      "two concurrent saveState calls in one process must not share a temp file — " +
        "the watcher arms a separate debounce timer per changed file, so this happens",
    ).toBe(paths.length);
  });

  it("places the temp file in the target's own directory (same filesystem => atomic rename)", () => {
    const target = "/state/nested/asset-index-state.json";
    const temp = tempPathFor(target);

    expect(dirname(temp)).toBe(dirname(target));
    expect(temp.startsWith(`${target}.tmp-`)).toBe(true);
  });

  it("includes the pid so separate processes cannot collide either", () => {
    expect(tempPathFor("/state/s.json")).toContain(`.tmp-${process.pid}-`);
  });
});

// ---------------------------------------------------------------------------
// Registration: each indexer's saveState must actually route through the
// atomic write. The shared fs mock THROWS on a direct write to the state path,
// so any of these reverting to a plain overwrite goes red here.
// ---------------------------------------------------------------------------

const STATE_PATH = "/fake/state/index-state.json";
const ASSET_STATE_PATH = "/fake/state/asset-index-state.json";
const MESSAGE_STATE_PATH = "/fake/state/message-index-state.json";

const COLLECTIONS = {
  brain: "brain-vault",
  observations: "observations",
  reflections: "reflections",
  assets: "assets",
  messages: "messages",
};

describe("indexer saveState routes through the atomic write", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("fs/promises");
    vi.doUnmock("../../core/config.js");
  });

  it("files.ts indexAll publishes state by rename and leaves no temp file", async () => {
    let published: string | null = null;
    const fsMock = atomicStateFsMock(STATE_PATH, (data) => {
      published = data;
    });

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        collections: COLLECTIONS,
        chunkMaxTokens: 2000,
        sources: { brain: ["/fake/brain"], observations: [], reflections: [], references: [] },
        memoryMdPaths: [],
        memoryMdPath: "/fake/MEMORY.md",
        indexStatePath: STATE_PATH,
        workspaceRoot: "/fake/workspace",
      },
    }));
    vi.doMock("glob", () => ({
      glob: vi.fn(async (pattern: string) =>
        pattern.startsWith("/fake/brain") ? ["/fake/brain/note.md"] : [],
      ),
    }));
    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
      getCollectionPointCount: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0.1))),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("fs/promises", () => ({
      readFile: vi.fn(async (path: string) =>
        path === STATE_PATH
          ? JSON.stringify({ files: {}, lastFullIndex: null })
          : "# Note\n\nbody text.",
      ),
      access: vi.fn(async (path: string) => {
        if (path === "/fake/MEMORY.md") throw new Error("ENOENT");
        return undefined;
      }),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: fsMock.writeFile,
      rename: fsMock.rename,
      unlink: fsMock.unlink,
    }));

    const { indexAll } = await import("../../core/indexer/files.js");
    await indexAll();

    expect(published, "state must reach the target via rename, not a direct write").not.toBeNull();
    expect(Object.keys(JSON.parse(published!).files)).toContain("../brain/note.md");
    expect(fsMock.leftovers()).toEqual([]);
  });

  it("assets.ts deleteAsset publishes state by rename and leaves no temp file", async () => {
    let published: string | null = null;
    const fsMock = atomicStateFsMock(ASSET_STATE_PATH, (data) => {
      published = data;
    });

    vi.doMock("../../core/config.js", () => ({
      config: {
        collections: COLLECTIONS,
        workspaceRoot: "/fake/workspace",
        assetIndexing: {
          stateFile: ASSET_STATE_PATH,
          imageExtensions: [".png"],
          pdfExtensions: [".pdf"],
          audioExtensions: [".mp3"],
          maxFileSizeMb: 50,
          maxPdfPages: 50,
          descriptionModel: "gemini-2.5-flash",
        },
      },
    }));
    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
      client: {},
      getCollectionPointCount: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock("fs/promises", () => ({
      readFile: vi.fn(async () =>
        JSON.stringify({
          assets: {
            "../brain/assets/gone.png": { hash: "h", indexedAt: "x", assetType: "image", chunks: 1 },
            "../brain/assets/kept.png": { hash: "k", indexedAt: "x", assetType: "image", chunks: 1 },
          },
          lastRun: null,
          totalAssetsIndexed: 2,
        }),
      ),
      stat: vi.fn().mockResolvedValue({ size: 1 }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: fsMock.writeFile,
      rename: fsMock.rename,
      unlink: fsMock.unlink,
    }));

    const { deleteAsset } = await import("../../core/indexer/assets.js");
    await deleteAsset("/fake/brain/assets/gone.png");

    expect(published).not.toBeNull();
    const state = JSON.parse(published!);
    expect(state.assets["../brain/assets/gone.png"]).toBeUndefined();
    expect(state.assets["../brain/assets/kept.png"]).toBeDefined();
    expect(fsMock.leftovers()).toEqual([]);
  });

  it("messages.ts indexAllMessages publishes state by rename and leaves no temp file", async () => {
    let published: string | null = null;
    const fsMock = atomicStateFsMock(MESSAGE_STATE_PATH, (data) => {
      published = data;
    });

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        collections: COLLECTIONS,
        chunkMaxTokens: 2000,
        messageIndexing: {
          stateFile: MESSAGE_STATE_PATH,
          minContentLength: 5,
          roles: ["user", "assistant"],
          skipPatterns: [] as RegExp[],
          skipToolOnlyMessages: false,
        },
        sources: { messages: "/fake/messages" },
        agents: [],
      },
    }));
    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: {},
      getCollectionPointCount: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Array(768).fill(0.1))),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));
    // No sessions to index: this test is about HOW state is persisted, not what
    // ends up in it.
    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({ sessions: [], unmappedDirs: [] }),
    }));
    vi.doMock("fs/promises", () => ({
      readFile: vi.fn(async () =>
        JSON.stringify({ sessions: {}, ccSessions: {}, lastRun: "", totalMessagesIndexed: 0 }),
      ),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ size: 1 }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: fsMock.writeFile,
      rename: fsMock.rename,
      unlink: fsMock.unlink,
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    await indexAllMessages(undefined, "alpha");

    expect(published).not.toBeNull();
    expect(typeof JSON.parse(published!).lastRun).toBe("string");
    expect(fsMock.leftovers()).toEqual([]);
  });
});
