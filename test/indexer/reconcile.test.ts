import { describe, it, expect } from "vitest";
import { reconcileState } from "../../core/indexer/files.js";
import { reconcileMessageState } from "../../core/indexer/messages.js";
import { reconcileAssetState } from "../../core/indexer/assets.js";
import { config } from "../../core/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake Qdrant count function backed by a plain record.
 * Throws from .get on unknown collections so tests catch typos.
 */
function fakeCount(counts: Record<string, number>) {
  return async (collection: string): Promise<number> => {
    const n = counts[collection];
    if (n === undefined) {
      throw new Error(`unknown collection in test: ${collection}`);
    }
    return n;
  };
}

function capturingLog(): { log: (msg: string) => void; messages: string[] } {
  const messages: string[] = [];
  return {
    log: (msg: string) => messages.push(msg),
    messages,
  };
}

// Convenience: fill a brain-vault state with N files each with M chunks.
function brainState(fileCount: number, chunksEach = 1) {
  const files: Record<string, { hash: string; indexedAt: string; collection: string; chunks: number }> = {};
  for (let i = 0; i < fileCount; i++) {
    files[`brain/ideas/file-${i}.md`] = {
      hash: `hash-${i}`,
      indexedAt: "2026-04-04T10:00:00.000Z",
      collection: config.collections.brain,
      chunks: chunksEach,
    };
  }
  return { files, lastFullIndex: "2026-04-04T10:00:00.000Z" };
}

// ---------------------------------------------------------------------------
// indexer.reconcileState
// ---------------------------------------------------------------------------

