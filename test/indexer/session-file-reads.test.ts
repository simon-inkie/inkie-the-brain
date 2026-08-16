/**
 * How indexCCSession gets a session transcript off disk.
 *
 * Two bugs live here, both invisible until a transcript gets big.
 *
 * 1. `readFile(path, "utf-8")` materialises the WHOLE file as one JS string.
 *    V8 caps a single string at `buffer.constants.MAX_STRING_LENGTH` (~512MB on
 *    Node 22), so past that size the read threw `RangeError: Invalid string
 *    length` before a single line was parsed — deterministically, every tick,
 *    forever. One live agent's transcript passed 1GB and had never indexed a
 *    message.
 *
 * 2. Even streaming, re-reading and re-parsing from byte 0 on every tick throws
 *    away everything the previous ticks already did. A transcript is append-only
 *    in normal operation, so the read now seeks to a recorded byte offset and
 *    parses only what was appended since.
 *
 * The seek is the dangerous half: a wrong offset would silently skip pairs or
 * mis-number them, and pair index IS the point identity in Qdrant. So the tests
 * below use REAL files — a stub that ignored `start` would let any offset bug
 * through — and pin the boundary cases the seek can get wrong: a pair that is
 * still being written, a rewritten file, and a resume that must not renumber.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  statSync,
  utimesSync,
  openSync,
  writeSync,
  closeSync,
  rmSync,
} from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { constants as bufferConstants } from "buffer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATE_FILE = "/fake/state/message-index-state.json";
const LEDGER_PATH = "/fake/state/no-such-embed-spend-ledger.json";
const PROJECT_DIR = "-home-test-user-agents-alpha";
const AGENT = "alpha";
const SESSION_ID = "session-under-test";
const STATE_KEY = `${PROJECT_DIR}/${SESSION_ID}`;

// chunkMaxTokens 2000 → CHUNK_MAX_CHARS 8000, comfortably more than any pair
// below needs, so "one pair = one embedded chunk" holds and the assertions can
// talk about pairs rather than about chunk arithmetic.
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
  chunkMaxTokens: 2000,
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

const EMPTY_STATE = {
  sessions: {},
  ccSessions: {} as Record<string, unknown>,
  lastRun: "",
  totalMessagesIndexed: 0,
};

const fixtureDirs: string[] = [];

function newFixtureFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-cc-read-"));
  fixtureDirs.push(dir);
  return join(dir, `${SESSION_ID}.jsonl`);
}

function userLine(uuid: string, content: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-07-28T10:00:00.000Z",
    message: { role: "user", content },
  });
}

function assistantLine(uuid: string, content: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `asst-${uuid}`,
    timestamp: "2026-07-28T10:00:01.000Z",
    message: { role: "assistant", content },
  });
}

/** N complete pairs, "user message i" / "assistant reply i". */
function pairLines(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(userLine(`uuid-${i}`, `user message ${i}`));
    out.push(assistantLine(`uuid-${i}`, `assistant reply ${i}`));
  }
  return out;
}

function writeLines(path: string, lines: string[]): void {
  writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "");
}

function appendLines(path: string, lines: string[]): void {
  appendFileSync(path, lines.join("\n") + "\n");
}

