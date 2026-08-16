/**
 * Regression tests: a message-indexer tick that runs out of embed budget must
 * leave DURABLE progress behind, and a session left partially indexed must
 * still finish on a later tick.
 *
 * The bug these pin (2026-07-28): indexCCSession embedded every outstanding
 * pair of a session in one go, then upserted + saved state ONCE at the end.
 * When the backlog was bigger than MAX_EMBEDS_PER_TICK the kill-switch threw
 * partway through, the stack unwound past both the upsert and the state save,
 * and the tick's entire work for that session was discarded. Every retry
 * failed identically, so a session with a >5000-chunk backlog made ZERO
 * progress forever (one live agent's session, ~340k pairs, had zero indexed
 * messages for over a month).
 *
 * The fix sizes the work to the budget instead of discovering the ceiling by
 * being thrown out of it: take the longest PREFIX OF COMPLETE PAIRS that fits
 * remainingTickBudget(), commit it (upsert then state), and mark the
 * checkpoint `partial: true` so the next tick resumes rather than early-skips.
 *
 * The subtle failure mode a naive fix introduces is test 2: a checkpoint
 * records the file's current size+mtime, so the unchanged-file early-skip
 * would then freeze a half-indexed COLD session forever — silently, where
 * today's bug at least fails loudly every tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE_FILE = "/fake/state/message-index-state.json";
// Deliberately nonexistent: the real gate reads this ledger with readFileSync
// (fs, not fs/promises, so no mock covers it). A missing file loads an empty
// ledger, which keeps the daily-spend circuit breaker out of these tests.
const LEDGER_PATH = "/fake/state/no-such-embed-spend-ledger.json";

const PROJECT_DIR = "-home-test-user-agents-alpha";
const AGENT = "alpha";

// chunkMaxTokens 25 → CHUNK_MAX_CHARS 100, so chunk counts are small and exact.
const CONFIG_STUB = {
  embeddingModel: "gemini-embedding-2-preview",
  embeddingDimensions: 768,
  collections: {
    messages: "io-messages",
    brain: "brain-vault",
    observations: "io-observations",
    reflections: "io-reflections",
    assets: "io-assets",
  },
  chunkMaxTokens: 25,
  messageIndexing: {
    stateFile: STATE_FILE,
    minContentLength: 5,
    roles: ["user", "assistant"],
    skipPatterns: [] as RegExp[],
    skipToolOnlyMessages: false,
  },
  sources: { messages: "/fake/messages" },
  agents: [],
};

// With userContent "user message N": prefix "[User] user message N\n\n" = 23 chars.
// SHORT → 23 + "[Assistant] " (12) + 21 = 56 ≤ 100 → exactly 1 chunk.
// LONG  → 235 chars > 100 → available 77 → ceil(200 / 77) = exactly 3 chunks.
const SHORT_ASSISTANT = "short assistant reply";
const LONG_ASSISTANT = "x".repeat(200);
const CHUNKS_PER_LONG_PAIR = 3;

const EMPTY_STATE = {
  sessions: {},
  ccSessions: {} as Record<string, unknown>,
  lastRun: "",
  totalMessagesIndexed: 0,
};

interface PairSpec {
  uuid: string;
  user: string;
  assistant: string;
}

/** N single-chunk pairs, uuids uuid-0..uuid-(n-1). */
function shortPairs(n: number, uuidPrefix = "uuid"): PairSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    uuid: `${uuidPrefix}-${i}`,
    user: `user message ${i}`,
    assistant: SHORT_ASSISTANT,
  }));
}

function buildJsonl(pairs: PairSpec[]): string {
  const lines: string[] = [];
  for (const p of pairs) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: p.uuid,
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "user", content: p.user },
      })
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: `asst-${p.uuid}`,
        timestamp: "2026-07-01T10:00:01.000Z",
        message: { role: "assistant", content: p.assistant },
      })
    );
  }
  return lines.join("\n") + "\n";
}

interface FakeSession {
  sessionId: string;
  jsonl: string;
}

