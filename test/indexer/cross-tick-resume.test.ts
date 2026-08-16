/**
 * Regression test: indexer cross-tick resume.
 *
 * Root cause: indexAll() only called saveState() at the END of a clean pass.
 * A cap-halt throw (EmbedQuotaExceededError from gate.ts) unwound the stack
 * before that single saveState(), discarding all per-file progress for the
 * tick. The next daemon tick re-walked from scratch, starving directories
 * processed last (references, MEMORY.md) whenever there was a backlog larger
 * than one tick's cap - the root cause of the references-starvation symptom.
 *
 * Fix: wrap the indexing body in try { ... } finally { await saveState(state); }
 * so partial progress is always persisted. The cap-halt throw still propagates
 * (bare try/finally, no catch). state.lastFullIndex stays inside the try so it
 * is only stamped on a genuinely clean completion - a halted pass leaves the
 * prior lastFullIndex value untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared config stub - mirrors the real config shape for the fields indexAll uses
// ---------------------------------------------------------------------------

const FAKE_STATE_PATH = "/fake/state/index-state.json";
const FAKE_WORKSPACE = "/fake/workspace";
const FAKE_BRAIN_DIR = "/fake/brain/ideas";
const FAKE_FILE_1 = "/fake/brain/ideas/file1.md";
const FAKE_FILE_2 = "/fake/brain/ideas/file2.md";
const FAKE_MEMORY_MD = "/fake/MEMORY.md";

// Workspace-relative keys as indexAll/relativePath compute them - used to assert
// which file is already in state (skipped) vs newly indexed across the two ticks.
const FILE_1_KEY = "../brain/ideas/file1.md";
const FILE_2_KEY = "../brain/ideas/file2.md";

const CONFIG_STUB = {
  embeddingModel: "gemini-embedding-2-preview",
  embeddingDimensions: 768,
  collections: {
    brain: "brain-vault",
    observations: "io-observations",
    reflections: "io-reflections",
    assets: "io-assets",
    messages: "io-messages",
  },
  chunkMaxTokens: 2000,
  sources: {
    // One brain directory with two files - the embed throws on the second
    brain: [FAKE_BRAIN_DIR],
    observations: [],
    reflections: [],
    references: [],
  },
  memoryMdPaths: [],
  memoryMdPath: FAKE_MEMORY_MD,
  indexStatePath: FAKE_STATE_PATH,
  workspaceRoot: FAKE_WORKSPACE,
};

// Each file has DISTINCT content so its content-hash differs - the unchanged
// guard in indexFileInternal is keyed on relPath AND hash, so distinct content
// makes the "already-indexed file1 is skipped on tick 2" assertion unambiguous.
const FILE_CONTENT: Record<string, string> = {
  [FAKE_FILE_1]: "# File One\n\nContent for file one.",
  [FAKE_FILE_2]: "# File Two\n\nContent for file two.",
};

// Prior clean-pass timestamp - seeded into the INITIAL state so we can prove the
// cap-halt run PRESERVES it (does not reset to null, does not re-stamp).
const PRIOR_LAST_FULL_INDEX = "2026-06-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Suite: indexAll - cross-tick resume
// ---------------------------------------------------------------------------

describe("indexAll - cross-tick resume", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: cap-halt persists partial state + preserves lastFullIndex, THEN
  //         a second tick resumes delta-only (re-embeds ONLY the unindexed file).
  // -------------------------------------------------------------------------

  it("cap-halt persists partial state (lastFullIndex preserved), then next tick resumes delta-only", async () => {
    vi.doMock("../../core/config.js", () => ({ config: CONFIG_STUB }));

    // glob: brain dir returns 2 files, all other dirs return []
    vi.doMock("glob", () => ({
      glob: vi.fn().mockImplementation(async (pattern: string) => {
        if (pattern.startsWith(FAKE_BRAIN_DIR)) {
          return [FAKE_FILE_1, FAKE_FILE_2];
        }
        return [];
      }),
    }));

    // Qdrant client: all ops succeed
    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
      getCollectionPointCount: vi.fn().mockResolvedValue(0),
    }));

    // embedTexts behaviour is phase-controlled:
    //   phase 1 (tick 1, cap-halt): call 1 succeeds (file1 indexed + state
    //     mutated), call 2 throws EmbedQuotaExceededError (file2 → cap-halt).
    //   phase 2 (tick 2, resume): all calls succeed; we record which file's
    //     content was embedded to prove only file2 (the unindexed one) embeds.
    let phase = 1;
    let phase1EmbedCount = 0;
    const phase2EmbeddedContents: string[] = [];
    vi.doMock("../../core/embedder/text.js", () => {
      class EmbedQuotaExceededError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "EmbedQuotaExceededError";
        }
      }
      return {
        embedTexts: vi.fn().mockImplementation(async (texts: string[]) => {
          if (phase === 1) {
            phase1EmbedCount++;
            if (phase1EmbedCount === 1) {
              return texts.map(() => new Array(768).fill(0.1));
            }
            throw new EmbedQuotaExceededError(
              "Embed quota exceeded: 5001 > 5000 per tick"
            );
          }
          // phase 2 - resume tick: record + succeed
          phase2EmbeddedContents.push(...texts);
          return texts.map(() => new Array(768).fill(0.1));
        }),
        resetTickCounter: vi.fn(),
        flushTelemetry: vi.fn().mockResolvedValue(undefined),
        EmbedQuotaExceededError,
      };
    });

    // fs/promises: the state file content is MUTABLE - saveState's writeFile
    // updates it so the SECOND indexAll()'s loadState() reads back the partial
    // state persisted by the first (cap-halted) run. This is the cross-tick seam.
    let stateFileContent = JSON.stringify({
      files: {},
      lastFullIndex: PRIOR_LAST_FULL_INDEX,
    });
    const stateWrites: string[] = [];
    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path === FAKE_STATE_PATH) return stateFileContent;
        return FILE_CONTENT[path] ?? "# Unknown\n\nfallback content.";
      }),
      writeFile: vi.fn().mockImplementation(
        async (path: string, data: string) => {
          if (path === FAKE_STATE_PATH) {
            stateFileContent = data; // persist for the next tick's loadState
            stateWrites.push(data);
          }
        }
      ),
      // MEMORY.md does not exist → indexMemoryMd skips it. This isolates the
      // resume-tick embed assertion to the two brain files (otherwise MEMORY.md,
      // never reached on tick 1's cap-halt, would also embed fresh on tick 2 and
      // muddy the delta-only count). All other paths exist (so cleanRemovedFiles
      // does not prune the persisted file1).
      access: vi.fn().mockImplementation(async (path: string) => {
        if (path === FAKE_MEMORY_MD) throw new Error("ENOENT");
        return undefined;
      }),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    }));

    const { indexAll } = await import("../../core/indexer/files.js");

    // === TICK 1 - cap-halt =================================================
    await expect(indexAll()).rejects.toThrow();

    // saveState (writeFile to state path) ran despite the throw → finally fired.
    expect(
      stateWrites.length,
      "saveState must be called even when indexAll throws (finally block)"
    ).toBeGreaterThan(0);

    const tick1State = JSON.parse(stateWrites[stateWrites.length - 1]);

    // Partial progress persisted: file1 was indexed before the throw; file2 was not.
    expect(
      tick1State.files[FILE_1_KEY],
      "file1 (indexed before the cap-halt) must be persisted in state"
    ).toBeDefined();
    expect(
      tick1State.files[FILE_2_KEY],
      "file2 (cap-halted before indexing) must NOT be in state"
    ).toBeUndefined();

    // lastFullIndex PRESERVED - the cap-halt happened before the in-try stamp,
    // so the prior value is untouched (NOT reset to null, NOT re-stamped).
    expect(
      tick1State.lastFullIndex,
      "lastFullIndex must be preserved unchanged on a cap-halt pass"
    ).toBe(PRIOR_LAST_FULL_INDEX);

    // === TICK 2 - resume, delta-only =======================================
    // loadState() now returns the partial state persisted above (file1 present).
    phase = 2;
    await indexAll(); // must not throw

    // THE cross-tick resume proof: only the not-yet-indexed file (file2) is
    // re-embedded. file1 is skipped via the unchanged-hash guard - NOT re-embedded.
    expect(
      phase2EmbeddedContents.length,
      "exactly one file should be embedded on the resume tick (only the unindexed file2)"
    ).toBe(1);
    expect(
      phase2EmbeddedContents[0],
      "the resume tick must embed file2's content (the unindexed file), not file1's"
    ).toContain("File Two");
    expect(
      phase2EmbeddedContents.some((c) => c.includes("File One")),
      "file1 (already indexed on tick 1) must NOT be re-embedded on the resume tick"
    ).toBe(false);

    // After the clean resume tick, both files are now in state and lastFullIndex
    // is freshly stamped (a clean pass DOES advance it).
    const tick2State = JSON.parse(stateWrites[stateWrites.length - 1]);
    expect(tick2State.files[FILE_1_KEY]).toBeDefined();
    expect(tick2State.files[FILE_2_KEY]).toBeDefined();
    expect(typeof tick2State.lastFullIndex).toBe("string");
    expect(tick2State.lastFullIndex).not.toBe(PRIOR_LAST_FULL_INDEX);
  });

  // -------------------------------------------------------------------------
  // Test 2: clean-pass path (no regression on the normal case)
  // -------------------------------------------------------------------------

  it("clean pass: lastFullIndex stamped and saveState called", async () => {
    vi.doMock("../../core/config.js", () => ({ config: CONFIG_STUB }));

    // glob: one brain file only (clean, no throw)
    vi.doMock("glob", () => ({
      glob: vi.fn().mockImplementation(async (pattern: string) => {
        if (pattern.startsWith(FAKE_BRAIN_DIR)) {
          return [FAKE_FILE_1];
        }
        return [];
      }),
    }));

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
      deleteBySource: vi.fn().mockResolvedValue(undefined),
      getCollectionPointCount: vi.fn().mockResolvedValue(0),
    }));

    // embedTexts always succeeds
    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => new Array(768).fill(0.1))
      ),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    const writeFileCalls: Array<{ path: string; data: string }> = [];
    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path === FAKE_STATE_PATH) {
          return JSON.stringify({ files: {}, lastFullIndex: null });
        }
        return FILE_CONTENT[path] ?? "# Unknown\n\nfallback content.";
      }),
      writeFile: vi.fn().mockImplementation(
        async (path: string, data: string) => {
          writeFileCalls.push({ path, data });
        }
      ),
      access: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    }));

    const { indexAll } = await import("../../core/indexer/files.js");

    // --- Act ---
    await indexAll(); // must not throw

    // --- Assert ---

    const stateSave = writeFileCalls.find((c) => c.path === FAKE_STATE_PATH);
    expect(
      stateSave,
      "saveState must be called on a clean pass"
    ).toBeDefined();

    const savedState = JSON.parse(stateSave!.data);

    // lastFullIndex must be an ISO timestamp on a clean pass
    expect(
      typeof savedState.lastFullIndex,
      "lastFullIndex must be set on a clean pass"
    ).toBe("string");
    expect(savedState.lastFullIndex).not.toBeNull();

    // Quick sanity: the indexed file is in state
    expect(Object.keys(savedState.files).length).toBeGreaterThan(0);
  });
});
