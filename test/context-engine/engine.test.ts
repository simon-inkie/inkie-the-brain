import { describe, it, expect } from "vitest";
import { GreymatterEngine } from "../../core/context-engine/engine.js";
import { DEFAULT_CONFIG } from "../../core/context-engine/config.js";
import type { Message, UserMessage, AssistantMessage, GreymatterConfig } from "../../core/context-engine/types.js";

function user(content: string, ts = Date.now()): UserMessage {
  return { role: "user", content, timestamp: ts };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function makeEngine(overrides: Partial<GreymatterConfig> = {}): GreymatterEngine {
  return new GreymatterEngine({ ...DEFAULT_CONFIG, ...overrides });
}

describe("GreymatterEngine.info", () => {
  it("has correct id, name, version, and ownsCompaction", () => {
    const engine = makeEngine();
    expect(engine.info.id).toBe("greymatter");
    expect(engine.info.name).toBe("Greymatter");
    expect(engine.info.version).toBe("0.1.0");
    expect(engine.info.ownsCompaction).toBe(true);
  });
});

describe("GreymatterEngine.ingest", () => {
  it("returns { ingested: true } (no-op)", async () => {
    const engine = makeEngine();
    const result = await engine.ingest({
      sessionId: "test-session",
      message: user("hello"),
    });
    expect(result).toEqual({ ingested: true });
  });
});

describe("GreymatterEngine.compact", () => {
  it("returns graceful no-op with reason", async () => {
    const engine = makeEngine();
    const result = await engine.compact({
      sessionId: "test-session",
      sessionFile: "/tmp/test.jsonl",
    });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("greymatter");
  });
});

describe("GreymatterEngine.dispose", () => {
  it("resolves without error", async () => {
    const engine = makeEngine();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

describe("GreymatterEngine.afterTurn", () => {
  it("resolves without error", async () => {
    const engine = makeEngine();
    await expect(
      engine.afterTurn({
        sessionId: "test",
        sessionFile: "/tmp/test.jsonl",
        messages: [],
        prePromptMessageCount: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("GreymatterEngine.assemble", () => {
  it("slices messages and returns AssembleResult shape", async () => {
    const engine = makeEngine({ recentTurnCount: 2, preserveFirstUserMessage: false });
    const messages: Message[] = [
      user("a", 1),
      assistant("b"),
      user("c", 2),
      assistant("d"),
      user("e", 3),
    ];

    const result = await engine.assemble({
      sessionId: "test",
      messages,
    });

    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeLessThanOrEqual(messages.length);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(typeof result.estimatedTokens).toBe("number");
  });

  it("returns all messages when under recentTurnCount", async () => {
    const engine = makeEngine({ recentTurnCount: 20 });
    const messages: Message[] = [user("a"), assistant("b"), user("c")];

    const result = await engine.assemble({
      sessionId: "test",
      messages,
    });

    expect(result.messages).toHaveLength(3);
  });

  it("slices to recentTurnCount when messages exceed it", async () => {
    const engine = makeEngine({
      recentTurnCount: 2,
      preserveFirstUserMessage: false,
      minRawFloor: 1,
    });
    const messages: Message[] = [
      user("a", 1),
      assistant("b"),
      user("c", 2),
      assistant("d"),
      user("e", 3),
    ];

    const result = await engine.assemble({ sessionId: "test", messages });
    expect(result.messages).toHaveLength(2);
  });

  it("preserves first user message when configured", async () => {
    const engine = makeEngine({
      recentTurnCount: 2,
      preserveFirstUserMessage: true,
      minRawFloor: 1,
    });
    const messages: Message[] = [
      user("first", 1),
      assistant("a"),
      user("b", 2),
      assistant("c"),
      user("d", 3),
      assistant("e"),
    ];

    const result = await engine.assemble({ sessionId: "test", messages });
    expect((result.messages[0] as UserMessage).content).toBe("first");
  });

  it("returns empty systemPromptAddition in memory-core mode", async () => {
    const engine = makeEngine({ memoryBlockSource: "memory-core" });
    const result = await engine.assemble({
      sessionId: "test",
      messages: [user("hello")],
    });
    // memory-core mode returns "" from readInjectedMemoryBlock,
    // which becomes undefined in the result
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("computes estimatedTokens as roughly chars/4", async () => {
    const engine = makeEngine({ recentTurnCount: 100 });
    const messages: Message[] = [user("x".repeat(400))];

    const result = await engine.assemble({ sessionId: "test", messages });
    // JSON.stringify of the message + overhead, divided by 4
    // Should be in the right ballpark (100+ tokens for 400 chars of content)
    expect(result.estimatedTokens).toBeGreaterThan(50);
    expect(result.estimatedTokens).toBeLessThan(500);
  });
});