/** Which pairs a set of embedded chunk texts covers, by user message number. */
function pairsIn(texts: string[]): number[] {
  const found = new Set<number>();
  for (const t of texts) {
    const m = t.match(/\[User\] user message (\d+)/);
    if (m) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Harness — real transcript on disk, real stat, stubbed Gemini/Qdrant/state.
// ---------------------------------------------------------------------------

interface UpsertedPoint {
  id: string;
  payload: { pairIndex: number; chunk: number; content: string };
}

interface SessionCheckpoint {
  pairsIndexed: number;
  lastPairIndex?: number;
  firstPairUuid?: string;
  partial?: true;
  lastSize: number;
  lastModified: string;
  resumeLineStart?: number;
  resumeLineHash?: string;
  resumePairCount?: number;
}

async function makeHarness(filePath: string, maxEmbedsPerTick = 5000) {
  process.env.MAX_EMBEDS_PER_TICK = String(maxEmbedsPerTick);

  let gate: typeof import("../../core/embedder/gate.js") | undefined;
  const embedded: string[] = [];
  const upsertedPoints: UpsertedPoint[] = [];
  const mockDelete = vi.fn().mockResolvedValue(undefined);

  vi.doMock("../../core/config.js", () => ({ config: CONFIG_STUB }));

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
    client: {
      delete: mockDelete,
      upsert: vi.fn(async (_c: string, arg: { points: UpsertedPoint[] }) => {
        upsertedPoints.push(...arg.points);
      }),
      scroll: vi.fn(),
    },
    getCollectionPointCount: vi.fn().mockResolvedValue(999),
  }));

  vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
    discoverCCSessions: vi.fn().mockResolvedValue({
      sessions: [{ projectDir: PROJECT_DIR, agentName: AGENT, filePath, sessionId: SESSION_ID }],
      skippedDirs: [],
      unmappedDirs: [],
    }),
  }));

  // Only the state file is faked. The transcript is read from the real disk,
  // through the real createReadStream, at real byte offsets.
  let stateJson = JSON.stringify(EMPTY_STATE);
  vi.doMock("fs/promises", () => ({
    readFile: vi.fn(async (path: string) => {
      if (path === STATE_FILE) return stateJson;
      throw new Error(`unexpected readFile of a transcript: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      if (path === STATE_FILE) stateJson = data;
    }),
    stat: vi.fn(async (path: string) => statSync(path)),
    readdir: vi.fn(async () => []),
    appendFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  }));

  gate = await import("../../core/embedder/gate.js");
  const { indexAllMessages } = await import("../../core/indexer/messages.js");

  return {
    tick: () => indexAllMessages(undefined, AGENT),
    takeEmbedded: () => embedded.splice(0, embedded.length),
    upsertedPoints,
    mockDelete,
    checkpoint: (): SessionCheckpoint | undefined =>
      JSON.parse(stateJson).ccSessions[STATE_KEY],
  };
}

// ---------------------------------------------------------------------------

describe("reading a session transcript off disk", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.EMBED_SPEND_LEDGER_PATH = LEDGER_PATH;
    delete process.env.EMBED_DRY_RUN;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.EMBED_SPEND_LEDGER_PATH;
    delete process.env.EMBED_DRY_RUN;
  });

  // 1 -------------------------------------------------------------------
  // THE bug. Note the CONTROL: the same fixture is proved to break the old
  // whole-file read, so a pass here cannot come from a fixture that quietly
  // fell short of the limit.
  it(
    "a session file larger than the V8 string limit is indexed instead of crashing the indexer",
    async () => {
      const filePath = newFixtureFile();

      // Two real pairs, then filler until the file is over MAX_STRING_LENGTH.
      // The filler lines are individually tiny — it is only their SUM that
      // crosses the ceiling, which is exactly the shape of a real transcript.
      writeLines(filePath, pairLines(0, 1));
      const filler = `${JSON.stringify({ type: "summary", pad: "x".repeat(900) })}\n`;
      const block = filler.repeat(10_000);
      const target = bufferConstants.MAX_STRING_LENGTH + 1024;
      while (statSync(filePath).size < target) appendFileSync(filePath, block);

      const size = statSync(filePath).size;
      expect(
        size,
        "the fixture must actually cross the ceiling, or this test proves nothing"
      ).toBeGreaterThan(bufferConstants.MAX_STRING_LENGTH);

      // CONTROL: the read this fix removed still fails on this exact file.
      await expect(
        readFile(filePath, "utf-8"),
        "the pre-fix whole-file read must still blow up here"
      ).rejects.toThrow(/Invalid string length/);

      const h = await makeHarness(filePath);
      const result = await h.tick(); // must not throw

      expect(result.indexed).toBe(2);
      expect(pairsIn(h.takeEmbedded())).toEqual([0, 1]);
      expect(h.checkpoint()!.pairsIndexed).toBe(2);
    },
    120_000 // builds and streams ~540MB; slow by nature, not by accident
  );

  // 2 -------------------------------------------------------------------
  it("an ordinary small session file indexes every pair in order, unchanged", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, pairLines(0, 3));

    const h = await makeHarness(filePath);
    const result = await h.tick();

    expect(result.indexed).toBe(4);
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2, 3]);
    expect(h.upsertedPoints.map((p) => p.payload.pairIndex)).toEqual([0, 1, 2, 3]);
    expect(h.upsertedPoints[2].payload.content).toContain("assistant reply 2");

    const cp = h.checkpoint()!;
    expect(cp.pairsIndexed).toBe(4);
    expect(cp.lastPairIndex).toBe(3);
    expect(cp.firstPairUuid).toBe("uuid-0");
    expect(cp.partial).toBeUndefined();
    expect(h.mockDelete).not.toHaveBeenCalled();
  });

  // 3 -------------------------------------------------------------------
  it("appended pairs are indexed without re-embedding the ones already indexed", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, pairLines(0, 1));

    const h = await makeHarness(filePath);
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1]);

    appendLines(filePath, pairLines(2, 3));
    const tick2 = await h.tick();

    expect(pairsIn(h.takeEmbedded()), "only the appended pairs").toEqual([2, 3]);
    expect(tick2.indexed).toBe(2);
    expect(h.mockDelete).not.toHaveBeenCalled();
    expect(h.checkpoint()!.lastPairIndex).toBe(3);
  });

  // 4 -------------------------------------------------------------------
  // The resume proof. The prefix is overwritten with garbage of the SAME length
  // and the mtime is restored, so the file still looks untouched to the
  // staleness check — a read that started at byte 0 would parse the garbage and
  // produce a different pair count. Only a read that skips the prefix survives.
  it("a resumed read continues from the recorded offset instead of re-parsing the prefix", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, pairLines(0, 4));

    // Budget 3 chunks = 3 pairs, so the tick stops mid-file with a checkpoint.
    const h = await makeHarness(filePath, 3);
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2]);

    const cp = h.checkpoint()!;
    expect(cp.partial).toBe(true);
    expect(
      cp.resumePairCount,
      "the checkpoint must record where the NEXT read may start"
    ).toBe(3);
    expect(cp.resumeLineStart).toBeGreaterThan(0);

    // Corrupt everything before the resume point, byte-for-byte in place.
    const before = statSync(filePath);
    const fd = openSync(filePath, "r+");
    writeSync(fd, Buffer.alloc(cp.resumeLineStart!, 0x7e /* '~' */), 0, cp.resumeLineStart!, 0);
    closeSync(fd);
    utimesSync(filePath, before.atime, before.mtime);
    expect(statSync(filePath).size).toBe(before.size);

    const tick2 = await h.tick();

    expect(
      pairsIn(h.takeEmbedded()),
      "the unindexed tail must be picked up, with its ORIGINAL pair numbers"
    ).toEqual([3, 4]);
    expect(tick2.indexed).toBe(2);
    expect(
      h.upsertedPoints.map((p) => p.payload.pairIndex),
      "pair numbering continues at 3 — a suffix parse that restarted at 0 would " +
        "overwrite the points of pairs 0 and 1"
    ).toEqual([0, 1, 2, 3, 4]);

    const done = h.checkpoint()!;
    expect(done.lastPairIndex).toBe(4);
    expect(done.pairsIndexed).toBe(5);
    expect(done.partial, "completion clears the partial flag").toBeUndefined();
  });

  // 5 -------------------------------------------------------------------
  // The boundary a byte offset can silently get wrong. A user line with no
  // reply yet is a pair NOW and a different pair once the reply lands, so the
  // resume point must stay BEHIND it. Seeking past it would strand the user
  // half and file the reply as an orphan.
  it("a user message that gains its reply later is indexed as one pair, not two", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, [...pairLines(0, 0), userLine("uuid-1", "user message 1")]);

    const h = await makeHarness(filePath);
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1]);
    expect(h.checkpoint()!.pairsIndexed).toBe(2);

    appendLines(filePath, [assistantLine("uuid-1", "assistant reply 1")]);
    await h.tick();

    expect(
      h.checkpoint()!.pairsIndexed,
      "the reply joins the waiting user message — it must not become a second pair"
    ).toBe(2);

    const pair1 = h.upsertedPoints.filter((p) => p.payload.pairIndex === 1);
    expect(pair1.length).toBeGreaterThan(0);
    const latest = pair1[pair1.length - 1].payload.content;
    expect(latest).toContain("user message 1");
    expect(latest, "the completed pair carries both halves").toContain("assistant reply 1");
  });

  // 6 -------------------------------------------------------------------
  it("a rewritten session file is re-read in full and re-embedded from scratch", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, pairLines(0, 2));

    const h = await makeHarness(filePath);
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2]);
    expect(h.checkpoint()!.firstPairUuid).toBe("uuid-0");

    // Replaced in place with different content that also happens to be LONGER,
    // i.e. it looks like growth to a size check. Only re-reading the file can
    // reveal that pair[0] is a different message now.
    writeLines(filePath, [
      userLine("uuid-REWRITTEN", "user message 7 with extra padding to grow the file"),
      assistantLine("uuid-REWRITTEN", "assistant reply 7 with extra padding to grow the file"),
      ...pairLines(8, 9),
    ]);

    await h.tick();

    expect(
      h.mockDelete,
      "a rewrite must wipe the old points, not append to them"
    ).toHaveBeenCalledTimes(1);
    expect(pairsIn(h.takeEmbedded())).toEqual([7, 8, 9]);
    const cp = h.checkpoint()!;
    expect(cp.pairsIndexed).toBe(3);
    expect(
      cp.firstPairUuid,
      "the checkpoint adopts the CURRENT pair[0], or the next tick deletes and restarts forever"
    ).toBe("uuid-REWRITTEN");
  });

  // 7 -------------------------------------------------------------------
  it("a truncated session file is re-read in full and re-embedded from scratch", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, pairLines(0, 4));

    const h = await makeHarness(filePath);
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1, 2, 3, 4]);

    writeLines(filePath, pairLines(0, 1)); // trimmed: 5 pairs → 2
    await h.tick();

    expect(h.mockDelete).toHaveBeenCalledTimes(1);
    expect(pairsIn(h.takeEmbedded())).toEqual([0, 1]);
    expect(h.checkpoint()!.pairsIndexed).toBe(2);
  });

  // 8 -------------------------------------------------------------------
  // The recorded offset is only trusted after the line it points at is re-read
  // and matched. This forges a checkpoint whose offset is a lie; the read must
  // notice and fall back rather than parse from the wrong place.
  it("an offset that no longer matches the file is discarded in favour of a full read", async () => {
    const filePath = newFixtureFile();
    writeLines(filePath, pairLines(0, 2));

    const h = await makeHarness(filePath, 1); // 1 chunk → 1 pair per tick
    await h.tick();
    expect(pairsIn(h.takeEmbedded())).toEqual([0]);
    const cp = h.checkpoint()!;
    expect(cp.resumeLineStart).toBeGreaterThan(0);

    // Move the offset into the middle of a line. Nothing else changes, so the
    // staleness check still says "untouched" and the seek WILL be attempted.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const bad = { ...cp, resumeLineStart: cp.resumeLineStart! + 7 };
    const { writeFile } = await import("fs/promises");
    await writeFile(
      STATE_FILE,
      JSON.stringify({ ...EMPTY_STATE, ccSessions: { [STATE_KEY]: bad } })
    );

    await h.tick();

    expect(
      errors.some((e) => e.includes("did not verify")),
      "a bad offset must be reported, not silently trusted"
    ).toBe(true);
    expect(
      pairsIn(h.takeEmbedded()),
      "the full read still resumes at the right pair — no pair skipped, none redone"
    ).toEqual([1]);
    expect(h.checkpoint()!.lastPairIndex).toBe(1);
  });
});
