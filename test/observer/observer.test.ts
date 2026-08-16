import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateShouldObserve,
  shouldSkipMessage,
  readTranscriptFromOffset,
  sanitiseSessionKey,
  MIN_OBSERVATION_GAP_MS,
  DEFAULT_OBSERVATION_MAX_AGE_MS,
  type ObserverState,
} from "../../core/observer/index.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_775_928_000_000; // arbitrary reference point

function coolState(overrides: Partial<ObserverState> = {}): ObserverState {
  return {
    lastObservationAt: new Date(
      NOW - MIN_OBSERVATION_GAP_MS - 1000,
    ).toISOString(),
    observationMessageThreshold: 8,
    observationCharThreshold: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sanitiseSessionKey
// ---------------------------------------------------------------------------

describe("sanitiseSessionKey", () => {
  it("replaces colons and slashes with dashes", () => {
    expect(sanitiseSessionKey("agent:main:main")).toBe("agent-main-main");
    expect(sanitiseSessionKey("agent:main:whatsapp:group:447763")).toBe(
      "agent-main-whatsapp-group-447763",
    );
  });

  it("handles keys without special characters", () => {
    expect(sanitiseSessionKey("simple")).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// shouldSkipMessage
// ---------------------------------------------------------------------------

describe("shouldSkipMessage", () => {
  it("skips short messages", () => {
    expect(shouldSkipMessage("short")).toBe(true);
    expect(shouldSkipMessage("a".repeat(19))).toBe(true);
  });

  it("keeps messages at or above minimum length", () => {
    expect(shouldSkipMessage("a".repeat(20))).toBe(false);
  });

  it("skips HEARTBEAT_OK", () => {
    expect(shouldSkipMessage("HEARTBEAT_OK")).toBe(true);
  });

  it("skips NO_REPLY", () => {
    expect(shouldSkipMessage("NO_REPLY")).toBe(true);
  });

  it("skips cron prefixed", () => {
    expect(
      shouldSkipMessage("[cron: projects-sync] running scheduled task"),
    ).toBe(true);
  });

  it("skips System: prefixed", () => {
    expect(shouldSkipMessage("System: [heartbeat] fired at 14:00")).toBe(true);
  });

  it("keeps substantive messages", () => {
    expect(
      shouldSkipMessage("The user asked about the context engine plugin"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateShouldObserve — blocking conditions
// ---------------------------------------------------------------------------

describe("evaluateShouldObserve — blocking", () => {
  it("does not fire when in flight", () => {
    const result = evaluateShouldObserve({
      messageCount: 100,
      charCount: 50000,
      oldestUnobservedTimestamp: NOW - 999999,
      state: coolState(),
      now: NOW,
      observationInFlight: true,
    });
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toMatch(/in flight/i);
  });

  it("does not fire within cooldown", () => {
    const result = evaluateShouldObserve({
      messageCount: 100,
      charCount: 50000,
      oldestUnobservedTimestamp: NOW - 999999,
      state: coolState({
        lastObservationAt: new Date(NOW - 60_000).toISOString(),
      }),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toMatch(/cooldown/i);
  });

  it("does not fire with zero messages", () => {
    const result = evaluateShouldObserve({
      messageCount: 0,
      charCount: 0,
      oldestUnobservedTimestamp: null,
      state: coolState(),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toMatch(/no messages/i);
  });

  it("treats missing lastObservationAt as no prior observation", () => {
    const result = evaluateShouldObserve({
      messageCount: 10,
      charCount: 3000,
      oldestUnobservedTimestamp: NOW - 60000,
      state: { observationMessageThreshold: 8 },
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateShouldObserve — OR-logic triggers
// ---------------------------------------------------------------------------

describe("evaluateShouldObserve — OR-logic", () => {
  it("fires on message count alone", () => {
    const result = evaluateShouldObserve({
      messageCount: 10,
      charCount: 500, // below 2000 threshold
      oldestUnobservedTimestamp: NOW - 60000,
      state: coolState(),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
    expect(result.reason).toMatch(/msgs=10\/8/);
  });

  it("fires on char count alone", () => {
    const result = evaluateShouldObserve({
      messageCount: 3, // below 8 threshold
      charCount: 5000,
      oldestUnobservedTimestamp: NOW - 60000,
      state: coolState(),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
    expect(result.reason).toMatch(/chars=5000\/2000/);
  });

  it("REGRESSION: the stuck-buffer scenario fires under OR logic", () => {
    // 56 messages, 16k chars, char threshold 30k — old AND logic would stall
    const result = evaluateShouldObserve({
      messageCount: 56,
      charCount: 16305,
      oldestUnobservedTimestamp: NOW - 2 * 24 * 60 * 60 * 1000,
      state: coolState({
        observationMessageThreshold: 8,
        observationCharThreshold: 30000,
      }),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
    expect(result.reason).toMatch(/msgs=56\/8/);
  });

  it("does not fire when all below threshold", () => {
    const result = evaluateShouldObserve({
      messageCount: 3,
      charCount: 300,
      oldestUnobservedTimestamp: NOW - 60000,
      state: coolState(),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toMatch(/below thresholds/);
  });

  it("reports multiple triggers with OR", () => {
    const result = evaluateShouldObserve({
      messageCount: 20,
      charCount: 4000,
      oldestUnobservedTimestamp: NOW - 60000,
      state: coolState(),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
    expect(result.reason).toMatch(/OR/);
  });
});

// ---------------------------------------------------------------------------
// evaluateShouldObserve — age fallback
// ---------------------------------------------------------------------------

describe("evaluateShouldObserve — age fallback", () => {
  it("fires when oldest message exceeds max age", () => {
    const result = evaluateShouldObserve({
      messageCount: 3, // below threshold
      charCount: 300, // below threshold
      oldestUnobservedTimestamp: NOW - 5 * 60 * 60 * 1000, // 5h old
      state: coolState({
        observationMessageThreshold: 20,
        observationCharThreshold: 10000,
      }),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
    expect(result.reason).toMatch(/age=300m\/240m/);
  });

  it("does not fire when within max age and thresholds not met", () => {
    const result = evaluateShouldObserve({
      messageCount: 1,
      charCount: 100,
      oldestUnobservedTimestamp: NOW - 30 * 60 * 1000, // 30 min
      state: coolState({
        observationMessageThreshold: 20,
        observationCharThreshold: 10000,
      }),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(false);
  });

  it("respects custom observationMaxAgeMs", () => {
    const result = evaluateShouldObserve({
      messageCount: 1,
      charCount: 100,
      oldestUnobservedTimestamp: NOW - 60 * 60 * 1000, // 1h old
      state: coolState({
        observationMessageThreshold: 20,
        observationCharThreshold: 10000,
        observationMaxAgeMs: 30 * 60 * 1000, // 30 min max
      }),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(true);
    expect(result.reason).toMatch(/age=60m\/30m/);
  });

  it("handles null oldest timestamp gracefully", () => {
    const result = evaluateShouldObserve({
      messageCount: 1,
      charCount: 100,
      oldestUnobservedTimestamp: null,
      state: coolState({
        observationMessageThreshold: 20,
        observationCharThreshold: 10000,
      }),
      now: NOW,
      observationInFlight: false,
    });
    expect(result.shouldFire).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readTranscriptFromOffset
// ---------------------------------------------------------------------------

describe("readTranscriptFromOffset", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `io-observer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeTranscript(lines: object[]): string {
    const path = join(testDir, "transcript.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  it("reads user and assistant messages from a transcript", () => {
    const path = writeTranscript([
      {
        type: "session",
        version: 3,
        id: "test",
        timestamp: "2026-04-12T10:00:00Z",
      },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: {
          role: "user",
          content: "Hello, this is a substantive message for testing",
        },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-04-12T10:02:00Z",
        message: {
          role: "assistant",
          content: "Hi there, this is a reply with enough content",
        },
      },
    ]);

    const { messages, newOffset } = readTranscriptFromOffset(path, 0);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("substantive message");
    expect(messages[1].role).toBe("assistant");
    expect(newOffset).toBeGreaterThan(0);
  });

  it("filters out non-message lines", () => {
    const path = writeTranscript([
      {
        type: "session",
        version: 3,
        id: "test",
        timestamp: "2026-04-12T10:00:00Z",
      },
      {
        type: "model_change",
        id: "mc1",
        provider: "google",
        modelId: "gemini-3-flash",
      },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: {
          role: "user",
          content: "This is the only real message in the transcript",
        },
      },
      {
        type: "thinking_level_change",
        id: "tc1",
        thinkingLevel: "low",
      },
    ]);

    const { messages } = readTranscriptFromOffset(path, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("only real message");
  });

  it("filters out toolResult messages", () => {
    const path = writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: {
          role: "user",
          content: "Run the command to check the system status",
        },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-04-12T10:02:00Z",
        message: { role: "toolResult", content: "exit code 0" },
      },
      {
        type: "message",
        id: "m3",
        timestamp: "2026-04-12T10:03:00Z",
        message: {
          role: "assistant",
          content: "The command succeeded, here is the output result",
        },
      },
    ]);

    const { messages } = readTranscriptFromOffset(path, 0);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role !== "toolResult")).toBe(true);
  });

  it("applies noise filtering", () => {
    const path = writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: { role: "assistant", content: "HEARTBEAT_OK" },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-04-12T10:02:00Z",
        message: { role: "assistant", content: "NO_REPLY" },
      },
      {
        type: "message",
        id: "m3",
        timestamp: "2026-04-12T10:03:00Z",
        message: {
          role: "user",
          content: "This is a real message that should be kept",
        },
      },
    ]);

    const { messages } = readTranscriptFromOffset(path, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("real message");
  });

  it("reads from a byte offset (skipping already-observed content)", () => {
    const lines = [
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: {
          role: "user",
          content: "This is the first message, already observed previously",
        },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-04-12T10:02:00Z",
        message: {
          role: "user",
          content: "This is the second message, should be newly observed",
        },
      },
    ];
    const path = writeTranscript(lines);

    // Get the offset after the first line
    const firstLineBytes =
      Buffer.byteLength(JSON.stringify(lines[0])) + 1; // +1 for \n

    const { messages } = readTranscriptFromOffset(path, firstLineBytes);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("second message");
  });

  it("handles missing transcript file gracefully", () => {
    const { messages, newOffset } = readTranscriptFromOffset(
      "/nonexistent/path.jsonl",
      0,
    );
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(0);
  });

  it("handles truncated file (offset past EOF) by resetting to start", () => {
    const path = writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: {
          role: "user",
          content: "This message exists in the new shorter file",
        },
      },
    ]);

    // Offset past the file size — simulates a file truncation/rotation
    const { messages } = readTranscriptFromOffset(path, 999999);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("new shorter file");
  });

  it("handles content block arrays", () => {
    const path = writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-04-12T10:01:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Here is the first part of the response" },
            { type: "text", text: "And here is the second part continuing" },
          ],
        },
      },
    ]);

    const { messages } = readTranscriptFromOffset(path, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("first part");
    expect(messages[0].content).toContain("second part");
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("MIN_OBSERVATION_GAP_MS is 25 minutes", () => {
    expect(MIN_OBSERVATION_GAP_MS).toBe(25 * 60 * 1000);
  });

  it("DEFAULT_OBSERVATION_MAX_AGE_MS is 4 hours", () => {
    expect(DEFAULT_OBSERVATION_MAX_AGE_MS).toBe(4 * 60 * 60 * 1000);
  });
});
