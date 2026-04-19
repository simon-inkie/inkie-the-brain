/**
 * Memory block reader for The Brain context engine.
 *
 * Three modes controlled by `memoryBlockSource`:
 * - "memory-core": returns "" — OpenClaw's memory-core handles MEMORY.md injection. Safest.
 * - "file": reads the IO_LIVE section from MEMORY.md directly.
 * - "none": returns "" — no memory injection at all (debug mode).
 */

import { readFile } from "node:fs/promises";
import type { TheBrainConfig } from "./types.js";

const ANCHOR_START = "<!-- IO_LIVE_START -->";
const ANCHOR_END = "<!-- IO_LIVE_END -->";

/**
 * Extract the text between IO_LIVE_START and IO_LIVE_END anchors.
 * Returns the inner text (excluding the anchor lines themselves).
 * If anchors are missing, returns the full content as a fallback.
 */
function extractLiveBlock(content: string): string {
  const startIdx = content.indexOf(ANCHOR_START);
  const endIdx = content.indexOf(ANCHOR_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // Anchors missing — return full content as fallback
    return content;
  }

  // Skip past the anchor-start line (find the next newline after it)
  const blockStart = content.indexOf("\n", startIdx);
  if (blockStart === -1) return "";

  return content.slice(blockStart + 1, endIdx).trim();
}

/**
 * Truncate from the TOP of the block, keeping the newest content.
 * Prepends a marker showing how much was cut.
 */
function truncateFromTop(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const kept = text.slice(cut);
  return `[...truncated ${cut} chars from top]\n${kept}`;
}

/**
 * Read the injected memory block based on the configured source mode.
 * Never throws — I/O errors become empty string + optional console warning.
 */
export async function readInjectedMemoryBlock(
  cfg: Pick<TheBrainConfig, "memoryBlockSource" | "memoryFile" | "maxInjectedChars" | "debug">,
): Promise<string> {
  if (cfg.memoryBlockSource === "memory-core" || cfg.memoryBlockSource === "none") {
    return "";
  }

  // memoryBlockSource === "file"
  try {
    const raw = await readFile(cfg.memoryFile, "utf8");
    const block = extractLiveBlock(raw);
    return truncateFromTop(block, cfg.maxInjectedChars);
  } catch (err) {
    if (cfg.debug) {
      console.warn(
        `[the-brain] memory-reader: failed to read ${cfg.memoryFile}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return "";
  }
}
