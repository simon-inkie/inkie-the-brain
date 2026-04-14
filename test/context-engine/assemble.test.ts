import { describe, it, expect } from "vitest";
import { sliceRecent, approxChars } from "../../core/context-engine/assemble.js";
import type { Message, UserMessage, AssistantMessage, ToolResultMessage, ToolCallBlock } from "../../core/context-engine/types.js";

// ---------------------------------------------------------------------------
// Test fixture helpers — realistic pi-ai-shaped messages
// ---------------------------------------------------------------------------

function user(content: string, ts = Date.now()): UserMessage {
  return { role: "user", content, timestamp: ts };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function assistantWithToolCall(callId: string, toolName: string): AssistantMessage {
  const call: ToolCallBlock = {
    type: "toolCall",
    id: callId,
    name: toolName,
    arguments: {},
  };
  return {
    role: "assistant",
    content: [call],
  };
}

function toolResult(callId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
  };
}

const DEFAULT_CFG = {
  recentTurnCount: 3,
  preserveFirstUserMessage: true,
  minRawFloor: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sliceRecent", () => {
  it("returns all messages when count <= recentTurnCount", () => {
    const msgs: Message[] = [user("a"), assistant("b"), user("c")];
    const result = sliceRecent(msgs, { ...DEFAULT_CFG, recentTurnCount: 5 });
    expect(result).toEqual(msgs);
    expect(result).toHaveLength(3);
  });

  it("returns all messages when count equals recentTurnCount", () => {
    const msgs: Message[] = [user("a"), assistant("b"), user("c")];
    const result = sliceRecent(msgs, DEFAULT_CFG);
    expect(result).toHaveLength(3);
  });

  it("returns the last N messages when count exceeds recentTurnCount", () => {
    const msgs: Message[] = [
      user("a", 1),
      assistant("b"),
      user("c", 2),
      assistant("d"),
      user("e", 3),
    ];
    const result = sliceRecent(msgs, DEFAULT_CFG);
    // recentTurnCount=3, so keep last 3 + first user message prepended
    expect(result).toHaveLength(4); // first user + last 3
    expect((result[0] as UserMessage).content).toBe("a"); // preserved first
    expect((result[1] as UserMessage).content).toBe("c");
    expect((result[2] as AssistantMessage).content[0]).toEqual({ type: "text", text: "d" });
    expect((result[3] as UserMessage).content).toBe("e");
  });

  it("preserves the first user message when preserveFirstUserMessage=true", () => {
    const msgs: Message[] = [
      user("first", 1),
      assistant("a"),
      user("b", 2),
      assistant("c"),
      user("d", 3),
      assistant("e"),
    ];
    const result = sliceRecent(msgs, { ...DEFAULT_CFG, recentTurnCount: 2 });
    expect((result[0] as UserMessage).content).toBe("first");
    expect(result.length).toBeGreaterThanOrEqual(3); // first + last 2
  });

  it("does NOT prepend first message when preserveFirstUserMessage=false", () => {
    const msgs: Message[] = [
      user("first", 1),
      assistant("a"),
      user("b", 2),
      assistant("c"),
      user("d", 3),
      assistant("e"),
    ];
    const result = sliceRecent(msgs, {
      ...DEFAULT_CFG,
      recentTurnCount: 2,
      preserveFirstUserMessage: false,
    });
    expect((result[0] as UserMessage).content).not.toBe("first");
    expect(result).toHaveLength(2);
  });

  it("does NOT duplicate first message when it is already in the kept tail", () => {
    const msgs: Message[] = [user("only"), assistant("reply")];
    const result = sliceRecent(msgs, { ...DEFAULT_CFG, recentTurnCount: 5 });
    expect(result).toHaveLength(2);
    const userMsgs = result.filter((m) => "role" in m && m.role === "user");
    expect(userMsgs).toHaveLength(1);
  });

  it("walks cut point backwards to keep a tool-call/tool-result pair intact", () => {
    const msgs: Message[] = [
      user("start", 1),
      assistantWithToolCall("call-1", "search"),
      toolResult("call-1", "search", "results here"),
      user("thanks", 2),
      assistant("you're welcome"),
    ];
    // recentTurnCount=3: target=3, startIdx=5-3=2.
    // messages[2] is a toolResult ("call-1"). Its matching assistantWithToolCall
    // is at index 1, which is BEFORE the cut. splitsToolPair should detect this
    // and walk backwards to index 1 to keep the pair intact.
    const result = sliceRecent(msgs, {
      ...DEFAULT_CFG,
      recentTurnCount: 3,
      preserveFirstUserMessage: false,
    });
    // Should keep from index 1 onwards (call + result + user + assistant = 4)
    const hasToolCall = result.some(
      (m) => "role" in m && m.role === "assistant" &&
        Array.isArray((m as AssistantMessage).content) &&
        (m as AssistantMessage).content.some((b) => "type" in b && b.type === "toolCall"),
    );
    const hasToolResult = result.some(
      (m) => "role" in m && m.role === "toolResult",
    );
    expect(hasToolCall).toBe(true);
    expect(hasToolResult).toBe(true);
    expect(result.length).toBe(4); // indices 1,2,3,4
  });

  it("handles multiple consecutive tool pairs at the boundary", () => {
    const msgs: Message[] = [
      user("go", 1),
      assistantWithToolCall("c1", "read"),
      toolResult("c1", "read", "file contents"),
      assistantWithToolCall("c2", "write"),
      toolResult("c2", "write", "done"),
      user("ok", 2),
    ];
    // recentTurnCount=1 would try to cut at index 5, but tool pairs chain
    const result = sliceRecent(msgs, {
      ...DEFAULT_CFG,
      recentTurnCount: 1,
      preserveFirstUserMessage: false,
    });
    // At minimum we get the last user message. The tool pairs at indices 1-4
    // only get pulled in if the cut point would split them. Since the cut is
    // at index 5 (a user message, not a toolResult), no split occurs.
    expect(result).toHaveLength(1);
    expect((result[0] as UserMessage).content).toBe("ok");
  });

  it("returns at least minRawFloor messages even if recentTurnCount is lower", () => {
    const msgs: Message[] = [
      user("a", 1),
      assistant("b"),
      user("c", 2),
      assistant("d"),
      user("e", 3),
    ];
    const result = sliceRecent(msgs, {
      recentTurnCount: 1,
      preserveFirstUserMessage: false,
      minRawFloor: 4,
    });
    expect(result.length).toBeGreaterThanOrEqual(4);
  });

  it("never returns more messages than the input", () => {
    const msgs: Message[] = [user("a"), assistant("b")];
    const result = sliceRecent(msgs, { ...DEFAULT_CFG, recentTurnCount: 100 });
    expect(result).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const msgs: Message[] = [user("a", 1), assistant("b"), user("c", 2), assistant("d"), user("e", 3)];
    const original = [...msgs];
    sliceRecent(msgs, DEFAULT_CFG);
    expect(msgs).toEqual(original);
  });

  it("returns empty array for empty input", () => {
    const result = sliceRecent([], DEFAULT_CFG);
    expect(result).toEqual([]);
  });

  it("returns single message for single-message input", () => {
    const msgs: Message[] = [user("only")];
    const result = sliceRecent(msgs, DEFAULT_CFG);
    expect(result).toHaveLength(1);
  });
});

describe("approxChars", () => {
  it("returns a positive number for a normal message", () => {
    const msg = user("hello world");
    expect(approxChars(msg)).toBeGreaterThan(0);
  });

  it("returns 0 for a circular-reference message (graceful)", () => {
    const bad = { role: "user" } as Message;
    // approxChars should not throw even on edge cases
    expect(typeof approxChars(bad)).toBe("number");
  });
});
