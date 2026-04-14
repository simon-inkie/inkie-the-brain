/**
 * GreymatterEngine — OpenClaw context engine that bounds per-turn
 * message history via intelligent slicing.
 *
 * Implements a shape-compatible ContextEngine contract using locally-defined
 * types (see types.ts). OpenClaw duck-types the engine at runtime.
 */

import { sliceRecent, approxChars } from "./assemble.js";
import { readInjectedMemoryBlock } from "./memory-reader.js";
import type {
  Message,
  GreymatterConfig,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";

export class GreymatterEngine {
  readonly info: ContextEngineInfo = {
    id: "greymatter",
    name: "Greymatter",
    version: "0.1.0",
    ownsCompaction: true,
  };

  constructor(private readonly cfg: GreymatterConfig) {}

  /**
   * No-op. Io's own hooks (io-observer, io-message-indexer) handle message
   * persistence into Qdrant and observation files. We are read-only here.
   */
  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: Message;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  /**
   * Assemble model context: slice to the last N messages, optionally
   * inject a memory block from MEMORY.md's IO_LIVE section.
   */
  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: Message[];
    tokenBudget?: number;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult> {
    const { messages } = params;
    const sliced = sliceRecent(messages, this.cfg);
    const memoryBlock = await readInjectedMemoryBlock(this.cfg);

    const totalChars =
      memoryBlock.length +
      sliced.reduce((n, m) => n + approxChars(m), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);

    if (this.cfg.debug) {
      console.log(
        `[greymatter] kept=${sliced.length}/${messages.length} ` +
          `memChars=${memoryBlock.length} estTok=${estimatedTokens}`,
      );
    }

    return {
      messages: sliced,
      estimatedTokens,
      systemPromptAddition: memoryBlock || undefined,
    };
  }

  /**
   * No-op. Greymatter owns compaction via per-turn slicing — there is no
   * separate compaction pass.
   */
  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: "greymatter owns compaction via per-turn slicing",
    };
  }

  /**
   * Optional post-turn lifecycle hook. No-op in v1.
   */
  async afterTurn(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: Message[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
  }): Promise<void> {}

  async dispose(): Promise<void> {}
}