describe("reconcileState (brain/obs/refl indexer)", () => {
  it("passes through empty state unchanged (nothing to verify)", async () => {
    const state = { files: {}, lastFullIndex: null };
    const result = await reconcileState(state, {
      getCount: fakeCount({ [config.collections.brain]: 0 }),
    });
    expect(result).toEqual(state);
  });

  it("passes through when actual count matches expected exactly", async () => {
    const state = brainState(100, 1); // expected 100 points
    const { log, messages } = capturingLog();
    const result = await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 100,
        [config.collections.observations]: 0,
        [config.collections.reflections]: 0,
      }),
      log,
    });
    expect(result.files).toEqual(state.files); // not wiped
    expect(messages).toHaveLength(0); // no drift warning
  });

  it("passes through when within tolerance (80% of expected)", async () => {
    const state = brainState(100, 1); // expected 100 points
    const { log } = capturingLog();
    const result = await reconcileState(state, {
      // 85 out of 100 = 85%, within 80% tolerance → no wipe
      getCount: fakeCount({
        [config.collections.brain]: 85,
        [config.collections.observations]: 0,
        [config.collections.reflections]: 0,
      }),
      log,
    });
    expect(Object.keys(result.files)).toHaveLength(100); // state preserved
  });

  it("wipes state when actual count is below 80% tolerance", async () => {
    const state = brainState(100, 1); // expected 100
    const { log, messages } = capturingLog();
    const result = await reconcileState(state, {
      // 10 out of 100 = 10%, below 80% → wipe
      getCount: fakeCount({
        [config.collections.brain]: 10,
        [config.collections.observations]: 0,
        [config.collections.reflections]: 0,
      }),
      log,
    });
    expect(result.files).toEqual({}); // wiped
    expect(result.lastFullIndex).toBeNull();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/DRIFT DETECTED/);
    expect(messages[0]).toMatch(/brain-vault/);
    expect(messages[0]).toMatch(/expects 100/);
    expect(messages[0]).toMatch(/Qdrant has 10/);
  });

  it("REGRESSION: the 2026-04-11 tmpfs scenario (225+ → 7) wipes state", async () => {
    // This mirrors the incident that motivated reconcile: state file says 225+ files
    // across brain-vault, Qdrant actually has 7 points.
    const state = brainState(225, 2); // 450 expected points
    const { log, messages } = capturingLog();
    const result = await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 7,
        [config.collections.observations]: 0,
        [config.collections.reflections]: 0,
      }),
      log,
    });
    expect(result.files).toEqual({}); // wiped → full reindex will follow
    expect(messages[0]).toMatch(/DRIFT DETECTED/);
    expect(messages[0]).toMatch(/450/);
    expect(messages[0]).toMatch(/7/);
  });

  it("wipes as soon as ANY owned collection drifts, even if others are healthy", async () => {
    // brain-vault healthy, but io-observations has drifted.
    const state = {
      files: {
        "brain/a.md": { hash: "h1", indexedAt: "t", collection: config.collections.brain, chunks: 1 },
        "memory/observations/obs-1.md": { hash: "h2", indexedAt: "t", collection: config.collections.observations, chunks: 50 },
      },
      lastFullIndex: null,
    };
    const { log } = capturingLog();
    const result = await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 1,             // healthy
        [config.collections.observations]: 5,      // 5/50 = 10%, below threshold
        [config.collections.reflections]: 0,
      }),
      log,
    });
    expect(result.files).toEqual({}); // wiped because observations drifted
  });

  it("silently skips collections with zero expected (nothing to verify)", async () => {
    // State only has brain-vault; observations and reflections aren't in state
    const state = brainState(50, 1);
    const { log, messages } = capturingLog();
    await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 50, // healthy
        // observations + reflections will throw if queried — if they do, test fails
      }),
      log,
    });
    expect(messages).toHaveLength(0);
  });

  it("treats getCount errors as 'assume trustworthy' and continues to next collection", async () => {
    const state = brainState(50, 1);
    const { log, messages } = capturingLog();
    const result = await reconcileState(state, {
      getCount: async (col: string) => {
        if (col === config.collections.brain) throw new Error("connection refused");
        return 0;
      },
      log,
    });
    expect(result.files).toEqual(state.files); // not wiped — passed through on error
    expect(messages.some((m) => m.includes("failed to query"))).toBe(true);
  });

  it("honors custom tolerance", async () => {
    const state = brainState(100, 1);
    const { log } = capturingLog();

    // With default 0.8 tolerance, 85 actual out of 100 → state preserved
    const strict = await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 85,
        [config.collections.observations]: 0,
        [config.collections.reflections]: 0,
      }),
      log,
      tolerance: 0.9, // stricter: 90% required
    });
    // 85 < 90 threshold → wipe
    expect(strict.files).toEqual({});

    // With loose tolerance 0.05 (5%), even 10/100 passes
    const loose = await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 10,
        [config.collections.observations]: 0,
        [config.collections.reflections]: 0,
      }),
      log,
      tolerance: 0.05,
    });
    expect(Object.keys(loose.files)).toHaveLength(100); // preserved
  });

  it("can scope to a subset of collections via ownedCollections", async () => {
    // Only check brain-vault, ignore observations drift
    const state = {
      files: {
        "brain/a.md": { hash: "h1", indexedAt: "t", collection: config.collections.brain, chunks: 1 },
        "memory/observations/obs-1.md": { hash: "h2", indexedAt: "t", collection: config.collections.observations, chunks: 100 },
      },
      lastFullIndex: null,
    };
    const { log } = capturingLog();
    const result = await reconcileState(state, {
      getCount: fakeCount({
        [config.collections.brain]: 1,
        // observations query would throw, but we don't check it
      }),
      log,
      ownedCollections: [config.collections.brain],
    });
    expect(result.files).toEqual(state.files); // preserved
  });
});

// ---------------------------------------------------------------------------
// message-indexer.reconcileMessageState
// ---------------------------------------------------------------------------

