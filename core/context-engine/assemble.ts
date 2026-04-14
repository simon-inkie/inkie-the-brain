/**
 * Pure slicing function for the greymatter context engine.
 *
 * Takes a full message array and returns a bounded tail that:
 * 1. Keeps the last `recentTurnCount` messages verbatim.
 * 2. Optionally preserves the very first user message.
 * 3. Never splits a tool-call / tool-result pair at the cut boundary.
 * 4. Respects `minRawFloor` as a minimum message count.
 *
 * No I/O, no side effects, fully unit-testable.
 */

import type { Message, GreymatterConfig } from "./types.js";

/**
 * Check whether cutting at `idx` would split a tool-result from its
 * matching tool-call. A ToolResultMessage at `idx` has a `toolCallId`
 * that should match a ToolCall block in an earlier AssistantMessage.
 *
 * If the message at `idx` is a toolResult, the matching assistant message
 * (containing the ToolCall with the same id) must also be in the kept
 * window (i.e., at an index >= idx). If it's not, we need to walk the
 * cut point backwards.
 */
function splitsToolPair(messages: readonly Message[], idx: number): boolean {
  const msg = messages[idx];
  if (!msg || !("role" in msg)) return false;

  // If the message at the cut boundary is a tool result, check that
  // its matching tool call is also in the kept window.
  if (msg.role === "toolResult") {
    const toolCallId = (msg as { toolCallId?: string }).toolCallId;
    if (!toolCallId) return false;

    // Walk backwards from idx-1 to find the assistant message that
    // contains the matching tool call. If found before idx, the pair
    // is split.
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (!candidate || !("role" in candidate)) continue;
      if (candidate.role === "assistant") {
        const content = (candidate as { content?: unknown[] }).content;
        if (Array.isArray(content)) {
          const hasMatchingCall = content.some(
            (block: unknown) =>
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              (block as { type: string }).type === "toolCall" &&
              "id" in block &&
              (block as { id: string }).id === toolCallId,
          );
          if (hasMatchingCall) return true; // found it before the cut — pair is split
        }
        // This assistant message didn't have the matching call.
        // Keep searching backwards (multiple assistant messages can exist).
        continue;
      }
    }
  }

  return false;
}

/**
 * Slice messages to at most `recentTurnCount`, preserving:
 * - The first user message (if `preserveFirstUserMessage` is true)
 * - Tool-call / tool-result pair integrity
 * - At least `minRawFloor` messages
 *
 * Does not mutate the input array.
 */
export function sliceRecent(
  messages: readonly Message[],
  cfg: Pick<GreymatterConfig, "recentTurnCount" | "preserveFirstUserMessage" | "minRawFloor">,
): Message[] {
  const target = Math.max(cfg.recentTurnCount, cfg.minRawFloor);

  if (messages.length <= target) {
    return [...messages];
  }

  let startIdx = messages.length - target;

  // Walk backwards while the boundary would split a tool-call / tool-result pair.
  // Safety bound: don't walk past index 0.
  while (startIdx > 0 && splitsToolPair(messages, startIdx)) {
    startIdx--;
  }

  const tail = messages.slice(startIdx) as Message[];

  if (cfg.preserveFirstUserMessage && messages.length > 0) {
    const first = messages[0];
    if (
      first &&
      "role" in first &&
      first.role === "user" &&
      startIdx > 0 // first message isn't already in the tail
    ) {
      return [first, ...tail];
    }
  }

  return [...tail];
}

/**
 * Rough character count of a message for token estimation.
 * Uses JSON.stringify as a portable approximation — not exact,
 * but honest enough for `estimatedTokens ≈ totalChars / 4`.
 */
export function approxChars(msg: Message): number {
  try {
    return JSON.stringify(msg).length;
  } catch {
    return 0;
  }
}
