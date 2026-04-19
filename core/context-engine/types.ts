/**
 * Local types for the the-brain context engine.
 *
 * We define locally-compatible types for the OpenClaw ContextEngine contract
 * rather than importing from internal SDK paths (which aren't in the package
 * exports map and could break on minor version bumps). The contract is
 * duck-typed: as long as our shapes match, OpenClaw accepts them at runtime.
 *
 * Canonical sources (for reference, not for import):
 *   - ContextEngine: openclaw/dist/plugin-sdk/src/context-engine/types.d.ts
 *   - AgentMessage: @mariozechner/pi-agent-core → @mariozechner/pi-ai types.d.ts
 */

// ---------------------------------------------------------------------------
// The Brain config
// ---------------------------------------------------------------------------

export interface TheBrainConfig {
  /** How many most-recent messages to keep verbatim. Default 20. */
  recentTurnCount: number;

  /** Always keep the very first user message. Default true. */
  preserveFirstUserMessage: boolean;

  /** Never prune below this many messages. Default 4. */
  minRawFloor: number;

  /** Max chars of injected memory block. Default 40000. Soft cap — newest wins. */
  maxInjectedChars: number;

  /**
   * How to source the injected memory block.
   * - "memory-core" (default): don't inject, rely on OpenClaw's memory-core.
   * - "file": read MEMORY.md's IO_LIVE section directly and inject.
   * - "none": don't inject at all.
   */
  memoryBlockSource: "memory-core" | "file" | "none";

  /** Path to memory root dir. Used only when memoryBlockSource === "file". */
  memoryRoot: string;

  /** Path to MEMORY.md. Used only when memoryBlockSource === "file". */
  memoryFile: string;

  /** Emit per-turn debug log line with stats. Default false. */
  debug: boolean;
}

// ---------------------------------------------------------------------------
// Locally-compatible mirror of pi-ai / pi-agent-core message types
// ---------------------------------------------------------------------------

/** A tool call block inside an AssistantMessage's content array. */
export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A text content block. */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/** Content blocks that can appear in an AssistantMessage. */
export type AssistantContentBlock = TextContentBlock | ToolCallBlock | { type: string; [key: string]: unknown };

export interface UserMessage {
  role: "user";
  content: string | unknown[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  [key: string]: unknown;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown[];
  isError: boolean;
  [key: string]: unknown;
}

/**
 * A message in the conversation. Mirrors the pi-ai Message union.
 * We also accept custom agent messages (which have arbitrary `role` values)
 * since AgentMessage = Message | CustomAgentMessages[...].
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage | { role: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Locally-compatible mirror of ContextEngine types
// ---------------------------------------------------------------------------

export interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
}

export interface AssembleResult {
  messages: Message[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
}

export interface IngestResult {
  ingested: boolean;
}