describe("reconcileMessageState", () => {
  function msgState(sessionCount: number, messagesPerSession: number) {
    const sessions: Record<string, { file: string; lastSize: number; lastModified: string; messagesIndexed: number; lastSeq: number }> = {};
    for (let i = 0; i < sessionCount; i++) {
      sessions[`session-${i}`] = {
        file: `session-${i}.jsonl`,
        lastSize: 1000,
        lastModified: "2026-04-04T10:00:00.000Z",
        messagesIndexed: messagesPerSession,
        lastSeq: messagesPerSession,
      };
    }
    return { sessions, ccSessions: {}, lastRun: "2026-04-04T10:00:00.000Z", totalMessagesIndexed: sessionCount * messagesPerSession };
  }

  it("passes through empty state", async () => {
    const state = { sessions: {}, ccSessions: {}, lastRun: "", totalMessagesIndexed: 0 };
    const result = await reconcileMessageState(state, {
      getCount: fakeCount({ [config.collections.messages]: 0 }),
    });
    expect(result).toEqual(state);
  });

  it("passes through when count matches", async () => {
    const state = msgState(10, 20); // 200 expected
    const result = await reconcileMessageState(state, {
      getCount: fakeCount({ [config.collections.messages]: 200 }),
    });
    expect(result.sessions).toEqual(state.sessions);
  });

  it("wipes state when Qdrant is empty (exact tmpfs scenario for messages)", async () => {
    const state = msgState(35, 5); // 175 expected
    const { log, messages } = capturingLog();
    const result = await reconcileMessageState(state, {
      getCount: fakeCount({ [config.collections.messages]: 0 }),
      log,
    });
    expect(result.sessions).toEqual({});
    expect(result.lastRun).toBe("");
    expect(result.totalMessagesIndexed).toBe(0);
    expect(messages[0]).toMatch(/DRIFT DETECTED/);
    expect(messages[0]).toMatch(/message-indexer/);
  });

  it("errors from getCount preserve state", async () => {
    const state = msgState(10, 10);
    const { log } = capturingLog();
    const result = await reconcileMessageState(state, {
      getCount: async () => { throw new Error("network down"); },
      log,
    });
    expect(result.sessions).toEqual(state.sessions);
  });
});

// ---------------------------------------------------------------------------
// asset-indexer.reconcileAssetState
// ---------------------------------------------------------------------------

describe("reconcileAssetState", () => {
  function assetState(assetCount: number, chunksEach = 1) {
    const assets: Record<string, { hash: string; indexedAt: string; assetType: "image" | "pdf" | "audio"; chunks: number }> = {};
    for (let i = 0; i < assetCount; i++) {
      assets[`brain/assets/img-${i}.png`] = {
        hash: `sha256:${i}`,
        indexedAt: "2026-04-04T10:00:00.000Z",
        assetType: "image",
        chunks: chunksEach,
      };
    }
    return { assets, lastRun: null, totalAssetsIndexed: assetCount };
  }

  it("passes through empty state", async () => {
    const state = { assets: {}, lastRun: null, totalAssetsIndexed: 0 };
    const result = await reconcileAssetState(state, {
      getCount: fakeCount({ [config.collections.assets]: 0 }),
    });
    expect(result).toEqual(state);
  });

  it("passes through when count matches", async () => {
    const state = assetState(174); // 174 expected
    const result = await reconcileAssetState(state, {
      getCount: fakeCount({ [config.collections.assets]: 174 }),
    });
    expect(result.assets).toEqual(state.assets);
  });

  it("wipes state when Qdrant has only 5 of 174 expected (exact tmpfs scenario for assets)", async () => {
    const state = assetState(174);
    const { log, messages } = capturingLog();
    const result = await reconcileAssetState(state, {
      getCount: fakeCount({ [config.collections.assets]: 5 }),
      log,
    });
    expect(result.assets).toEqual({});
    expect(result.lastRun).toBeNull();
    expect(result.totalAssetsIndexed).toBe(0);
    expect(messages[0]).toMatch(/DRIFT DETECTED/);
    expect(messages[0]).toMatch(/asset-indexer/);
    expect(messages[0]).toMatch(/174/);
    expect(messages[0]).toMatch(/Qdrant has 5/);
  });

  it("PDFs with multiple chunks contribute correctly to expected count", async () => {
    // 5 PDFs x 3 chunks each = 15 expected points
    const state = assetState(5, 3);
    const result = await reconcileAssetState(state, {
      getCount: fakeCount({ [config.collections.assets]: 14 }), // 14/15 = 93%, healthy
    });
    expect(Object.keys(result.assets)).toHaveLength(5);
  });
});