// Session transcripts are REAL files on disk, not strings handed back by a
// readFile stub. The indexer reads them with createReadStream at a byte offset,
// so a stub that ignored `start` would let a broken offset pass every test.
const fixtureDirs: string[] = [];

function writeFixtures(sessions: FakeSession[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "brain-cc-budget-"));
  fixtureDirs.push(dir);
  const byId = new Map<string, string>();
  for (const s of sessions) {
    const p = join(dir, `${s.sessionId}.jsonl`);
    writeFileSync(p, s.jsonl);
    byId.set(s.sessionId, p);
  }
  return byId;
}

function cleanupFixtures(): void {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function stateKeyOf(sessionId: string): string {
  return `${PROJECT_DIR}/${sessionId}`;
}

// ---------------------------------------------------------------------------
// Harness — real gate (real budget arithmetic), stubbed Gemini/Qdrant/fs.
// ---------------------------------------------------------------------------

interface UpsertedPoint {
  id: string;
  payload: { pairIndex: number; chunk: number; sessionId: string };
}

async function makeHarness(opts: {
  maxEmbedsPerTick: number;
  sessions: FakeSession[];
  initialState?: unknown;
}) {
  // Read at gate import time — must be set before the dynamic import below.
  process.env.MAX_EMBEDS_PER_TICK = String(opts.maxEmbedsPerTick);

  let gate: typeof import("../../core/embedder/gate.js") | undefined;

  const embedded: string[] = [];
  const upsertedPoints: UpsertedPoint[] = [];
  const mockDelete = vi.fn().mockResolvedValue(undefined);
  const mockUpsert = vi.fn(
    async (_collection: string, arg: { points: UpsertedPoint[] }) => {
      upsertedPoints.push(...arg.points);
    }
  );

  vi.doMock("../../core/config.js", () => ({ config: CONFIG_STUB }));

  // embedTexts charges the REAL gate, so remainingTickBudget() moves exactly as
  // it does in production. The budget under test is the real one, not a stub.
  vi.doMock("../../core/embedder/text.js", () => ({
    embedTexts: vi.fn(async (texts: string[]) => {
      gate!.chargeTick(
        texts.length,
        texts.reduce((sum, t) => sum + t.length, 0),
        0
      );
      embedded.push(...texts);
      return texts.map(() => new Array(768).fill(0.1));
    }),
    resetTickCounter: () => gate!.resetTickCounter(),
    flushTelemetry: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("../../core/qdrant/client.js", () => ({
    ensureCollections: vi.fn().mockResolvedValue(undefined),
    client: { delete: mockDelete, upsert: mockUpsert, scroll: vi.fn() },
    getCollectionPointCount: vi.fn().mockResolvedValue(999),
  }));

  const pathById = writeFixtures(opts.sessions);

  vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
    discoverCCSessions: vi.fn().mockResolvedValue({
      sessions: opts.sessions.map((s) => ({
        projectDir: PROJECT_DIR,
        agentName: AGENT,
        filePath: pathById.get(s.sessionId)!,
        sessionId: s.sessionId,
      })),
      skippedDirs: [],
      unmappedDirs: [],
    }),
  }));

  // The state file is MUTABLE across ticks — saveState's writeFile feeds the
  // next tick's loadState. That is the cross-tick seam these tests exercise.
  let stateJson = JSON.stringify(opts.initialState ?? EMPTY_STATE);

  vi.doMock("fs/promises", () => ({
    readFile: vi.fn(async (path: string) => {
      if (path === STATE_FILE) return stateJson;
      throw new Error(`unexpected readFile: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      if (path === STATE_FILE) stateJson = data;
    }),
    // Real stat of the real fixture. Size + mtime stay CONSTANT for a given
    // session across ticks because nothing rewrites the file: these are cold
    // sessions, exactly the case an unchanged-file early-skip would freeze
    // half-indexed.
    stat: vi.fn(async (path: string) => statSync(path)),
    readdir: vi.fn(async () => []),
    appendFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  }));

  gate = await import("../../core/embedder/gate.js");
  const { indexAllMessages } = await import("../../core/indexer/messages.js");

  return {
    tick: () => indexAllMessages(undefined, AGENT),
    /** Texts embedded since the last call — per-tick assertions read this. */
    takeEmbedded: () => embedded.splice(0, embedded.length),
    upsertedPoints,
    mockDelete,
    sessionState: (sessionId: string) =>
      JSON.parse(stateJson).ccSessions[stateKeyOf(sessionId)] as
        | {
            pairsIndexed: number;
            lastPairIndex?: number;
            firstPairUuid?: string;
            partial?: true;
          }
        | undefined,
  };
}

/** Which pair a chunk belongs to — every chunk carries its user prefix. */
function pairsIn(texts: string[]): number[] {
  const found = new Set<number>();
  for (const t of texts) {
    const m = t.match(/\[User\] user message (\d+)/);
    if (m) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------

describe("cc-session indexing under a bounded tick budget", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.EMBED_SPEND_LEDGER_PATH = LEDGER_PATH;
    delete process.env.EMBED_DRY_RUN;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupFixtures();
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.EMBED_SPEND_LEDGER_PATH;
    delete process.env.EMBED_DRY_RUN;
  });

  // 1 -------------------------------------------------------------------
  it("a backlog bigger than the tick budget still makes durable progress instead of losing the tick", async () => {
    const h = await makeHarness({
      maxEmbedsPerTick: 3,
      sessions: [{ sessionId: "big", jsonl: buildJsonl(shortPairs(5)) }],
    });

    const result = await h.tick(); // must NOT throw — the old code did

    expect(result.indexed).toBe(3);
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2]);

    // Durable: the work is upserted AND recorded, not discarded on the way out.
    expect(h.upsertedPoints.map((p) => p.payload.pairIndex)).toEqual([0, 1, 2]);
    const state = h.sessionState("big");
    expect(state).toBeDefined();
    expect(state!.lastPairIndex).toBe(2);
    expect(state!.pairsIndexed).toBe(3);
    expect(state!.partial).toBe(true);
    expect(state!.firstPairUuid).toBe("uuid-0");
  });

  // 2 -------------------------------------------------------------------
  // THE regression pin. A checkpoint stamps the file's size+mtime, so without
  // the `!existing.partial` clause the unchanged-file early-skip freezes this
  // session at 3 of 5 pairs forever — silently, and forever.
  it("a partially indexed session whose file never changes again still completes on later ticks", async () => {
    const h = await makeHarness({
      maxEmbedsPerTick: 3,
      sessions: [{ sessionId: "cold", jsonl: buildJsonl(shortPairs(5)) }],
    });

    // Tick 1 — budget-bound prefix.
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2]);
    expect(h.sessionState("cold")!.partial).toBe(true);

    // Tick 2 — file byte-identical and mtime-identical to tick 1. The session
    // must re-enter and finish.
    const tick2 = await h.tick();
    expect(
      pairsIn(h.takeEmbedded()),
      "the remaining pairs must be picked up even though the file never changed again"
    ).toEqual([3, 4]);
    expect(tick2.indexed).toBe(2);

    const done = h.sessionState("cold")!;
    expect(done.lastPairIndex).toBe(4);
    expect(done.pairsIndexed).toBe(5);
    expect(done.partial, "completion must CLEAR the partial flag").toBeUndefined();

    // Tick 3 — now complete and unchanged, so the early-skip applies again and
    // the session costs nothing. (Without this, `partial` would just be a
    // permanent re-read of every finished session.)
    const tick3 = await h.tick();
    expect(h.takeEmbedded()).toEqual([]);
    expect(tick3.indexed).toBe(0);
    expect(tick3.skipped).toBe(5);
  });

  // 3 -------------------------------------------------------------------
  it("a pair is never split across ticks", async () => {
    // pair 0 = 1 chunk, pair 1 = 3 chunks, budget 3. Splitting pair 1 would fill
    // the budget exactly (1 + 2) — the prefix rule must refuse that trade.
    const jsonl = buildJsonl([
      { uuid: "uuid-0", user: "user message 0", assistant: SHORT_ASSISTANT },
      { uuid: "uuid-1", user: "user message 1", assistant: LONG_ASSISTANT },
    ]);
    const h = await makeHarness({
      maxEmbedsPerTick: 3,
      sessions: [{ sessionId: "split", jsonl }],
    });

    await h.tick();
    const tick1 = h.takeEmbedded();
    expect(
      pairsIn(tick1),
      "the oversized pair must be deferred whole, not partly embedded to fill the budget"
    ).toEqual([0]);
    expect(tick1).toHaveLength(1);
    expect(h.sessionState("split")!.lastPairIndex).toBe(0);
    expect(h.sessionState("split")!.partial).toBe(true);
    // No half-pair reached Qdrant either.
    expect(h.upsertedPoints.every((p) => p.payload.pairIndex === 0)).toBe(true);

    await h.tick();
    const tick2 = h.takeEmbedded();
    expect(pairsIn(tick2)).toEqual([1]);
    expect(
      tick2,
      "the deferred pair arrives whole on the next tick"
    ).toHaveLength(CHUNKS_PER_LONG_PAIR);
    expect(
      h.upsertedPoints.filter((p) => p.payload.pairIndex === 1).map((p) => p.payload.chunk)
    ).toEqual([0, 1, 2]);
    expect(h.sessionState("split")!.partial).toBeUndefined();
  });

  // 4 -------------------------------------------------------------------
  it("resuming does not re-embed pairs an earlier tick already persisted", async () => {
    const jsonl = buildJsonl(shortPairs(5));
    const h = await makeHarness({
      maxEmbedsPerTick: 100, // plenty — the only limit is what state says is done
      sessions: [{ sessionId: "resume", jsonl }],
      initialState: {
        ...EMPTY_STATE,
        ccSessions: {
          [stateKeyOf("resume")]: {
            file: "resume.jsonl",
            projectDir: PROJECT_DIR,
            agentName: AGENT,
            lastSize: jsonl.length,
            lastModified: "2026-07-01T10:00:02.000Z",
            pairsIndexed: 3,
            lastPairIndex: 2,
            firstPairUuid: "uuid-0",
            partial: true,
          },
        },
      },
    });

    const result = await h.tick();

    expect(pairsIn(h.takeEmbedded())).toEqual([3, 4]);
    expect(result.indexed).toBe(2);
    expect(h.upsertedPoints.map((p) => p.payload.pairIndex)).toEqual([3, 4]);
    // A resume is a delta, never a rebuild.
    expect(h.mockDelete).not.toHaveBeenCalled();
    expect(h.sessionState("resume")!.partial).toBeUndefined();
  });

  // 5 -------------------------------------------------------------------
  it("an interrupted full re-embed resumes without a second delete or re-embedding recovered pairs", async () => {
    // State points at a first-pair uuid the file no longer has → rewrite guard
    // fires → delete-by-source + embed from scratch. The budget cuts it short.
    const jsonl = buildJsonl(shortPairs(5));
    const h = await makeHarness({
      maxEmbedsPerTick: 3,
      sessions: [{ sessionId: "rewritten", jsonl }],
      initialState: {
        ...EMPTY_STATE,
        ccSessions: {
          [stateKeyOf("rewritten")]: {
            file: "rewritten.jsonl",
            projectDir: PROJECT_DIR,
            agentName: AGENT,
            lastSize: 10, // stale — forces a re-read
            lastModified: "2020-01-01T00:00:00.000Z",
            pairsIndexed: 5,
            lastPairIndex: 4,
            firstPairUuid: "uuid-STALE",
          },
        },
      },
    });

    await h.tick();
    expect(h.mockDelete).toHaveBeenCalledTimes(1);
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2]);
    const mid = h.sessionState("rewritten")!;
    expect(mid.partial).toBe(true);
    expect(
      mid.firstPairUuid,
      "a full re-embed must adopt the CURRENT pair[0] uuid, or the next tick deletes and restarts forever"
    ).toBe("uuid-0");

    await h.tick();
    expect(
      h.mockDelete,
      "the recovered pairs must not be wiped by a second delete-by-source"
    ).toHaveBeenCalledTimes(1);
    expect(
      pairsIn(h.takeEmbedded()),
      "only the pairs the first tick could not reach"
    ).toEqual([3, 4]);
    const done = h.sessionState("rewritten")!;
    expect(done.lastPairIndex).toBe(4);
    expect(done.partial).toBeUndefined();
  });

  // 6 -------------------------------------------------------------------
  it("budget exhaustion stops the tick without touching later sessions' state", async () => {
    const h = await makeHarness({
      maxEmbedsPerTick: 3,
      sessions: [
        { sessionId: "first", jsonl: buildJsonl(shortPairs(5)) },
        { sessionId: "second", jsonl: buildJsonl(shortPairs(2, "other")) },
      ],
    });

    await h.tick(); // must not throw, and must not spam a quota error per session

    expect(h.sessionState("first")!.partial).toBe(true);
    expect(h.sessionState("first")!.lastPairIndex).toBe(2);
    expect(
      h.sessionState("second"),
      "a session the tick never reached must have NO state entry invented for it"
    ).toBeUndefined();
    // Only the first session's pairs were embedded.
    expect(h.upsertedPoints.every((p) => p.payload.sessionId === "first")).toBe(true);
  });

  // extra ----------------------------------------------------------------
  // Not in the plan's list of 7, but it guards the degenerate branch the plan
  // specifies: a pair too big for a whole tick must be LOUD, never silently
  // skipped and never falsely checkpointed as done.
  it("a pair too large for an entire tick leaves the session visibly stuck, not silently skipped", async () => {
    const jsonl = buildJsonl([
      { uuid: "uuid-0", user: "user message 0", assistant: LONG_ASSISTANT }, // 3 chunks
    ]);
    const h = await makeHarness({
      maxEmbedsPerTick: 2, // smaller than the single pair needs
      sessions: [{ sessionId: "oversized", jsonl }],
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const result = await h.tick();

    expect(result.indexed).toBe(0);
    expect(h.takeEmbedded()).toEqual([]);
    expect(h.upsertedPoints).toEqual([]);
    expect(
      h.sessionState("oversized"),
      "state must stay untouched — a checkpoint here would claim progress that never happened"
    ).toBeUndefined();
    expect(errors.some((e) => e.includes("STUCK") && e.includes("oversized"))).toBe(true);

    // Still stuck, still loud, still not marked done on the next tick.
    await h.tick();
    expect(h.sessionState("oversized")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// remainingTickBudget — the read-only helper the prefix selection is sized on.
// ---------------------------------------------------------------------------

describe("remainingTickBudget", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.EMBED_SPEND_LEDGER_PATH = LEDGER_PATH;
    process.env.EMBED_DRY_RUN = "true";
    process.env.MAX_EMBEDS_PER_TICK = "5";
    vi.doMock("../../core/config.js", () => ({ config: CONFIG_STUB }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.EMBED_SPEND_LEDGER_PATH;
    delete process.env.EMBED_DRY_RUN;
  });

  it("reports the unspent budget, floors at zero, and refills on tick reset", async () => {
    const { remainingTickBudget, chargeTick, resetTickCounter, EmbedQuotaExceededError } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    expect(remainingTickBudget()).toBe(5);

    chargeTick(2, 100, 0);
    expect(remainingTickBudget()).toBe(3);

    chargeTick(3, 100, 0);
    expect(remainingTickBudget()).toBe(0);

    // The kill-switch is untouched: charging past the cap still throws, and the
    // counter it leaves behind is over the cap — the floor is what keeps the
    // helper from reporting a negative budget.
    expect(() => chargeTick(1, 10, 0)).toThrow(EmbedQuotaExceededError);
    expect(remainingTickBudget()).toBe(0);

    resetTickCounter();
    expect(remainingTickBudget()).toBe(5);
  });
});
