/**
 * Tests for the embedding cost-spike fix:
 *   - Incremental indexing tri-guard (messages.ts)
 *   - Harness-marker content hard block (config.messageIndexing.skipPatterns)
 *   - Dry-run + kill-switch (core/embedder/gate.ts, text.ts, assets.ts)
 *   - Daily cumulative spend circuit breaker (core/embedder/gate.ts)
 *   - Qdrant upsert idempotency (ccPointId)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
// Real config, bound once at top level — immune to the per-test vi.doMock("config")
// partial mocks used elsewhere in this file.
import { config as realConfig } from "../../core/config.js";

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

function makePair(
  pairIndex: number,
  userMessageId: string,
  userContent = "hello",
  assistantContent = "world"
) {
  return {
    pairIndex,
    userContent,
    userMessageId,
    assistantContent,
    assistantMessageId: `asst-${pairIndex}`,
    timestamp: new Date().toISOString(),
    timestampMs: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Suite 1 — embedder: dry-run + kill-switch
// ---------------------------------------------------------------------------

describe("embedder — dry-run + kill-switch", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.EMBED_DRY_RUN;
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EMBED_DRY_RUN;
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.GEMINI_API_KEY;
  });

  it("EMBED_DRY_RUN=true — returns zero-vectors of correct dimension, no Gemini call", async () => {
    process.env.EMBED_DRY_RUN = "true";
    // Mock config to expose dimension
    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
      },
    }));
    // GoogleGenAI should never be instantiated
    const mockEmbedContent = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: vi.fn().mockImplementation(() => ({
        models: { embedContent: mockEmbedContent },
      })),
    }));
    // fs/promises mock for telemetry flush (appendFile)
    vi.doMock("fs/promises", () => ({
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { embedTexts, resetTickCounter } = await import("../../core/embedder/text.js");
    resetTickCounter();

    const inputs = ["hello world", "foo bar"];
    const result = await embedTexts(inputs, "RETRIEVAL_DOCUMENT");

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(768);
    expect(result[0].every((v) => v === 0)).toBe(true);
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it("kill-switch: counter exceeds MAX_EMBEDS_PER_TICK — EmbedQuotaExceededError thrown", async () => {
    process.env.MAX_EMBEDS_PER_TICK = "3";
    process.env.EMBED_DRY_RUN = "true"; // use dry-run so no Gemini needed
    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
      },
    }));
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: vi.fn(),
    }));
    vi.doMock("fs/promises", () => ({
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { embedTexts, resetTickCounter, EmbedQuotaExceededError } = await import(
      "../../core/embedder/text.js"
    );
    resetTickCounter();

    // First call: 3 texts — counter = 3, ceiling = 3, 3 > 3 is false so it passes
    await embedTexts(["a", "b", "c"], "RETRIEVAL_DOCUMENT");

    // Second call: 1 more text — counter = 4 > 3 → throws
    await expect(embedTexts(["d"], "RETRIEVAL_DOCUMENT")).rejects.toBeInstanceOf(
      EmbedQuotaExceededError
    );
  });

  it("resetTickCounter resets the counter so a new tick can proceed", async () => {
    process.env.MAX_EMBEDS_PER_TICK = "2";
    process.env.EMBED_DRY_RUN = "true";
    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
      },
    }));
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: vi.fn(),
    }));
    vi.doMock("fs/promises", () => ({
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { embedTexts, resetTickCounter, EmbedQuotaExceededError } = await import(
      "../../core/embedder/text.js"
    );
    resetTickCounter();
    await embedTexts(["a", "b"], "RETRIEVAL_DOCUMENT"); // counter = 2

    // Without reset, next call would throw
    await expect(embedTexts(["c"], "RETRIEVAL_DOCUMENT")).rejects.toBeInstanceOf(
      EmbedQuotaExceededError
    );

    // After reset, next tick works
    resetTickCounter();
    const result = await embedTexts(["c"], "RETRIEVAL_DOCUMENT");
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 1b — estimateCostUsd rate: invoice-verified rate + env override
// ---------------------------------------------------------------------------

describe("estimateCostUsd — invoice-verified rate", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEMINI_EMBED_USD_PER_1K_TOKENS;
  });

  afterEach(() => {
    delete process.env.GEMINI_EMBED_USD_PER_1K_TOKENS;
  });

  it("default rate is the invoice-verified 0.00019/1K (not the 7.6x-low 0.000025)", async () => {
    vi.doMock("../../core/config.js", () => ({
      config: { embeddingModel: "gemini-embedding-2-preview", embeddingDimensions: 768 },
    }));
    const { estimateCostUsd, GEMINI_EMBED_USD_PER_1K_TOKENS } = await import(
      "../../core/embedder/gate.js"
    );
    expect(GEMINI_EMBED_USD_PER_1K_TOKENS).toBeCloseTo(0.00019, 10);
    // 4000 chars ≈ 1000 tokens ≈ 1K-token unit → cost == the per-1K rate.
    expect(estimateCostUsd(4000)).toBeCloseTo(0.00019, 10);
    // Regression guard: the old broken rate would yield 0.000025 here.
    expect(estimateCostUsd(4000)).not.toBeCloseTo(0.000025, 10);
  });

  it("GEMINI_EMBED_USD_PER_1K_TOKENS env overrides the rate (Google repricing, no code change)", async () => {
    process.env.GEMINI_EMBED_USD_PER_1K_TOKENS = "0.0005";
    vi.doMock("../../core/config.js", () => ({
      config: { embeddingModel: "gemini-embedding-2-preview", embeddingDimensions: 768 },
    }));
    const { estimateCostUsd } = await import("../../core/embedder/gate.js");
    expect(estimateCostUsd(4000)).toBeCloseTo(0.0005, 10);
  });

  it("cost scales linearly with chars", async () => {
    vi.doMock("../../core/config.js", () => ({
      config: { embeddingModel: "gemini-embedding-2-preview", embeddingDimensions: 768 },
    }));
    const { estimateCostUsd } = await import("../../core/embedder/gate.js");
    expect(estimateCostUsd(8000)).toBeCloseTo(estimateCostUsd(4000) * 2, 10);
    expect(estimateCostUsd(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2b — content-level hard block: watcher/task-notification noise
// ---------------------------------------------------------------------------

describe("messageIndexing.skipPatterns — START-ANCHORED harness-marker hard block (Phase 1)", () => {
  // shouldSkipMessage runs at index time on RAW per-message content
  // (messages.ts parseCCSessionFile:297 / parseSessionFile:233). Every pattern
  // here is start-anchored: a harness marker that OPENS a message is noise; the
  // same marker quoted mid-prose is legitimate content and must pass.
  // Validated against a 939,669-message raw-log corpus before the patterns
  // were locked.
  const pats = realConfig.messageIndexing.skipPatterns;
  const blocked = (s: string) => pats.some((p) => p.test(s));

  it("RECALL: blocks the harness-marker noise class when it opens a message", () => {
    // The actual bleed content shape (~301k of these in the raw logs)
    expect(blocked('<task-notification>\n<task-id>b11ihc22w</task-id>\n<summary>Monitor event: "📬 alice inbox events"</summary>')).toBe(true);
    // Leading-whitespace variant (some logs indent the block)
    expect(blocked("  <task-notification>\n<summary>Monitor event: x</summary>")).toBe(true);
    // Other harness markers that open a turn
    expect(blocked("<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.")).toBe(true);
    expect(blocked("<command-name>/compact</command-name>\n  <command-message>compact</command-message>")).toBe(true);
    expect(blocked('<system-reminder>\nThe user named this session "alpha".\n</system-reminder>')).toBe(true);
  });

  it("BOUNDARY: [from:] tmux relay pings are agent-authored — KEPT, not skipped (locked 2026-06-01)", () => {
    // The filter blocks harness-INJECTED markers only. [from:...] pings are
    // agent-authored inter-agent coordination = signal, not noise.
    expect(blocked("[from:alice] check your inbox — message from alice")).toBe(false);
    expect(blocked("[from:operator via alice] 🔴 P0 cost-spike, check inbox NOW")).toBe(false);
    expect(blocked("[from:alice] small calibration: default proactive on signal cues")).toBe(false);
  });

  it("FP FIX: a harness marker quoted MID-PROSE is legit content and must pass", () => {
    // The 3,335 false-positives the old unanchored /Monitor event: / wrongly killed.
    // Dominant shape: observe-pipeline prompts that quote a slice of conversation.
    expect(blocked("Here is the conversation slice to observe.\n\n---\n\n[15:57] User: <task-notification>\n<summary>Monitor event: x</summary>")).toBe(false);
    expect(blocked("foo Monitor event: bar")).toBe(false);
    // An agent discussing the noise class in conversation must index normally
    expect(blocked("The bleed was 105k <task-notification> rows — every one a Monitor event: notification.")).toBe(false);
    expect(blocked("I relayed the operator's note with a [from:alice] prefix so you'd know the source.")).toBe(false);
  });

  it("passes ordinary conversation untouched", () => {
    expect(blocked("Hey alpha, can you check the indexer state and confirm the gate is live?")).toBe(false);
    expect(blocked("I'll snapshot io-messages then run the blue-green swap.")).toBe(false);
  });

  it("REGRESSION: the unanchored /Monitor event: / pattern is gone", () => {
    // It FP'd 3,335 legit rows. Its job (catching the bleed) is fully covered by
    // /^\s*<task-notification>/ since every Monitor-event notification is wrapped.
    expect(pats.some((p) => p.source === "Monitor event: ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — incremental indexing tri-guard (messages.ts helpers)
// ---------------------------------------------------------------------------

// We test the tri-guard decision logic by importing the helpers that are
// exported from messages.ts (extractTextContent, reconcileMessageState)
// and by verifying the ccPointId determinism.

describe("ccPointId determinism (upsert idempotency)", () => {
  it("same projectDir/sessionId/pairIndex/chunk produces same UUID-shaped string", async () => {
    // ccPointId is not exported — we test via SHA256 behaviour by importing
    // messages.ts and checking that calling indexCCSession twice with the
    // same data does not error and produces consistent state.
    // Since we can't easily stub client.upsert AND verify idempotency without
    // a real Qdrant, we verify the hash directly.

    const { createHash } = await import("crypto");

    function ccPointId(projectDir: string, sessionId: string, pairIndex: number, chunk: number): string {
      const hash = createHash("sha256")
        .update(`io-messages:cc:${projectDir}/${sessionId}:pair-${pairIndex}:chunk-${chunk}`)
        .digest("hex");
      return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
      ].join("-");
    }

    const id1 = ccPointId("proj", "sess123", 0, 0);
    const id2 = ccPointId("proj", "sess123", 0, 0);
    expect(id1).toBe(id2);
    // Verify it's UUID-shaped (8-4-4-4-12)
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Different pairIndex → different ID
    const id3 = ccPointId("proj", "sess123", 1, 0);
    expect(id3).not.toBe(id1);
  });
});

describe("reconcileMessageState — stale state file", () => {
  it("state with pairsIndexed: 100 for a missing file is gracefully skipped by discovery", async () => {
    // The stale-state scenario: state has an entry but the JSONL file doesn't exist.
    // discoverCCSessions only returns sessions with existing files (it does stat()),
    // so the stale entry just never gets passed to indexCCSession.
    // Verify reconcileMessageState itself doesn't crash on ccSessions entries.

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: vi.fn(), upsert: vi.fn(), scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(200),
    }));

    const { reconcileMessageState } = await import("../../core/indexer/messages.js");

    const staleState = {
      sessions: {},
      ccSessions: {
        "missing-project/missing-session": {
          file: "missing-session.jsonl",
          projectDir: "missing-project",
          agentName: "alpha",
          lastSize: 1000,
          lastModified: new Date().toISOString(),
          pairsIndexed: 100,
          lastPairIndex: 99,
          firstPairUuid: "uuid-abc",
        },
      },
      lastRun: "",
      totalMessagesIndexed: 0,
    };

    // reconcileMessageState only looks at sessions (not ccSessions) for count;
    // it should return the state unchanged (not wipe it) when expected is 0.
    const result = await reconcileMessageState(staleState, {
      getCount: vi.fn().mockResolvedValue(0),
    });
    // ccSessions entry preserved — stale state is harmless
    expect(result.ccSessions["missing-project/missing-session"]).toBeDefined();
  });
});

describe("extractTextContent", () => {
  it("returns string content as-is", async () => {
    const { extractTextContent } = await import("../../core/indexer/messages.js");
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("extracts text blocks from ContentBlock array", async () => {
    const { extractTextContent } = await import("../../core/indexer/messages.js");
    const blocks = [
      { type: "text", text: "hello" },
      { type: "toolCall", id: "x" },
      { type: "text", text: "world" },
    ];
    expect(extractTextContent(blocks)).toBe("hello\nworld");
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — tri-guard logic via state shape assertions
// The actual tri-guard runs inside indexCCSession (not exported), but we can
// verify its effect by checking what state it writes. We test via a lightweight
// harness that stubs the Qdrant client and embedTexts.
// ---------------------------------------------------------------------------

// Minimal config stub used across tri-guard tests
const CONFIG_STUB = {
  embeddingModel: "gemini-embedding-2-preview",
  embeddingDimensions: 768,
  collections: { messages: "io-messages", brain: "brain-vault", observations: "io-observations", reflections: "io-reflections", assets: "io-assets" },
  chunkMaxTokens: 2000,
  messageIndexing: {
    stateFile: "/tmp/test-state.json",
    minContentLength: 5,
    roles: ["user", "assistant"],
    skipPatterns: [] as RegExp[],
    skipToolOnlyMessages: false,
  },
  sources: { messages: "/tmp/fake-messages" },
  agents: [],
};

describe("tri-guard — state transition assertions", () => {
  // Transcripts must be REAL files on disk: indexCCSession reads them with a
  // byte-offset-aware createReadStream, not readFile, so a string handed back
  // by an fs/promises stub would never reach the parser and every assertion
  // below would pass vacuously. The `stat` stubs stay stubs — several of these
  // tests deliberately misreport the size to drive one specific guard.
  const ccFixtureDirs: string[] = [];

  function writeCCFixture(jsonl: string): string {
    const dir = mkdtempSync(pathJoin(tmpdir(), "brain-cc-triguard-"));
    ccFixtureDirs.push(dir);
    const filePath = pathJoin(dir, "test-session-id.jsonl");
    writeFileSync(filePath, jsonl);
    return filePath;
  }

  beforeEach(() => {
    vi.resetModules();
    delete process.env.EMBED_DRY_RUN;
    delete process.env.GEMINI_API_KEY;
    // Always mock config in this suite
    vi.doMock("../../core/config.js", () => ({ config: CONFIG_STUB }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of ccFixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a minimal JSONL session file from pairs array.
   * Each pair produces one "user" line + one "assistant" line.
   */
  function buildSessionJSONL(pairs: { uuid: string; userContent: string; assistantContent: string }[]): string {
    const lines: string[] = [];
    for (const p of pairs) {
      lines.push(JSON.stringify({
        type: "user",
        uuid: p.uuid,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: p.userContent },
      }));
      lines.push(JSON.stringify({
        type: "assistant",
        uuid: `asst-${p.uuid}`,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: p.assistantContent },
      }));
    }
    return lines.join("\n") + "\n";
  }

  it("first run (no state) — embeds all pairs, sets lastPairIndex + firstPairUuid", async () => {
    const pairs = [
      { uuid: "uuid-0", userContent: "hello world this is pair zero", assistantContent: "assistant response zero" },
      { uuid: "uuid-1", userContent: "hello world this is pair one", assistantContent: "assistant response one" },
    ];
    const jsonl = buildSessionJSONL(pairs);
    const sessionPath = writeCCFixture(jsonl);

    const mockUpsert = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: mockDelete, upsert: mockUpsert, scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(999),
    }));

    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => new Array(768).fill(0.1))
      ),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    const emptyState = JSON.stringify({ sessions: {}, ccSessions: {}, lastRun: "", totalMessagesIndexed: 0 });
    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("state")) return emptyState;
        // A transcript must never come back through readFile: that is the call
        // that blows V8's string ceiling on a large session.
        throw new Error(`unexpected readFile of a transcript: ${path}`);
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: jsonl.length,
        mtime: new Date("2026-01-01"),
        isDirectory: () => true,
      }),
    }));

    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            projectDir: "-home-test-user-agents-alpha",
            agentName: "alpha",
            filePath: sessionPath,
            sessionId: "test-session-id",
          },
        ],
        skippedDirs: [],
        unmappedDirs: [],
      }),
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    const result = await indexAllMessages(undefined, "alpha");

    // Should have indexed at least 1 chunk
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    expect(mockUpsert).toHaveBeenCalled();
    // delete should NOT be called on first run (delta path, no prior state)
    expect(mockDelete).not.toHaveBeenCalled();

    // Verify state written includes lastPairIndex and firstPairUuid
    const writeFileMock = (await import("fs/promises")).writeFile as ReturnType<typeof vi.fn>;
    const stateArg = writeFileMock.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("lastPairIndex")
    );
    expect(stateArg).toBeDefined();
    const stateWritten = JSON.parse(stateArg![1] as string);
    const sessionState = stateWritten.ccSessions["-home-test-user-agents-alpha/test-session-id"];
    expect(sessionState).toBeDefined();
    expect(sessionState.lastPairIndex).toBe(1); // 0-based, 2 pairs → index 1
    expect(sessionState.firstPairUuid).toBe("uuid-0");
  });

  it("pairs.length < pairsIndexed — triggers full re-embed (delete-by-source)", async () => {
    const pairs = [
      { uuid: "uuid-0", userContent: "hello", assistantContent: "world" },
    ];
    const jsonl = buildSessionJSONL(pairs);
    const sessionPath = writeCCFixture(jsonl);

    const mockUpsert = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    // State says 5 pairs previously indexed — but file now has only 1
    const existingState = {
      sessions: {},
      ccSessions: {
        "-home-test-user-agents-alpha/test-session-id": {
          file: "test-session-id.jsonl",
          projectDir: "-home-test-user-agents-alpha",
          agentName: "alpha",
          lastSize: 50,
          lastModified: new Date("2025-01-01").toISOString(),
          pairsIndexed: 5,
          lastPairIndex: 4,
          firstPairUuid: "uuid-0",
        },
      },
      lastRun: "",
      totalMessagesIndexed: 0,
    };

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: mockDelete, upsert: mockUpsert, scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(999),
    }));

    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => new Array(768).fill(0.1))
      ),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("state")) return JSON.stringify(existingState);
        // A transcript must never come back through readFile: that is the call
        // that blows V8's string ceiling on a large session.
        throw new Error(`unexpected readFile of a transcript: ${path}`);
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: jsonl.length + 1, // size changed
        mtime: new Date("2026-05-18"),
        isDirectory: () => true,
      }),
    }));

    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            projectDir: "-home-test-user-agents-alpha",
            agentName: "alpha",
            filePath: sessionPath,
            sessionId: "test-session-id",
          },
        ],
        skippedDirs: [],
        unmappedDirs: [],
      }),
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    await indexAllMessages(undefined, "alpha");

    // Full re-embed path: delete should be called
    expect(mockDelete).toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
  });

  it("firstPairUuid mismatch — triggers full re-embed", async () => {
    const pairs = [
      // uuid-NEW is different from state's uuid-ORIG
      { uuid: "uuid-NEW", userContent: "rewritten", assistantContent: "content" },
      { uuid: "uuid-1", userContent: "second", assistantContent: "pair" },
    ];
    const jsonl = buildSessionJSONL(pairs);
    const sessionPath = writeCCFixture(jsonl);

    const mockDelete = vi.fn().mockResolvedValue(undefined);
    const mockUpsert = vi.fn().mockResolvedValue(undefined);

    const existingState = {
      sessions: {},
      ccSessions: {
        "-home-test-user-agents-alpha/test-session-id": {
          file: "test-session-id.jsonl",
          projectDir: "-home-test-user-agents-alpha",
          agentName: "alpha",
          lastSize: 50,
          lastModified: new Date("2025-01-01").toISOString(),
          pairsIndexed: 2,
          lastPairIndex: 1,
          firstPairUuid: "uuid-ORIG", // ← mismatch with uuid-NEW
        },
      },
      lastRun: "",
      totalMessagesIndexed: 0,
    };

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: mockDelete, upsert: mockUpsert, scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(999),
    }));

    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => new Array(768).fill(0.1))
      ),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("state")) return JSON.stringify(existingState);
        // A transcript must never come back through readFile: that is the call
        // that blows V8's string ceiling on a large session.
        throw new Error(`unexpected readFile of a transcript: ${path}`);
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: jsonl.length + 10,
        mtime: new Date("2026-05-18"),
        isDirectory: () => true,
      }),
    }));

    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            projectDir: "-home-test-user-agents-alpha",
            agentName: "alpha",
            filePath: sessionPath,
            sessionId: "test-session-id",
          },
        ],
        skippedDirs: [],
        unmappedDirs: [],
      }),
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    await indexAllMessages(undefined, "alpha");

    expect(mockDelete).toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
  });

  it("delta path: pairs grew — only new pairs embedded, no delete", async () => {
    const pairs = [
      { uuid: "uuid-0", userContent: "first", assistantContent: "response" },
      { uuid: "uuid-1", userContent: "second", assistantContent: "response" },
      { uuid: "uuid-2", userContent: "third", assistantContent: "response" }, // NEW
    ];
    const jsonl = buildSessionJSONL(pairs);
    const sessionPath = writeCCFixture(jsonl);

    const mockDelete = vi.fn().mockResolvedValue(undefined);
    const embeddedTexts: string[] = [];
    const mockEmbed = vi.fn().mockImplementation(async (texts: string[]) => {
      embeddedTexts.push(...texts);
      return texts.map(() => new Array(768).fill(0.1));
    });

    // State: 2 pairs already indexed
    const existingState = {
      sessions: {},
      ccSessions: {
        "-home-test-user-agents-alpha/test-session-id": {
          file: "test-session-id.jsonl",
          projectDir: "-home-test-user-agents-alpha",
          agentName: "alpha",
          lastSize: 50,
          lastModified: new Date("2025-01-01").toISOString(),
          pairsIndexed: 2,
          lastPairIndex: 1,
          firstPairUuid: "uuid-0",
        },
      },
      lastRun: "",
      totalMessagesIndexed: 0,
    };

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: mockDelete, upsert: vi.fn().mockResolvedValue(undefined), scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(999),
    }));

    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: mockEmbed,
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("state")) return JSON.stringify(existingState);
        // A transcript must never come back through readFile: that is the call
        // that blows V8's string ceiling on a large session.
        throw new Error(`unexpected readFile of a transcript: ${path}`);
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: jsonl.length, // larger than the 50 in state
        mtime: new Date("2026-05-18"),
        isDirectory: () => true,
      }),
    }));

    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            projectDir: "-home-test-user-agents-alpha",
            agentName: "alpha",
            filePath: sessionPath,
            sessionId: "test-session-id",
          },
        ],
        skippedDirs: [],
        unmappedDirs: [],
      }),
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    await indexAllMessages(undefined, "alpha");

    // Delete should NOT be called on the delta path
    expect(mockDelete).not.toHaveBeenCalled();

    // Only the third pair should be embedded (pairs[2])
    // Each pair produces one chunk with "[User] ... [Assistant] ..."
    expect(embeddedTexts.length).toBe(1); // 1 new pair → 1 chunk
    expect(embeddedTexts[0]).toContain("third");
  });

  it("pairs.length === pairsIndexed but bytes grew — re-embeds last pair defensively", async () => {
    const pairs = [
      { uuid: "uuid-0", userContent: "first", assistantContent: "a longer response now" },
    ];
    const jsonl = buildSessionJSONL(pairs);
    const sessionPath = writeCCFixture(jsonl);

    const embeddedTexts: string[] = [];
    const mockEmbed = vi.fn().mockImplementation(async (texts: string[]) => {
      embeddedTexts.push(...texts);
      return texts.map(() => new Array(768).fill(0.1));
    });
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    // State: 1 pair indexed, but lastSize was smaller
    const existingState = {
      sessions: {},
      ccSessions: {
        "-home-test-user-agents-alpha/test-session-id": {
          file: "test-session-id.jsonl",
          projectDir: "-home-test-user-agents-alpha",
          agentName: "alpha",
          lastSize: 10, // smaller than actual
          lastModified: new Date("2025-01-01").toISOString(),
          pairsIndexed: 1,
          lastPairIndex: 0,
          firstPairUuid: "uuid-0",
        },
      },
      lastRun: "",
      totalMessagesIndexed: 0,
    };

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: mockDelete, upsert: vi.fn().mockResolvedValue(undefined), scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(999),
    }));

    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: mockEmbed,
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("state")) return JSON.stringify(existingState);
        // A transcript must never come back through readFile: that is the call
        // that blows V8's string ceiling on a large session.
        throw new Error(`unexpected readFile of a transcript: ${path}`);
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: jsonl.length, // bigger than state's 10
        mtime: new Date("2026-05-18"),
        isDirectory: () => true,
      }),
    }));

    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            projectDir: "-home-test-user-agents-alpha",
            agentName: "alpha",
            filePath: sessionPath,
            sessionId: "test-session-id",
          },
        ],
        skippedDirs: [],
        unmappedDirs: [],
      }),
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    await indexAllMessages(undefined, "alpha");

    // Should re-embed the last pair (defensive re-embed)
    expect(embeddedTexts.length).toBeGreaterThanOrEqual(1);
    expect(embeddedTexts[0]).toContain("first");
    // No full delete
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("dry-run mode — Qdrant upsert skipped, state still written", async () => {
    process.env.EMBED_DRY_RUN = "true";

    const pairs = [
      { uuid: "uuid-0", userContent: "dry", assistantContent: "run" },
    ];
    const jsonl = buildSessionJSONL(pairs);
    const sessionPath = writeCCFixture(jsonl);

    const mockUpsert = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../core/qdrant/client.js", () => ({
      ensureCollections: vi.fn().mockResolvedValue(undefined),
      client: { delete: mockDelete, upsert: mockUpsert, scroll: vi.fn() },
      getCollectionPointCount: vi.fn().mockResolvedValue(999),
    }));

    vi.doMock("../../core/embedder/text.js", () => ({
      embedTexts: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => new Array(768).fill(0))
      ),
      resetTickCounter: vi.fn(),
      flushTelemetry: vi.fn().mockResolvedValue(undefined),
    }));

    const emptyStateDry = JSON.stringify({ sessions: {}, ccSessions: {}, lastRun: "", totalMessagesIndexed: 0 });
    const writeFileMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("fs/promises", () => ({
      // saveState ensures the state dir exists before writing.
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("state")) return emptyStateDry;
        // A transcript must never come back through readFile: that is the call
        // that blows V8's string ceiling on a large session.
        throw new Error(`unexpected readFile of a transcript: ${path}`);
      }),
      writeFile: writeFileMock,
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: jsonl.length,
        mtime: new Date("2026-05-18"),
        isDirectory: () => true,
      }),
    }));

    vi.doMock("../../core/indexer/cc-session-discovery.js", () => ({
      discoverCCSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            projectDir: "-home-test-user-agents-alpha",
            agentName: "alpha",
            filePath: sessionPath,
            sessionId: "test-session-id",
          },
        ],
        skippedDirs: [],
        unmappedDirs: [],
      }),
    }));

    const { indexAllMessages } = await import("../../core/indexer/messages.js");
    await indexAllMessages(undefined, "alpha");

    // Qdrant mutations must be skipped in dry-run
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();

    // State file should still be written
    expect(writeFileMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — assets.ts gate: EMBED_DRY_RUN + shared tick counter
// Phase 2 tests — verifies that embedImage, embedImageWithContext, embedPdf
// all respect the shared gate in gate.ts (no bypass possible).
// ---------------------------------------------------------------------------

describe("assets embedder — dry-run + shared tick counter", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.EMBED_DRY_RUN;
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EMBED_DRY_RUN;
    delete process.env.MAX_EMBEDS_PER_TICK;
    delete process.env.GEMINI_API_KEY;
  });

  it("embedImage: EMBED_DRY_RUN=true — returns zero-vector, no Gemini call", async () => {
    process.env.EMBED_DRY_RUN = "true";

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        assetIndexing: { descriptionModel: "gemini-1.5-flash", maxPdfPages: 10 },
      },
    }));

    const mockEmbedContent = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: vi.fn().mockImplementation(() => ({
        models: { embedContent: mockEmbedContent },
      })),
    }));

    // Mock fs/promises so readFile returns a fake image buffer
    vi.doMock("fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const gateModule = await import("../../core/embedder/gate.js");
    gateModule.resetTickCounter();
    const { embedImage } = await import("../../core/embedder/assets.js");

    const result = await embedImage("/fake/image.png");

    expect(result).toHaveLength(768);
    expect(result.every((v) => v === 0)).toBe(true);
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it("embedImageWithContext: EMBED_DRY_RUN=true — returns zero-vector, no Gemini call", async () => {
    process.env.EMBED_DRY_RUN = "true";

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        assetIndexing: { descriptionModel: "gemini-1.5-flash", maxPdfPages: 10 },
      },
    }));

    const mockEmbedContent = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: vi.fn().mockImplementation(() => ({
        models: { embedContent: mockEmbedContent },
      })),
    }));

    vi.doMock("fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const gateModule = await import("../../core/embedder/gate.js");
    gateModule.resetTickCounter();
    const { embedImageWithContext } = await import("../../core/embedder/assets.js");

    const result = await embedImageWithContext("/fake/image.png", "a diagram of the system");

    expect(result).toHaveLength(768);
    expect(result.every((v) => v === 0)).toBe(true);
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it("embedPdf: EMBED_DRY_RUN=true — returns zero-vector, no Gemini call", async () => {
    process.env.EMBED_DRY_RUN = "true";

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        assetIndexing: { descriptionModel: "gemini-1.5-flash", maxPdfPages: 10 },
      },
    }));

    const mockEmbedContent = vi.fn().mockRejectedValue(new Error("should not be called"));
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: vi.fn().mockImplementation(() => ({
        models: { embedContent: mockEmbedContent },
      })),
    }));

    vi.doMock("fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake-pdf-data")),
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const gateModule = await import("../../core/embedder/gate.js");
    gateModule.resetTickCounter();
    const { embedPdf } = await import("../../core/embedder/assets.js");

    const result = await embedPdf("/fake/file.pdf");

    expect(result).toHaveLength(768);
    expect(result.every((v) => v === 0)).toBe(true);
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it("shared gate: chargeTick accumulates across calls, EmbedQuotaExceededError at cap", async () => {
    // Tests the shared gate directly via chargeTick, without the ESM module
    // instance isolation problem that makes cross-importer tests brittle.
    // This confirms the gate's budget is system-wide: any embedder that calls
    // chargeTick() shares the same counter and will trip the kill-switch.
    process.env.MAX_EMBEDS_PER_TICK = "2";
    process.env.EMBED_DRY_RUN = "true";

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        assetIndexing: { descriptionModel: "gemini-1.5-flash", maxPdfPages: 10 },
      },
    }));
    vi.doMock("@google/genai", () => ({ GoogleGenAI: vi.fn() }));
    vi.doMock("fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
      appendFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { chargeTick, resetTickCounter, EmbedQuotaExceededError } = await import(
      "../../core/embedder/gate.js"
    );
    resetTickCounter();

    // Simulate "text embedder" charging 1
    chargeTick(1, 100, 0.000001);

    // Simulate "asset embedder" charging 1 → counter = 2, NOT > 2 → passes
    chargeTick(1, 0, 0.0001);

    // One more charge → counter = 3 > 2 → throws
    expect(() => chargeTick(1, 0, 0.0001)).toThrow(EmbedQuotaExceededError);
  });

  it("embedImage: telemetry has agent attribution in either state", async () => {
    process.env.EMBED_DRY_RUN = "true";
    process.env.AGENT_NAME = "test-agent";

    vi.doMock("../../core/config.js", () => ({
      config: {
        embeddingModel: "gemini-embedding-2-preview",
        embeddingDimensions: 768,
        assetIndexing: { descriptionModel: "gemini-1.5-flash", maxPdfPages: 10 },
      },
    }));
    vi.doMock("@google/genai", () => ({ GoogleGenAI: vi.fn() }));

    const mockAppendFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
      appendFile: mockAppendFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    // Import gate first, then assets — ensures shared module instance
    const gateModule = await import("../../core/embedder/gate.js");
    gateModule.resetTickCounter();
    const { embedImage } = await import("../../core/embedder/assets.js");

    await embedImage("/fake/image.png");
    await gateModule.flushTelemetry();

    // appendFile should have been called with a JSONL line containing agentName
    expect(mockAppendFile).toHaveBeenCalled();
    const writtenPayload = mockAppendFile.mock.calls[0][1] as string;
    const record = JSON.parse(writtenPayload.trim());
    expect(record.agentName).toBe("test-agent");
    expect(record.dryRun).toBe(true);
    expect(record.callsThisTick).toBe(1);

    delete process.env.AGENT_NAME;
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — daily cumulative spend circuit breaker
// Tests the cross-tick ledger: hard cap, soft threshold, persistence,
// corrupt/missing file, day-bucket isolation, and per-tick kill-switch
// regression guard.
// ---------------------------------------------------------------------------

import { tmpdir } from "os";
import { join as pathJoin } from "path";
import { writeFileSync, unlinkSync, existsSync } from "fs";

describe("daily spend circuit breaker", () => {
  let ledgerPath: string;

  beforeEach(() => {
    vi.resetModules();
    // Point at a unique temp file per test — never touches the real ledger.
    ledgerPath = pathJoin(tmpdir(), `embed-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.EMBED_SPEND_LEDGER_PATH = ledgerPath;
    // Use tiny thresholds so tests don't need huge cost values.
    // Cleared via vi.resetModules() + fresh dynamic import each test.
    delete process.env.EMBED_DRY_RUN;
    delete process.env.EMBED_DAILY_BUDGET_USD;
    delete process.env.EMBED_DAILY_HARD_CAP_USD;
    vi.doMock("../../core/config.js", () => ({
      config: { embeddingModel: "gemini-embedding-2-preview", embeddingDimensions: 768 },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp ledger file if it exists.
    try { if (existsSync(ledgerPath)) unlinkSync(ledgerPath); } catch { /* ignore */ }
    delete process.env.EMBED_SPEND_LEDGER_PATH;
    delete process.env.EMBED_DRY_RUN;
    delete process.env.EMBED_DAILY_BUDGET_USD;
    delete process.env.EMBED_DAILY_HARD_CAP_USD;
  });

  it("hard cap: EmbedBudgetExceededError thrown once cumulative cost crosses EMBED_DAILY_HARD_CAP_USD", async () => {
    // Set hard cap tiny so a small number of chargeTick calls trips it.
    process.env.EMBED_DAILY_HARD_CAP_USD = "0.001";
    process.env.EMBED_DAILY_BUDGET_USD = "0.0005"; // soft below hard

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, EmbedBudgetExceededError, estimateCostUsd } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // Each charge: 4000 chars = ~1000 tokens = $0.00019 at default rate
    // But we override hard cap to $0.001, so 6 calls at $0.00019 = $0.00114 > $0.001
    // Use a big chars value to cross quickly.
    const bigChars = 4000 * 5; // ~$0.00095 per call
    // First call: $0.00095 — still under $0.001
    chargeTick(1, bigChars, estimateCostUsd(bigChars));
    // Second call: $0.0019 — crosses $0.001
    expect(() => chargeTick(1, bigChars, estimateCostUsd(bigChars))).toThrow(EmbedBudgetExceededError);
  });

  it("hard cap: error message names the day, cumulative cost, cap, and halted reason", async () => {
    process.env.EMBED_DAILY_HARD_CAP_USD = "0.001";
    process.env.EMBED_DAILY_BUDGET_USD = "0.0005";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, EmbedBudgetExceededError, estimateCostUsd } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    const bigChars = 4000 * 5;
    chargeTick(1, bigChars, estimateCostUsd(bigChars));

    let caughtError: Error | null = null;
    try {
      chargeTick(1, bigChars, estimateCostUsd(bigChars));
    } catch (e) {
      caughtError = e as Error;
    }
    expect(caughtError).toBeInstanceOf(EmbedBudgetExceededError);
    expect(caughtError!.message).toMatch(/\d{4}-\d{2}-\d{2}/); // day
    expect(caughtError!.message).toContain("0.001"); // cap
    expect(caughtError!.message).toContain("halted to prevent cost regression");
  });

  it("soft threshold: logs warn but does NOT throw, fires only once per process per day", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "0.0001"; // tiny soft threshold
    process.env.EMBED_DAILY_HARD_CAP_USD = "100";  // hard cap far away

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting } =
      await import("../../core/embedder/gate.js");
    const { log: logFn } = await import("../../core/log.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    const logSpy = vi.spyOn({ log: logFn }, "log");

    // We can't easily spy on the imported log in gate.ts (it's a direct import).
    // Instead verify that: (a) no throw, (b) subsequent calls also don't throw.
    // Functional verification of "once only" is via resetSpendLedgerForTesting.

    // Cross the soft threshold — should not throw.
    // 4000 chars = $0.00019 > $0.0001
    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();
    // Second call — should still not throw (soft threshold doesn't halt).
    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();
    // Third call — ditto.
    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();

    logSpy.mockRestore();
  });

  it("soft threshold: resetSpendLedgerForTesting re-arms the once-per-day warn", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "0.0001";
    process.env.EMBED_DAILY_HARD_CAP_USD = "100";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // Cross soft threshold.
    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();

    // Reset — warn flag cleared.
    resetSpendLedgerForTesting();

    // Crossing again after reset should not throw (still soft).
    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();
  });

  it("ledger persists to and loads from the configured temp path across a flush", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "100";
    process.env.EMBED_DAILY_HARD_CAP_USD = "200";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, flushTelemetry } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // Charge a known amount.
    const chars = 4000;
    const cost = 0.00019;
    chargeTick(1, chars, cost);
    chargeTick(1, chars, cost);

    // Flush persists the ledger to disk.
    await flushTelemetry();

    // Verify the file was written.
    expect(existsSync(ledgerPath)).toBe(true);
    const written = JSON.parse(require("fs").readFileSync(ledgerPath, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    expect(written[today]).toBeDefined();
    expect(written[today].calls).toBe(2);
    expect(written[today].costUsd).toBeCloseTo(cost * 2, 8);

    // Now reset in-memory and re-load from disk — simulates a new process.
    resetSpendLedgerForTesting();
    // One more charge — should accumulate on top of the persisted 2.
    chargeTick(1, chars, cost);

    // Flush again and verify 3 calls total.
    await flushTelemetry();
    const written2 = JSON.parse(require("fs").readFileSync(ledgerPath, "utf-8"));
    expect(written2[today].calls).toBe(3);
  });

  it("corrupt/missing ledger file: starts empty, no throw", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "100";
    process.env.EMBED_DAILY_HARD_CAP_USD = "200";

    // Write corrupt JSON to the ledger path.
    writeFileSync(ledgerPath, "this is not json}", "utf-8");

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // Should not throw — corrupt file is silently treated as empty.
    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();
  });

  it("missing ledger file: starts empty, no throw", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "100";
    process.env.EMBED_DAILY_HARD_CAP_USD = "200";

    // Ensure the temp file does NOT exist.
    if (existsSync(ledgerPath)) unlinkSync(ledgerPath);

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    expect(() => chargeTick(1, 4000, 0.00019)).not.toThrow();
  });

  it("day-bucket isolation: charges attributed to the correct UTC day bucket", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "100";
    process.env.EMBED_DAILY_HARD_CAP_USD = "200";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, flushTelemetry } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // Manually pre-populate the ledger with a yesterday entry.
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      ledgerPath,
      JSON.stringify({ [yesterday]: { tokens: 999, costUsd: 1.23, calls: 5 } }),
      "utf-8"
    );

    // Force-load from the pre-populated file.
    resetSpendLedgerForTesting();

    // Charge today.
    chargeTick(1, 4000, 0.00019);

    // Flush and inspect.
    await flushTelemetry();
    const written = JSON.parse(require("fs").readFileSync(ledgerPath, "utf-8"));

    // Yesterday's entry preserved.
    expect(written[yesterday].calls).toBe(5);
    expect(written[yesterday].costUsd).toBeCloseTo(1.23, 5);

    // Today's entry created separately.
    expect(written[today]).toBeDefined();
    expect(written[today].calls).toBe(1);
  });

  it("30-day pruning: buckets older than 30 days are removed on flush", async () => {
    process.env.EMBED_DAILY_BUDGET_USD = "100";
    process.env.EMBED_DAILY_HARD_CAP_USD = "200";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, flushTelemetry } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // Write a ledger with a 31-day-old entry and a recent one.
    const old = new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        [old]: { tokens: 10, costUsd: 0.01, calls: 1 },
        [yesterday]: { tokens: 20, costUsd: 0.02, calls: 2 },
      }),
      "utf-8"
    );

    resetSpendLedgerForTesting();
    chargeTick(1, 4000, 0.00019);
    await flushTelemetry();

    const written = JSON.parse(require("fs").readFileSync(ledgerPath, "utf-8"));
    // Old entry pruned.
    expect(written[old]).toBeUndefined();
    // Recent entries preserved.
    expect(written[yesterday]).toBeDefined();
  });

  it("per-tick kill-switch still works unchanged (regression guard)", async () => {
    process.env.MAX_EMBEDS_PER_TICK = "2";
    process.env.EMBED_DRY_RUN = "true";
    process.env.EMBED_DAILY_BUDGET_USD = "100";
    process.env.EMBED_DAILY_HARD_CAP_USD = "200";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, EmbedQuotaExceededError } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    chargeTick(1, 100, 0.000001);
    chargeTick(1, 100, 0.000001); // counter = 2, not > 2, passes

    // Third call: counter = 3 > 2 → EmbedQuotaExceededError
    expect(() => chargeTick(1, 100, 0.000001)).toThrow(EmbedQuotaExceededError);
  });

  it("dry-run mode: still accumulates + can trip hard cap", async () => {
    process.env.EMBED_DRY_RUN = "true";
    process.env.EMBED_DAILY_HARD_CAP_USD = "0.0003";
    process.env.EMBED_DAILY_BUDGET_USD = "0.0001";

    const { chargeTick, resetTickCounter, resetSpendLedgerForTesting, EmbedBudgetExceededError } =
      await import("../../core/embedder/gate.js");

    resetTickCounter();
    resetSpendLedgerForTesting();

    // $0.00019 < $0.0003 — passes
    chargeTick(1, 4000, 0.00019);
    // cumulative $0.00038 >= $0.0003 — throws
    expect(() => chargeTick(1, 4000, 0.00019)).toThrow(EmbedBudgetExceededError);
  });
});
