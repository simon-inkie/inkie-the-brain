/**
 * the-brain Antigravity adapter — agy transcript.jsonl helpers.
 *
 * Transcript lines are AgyTranscriptStep objects (see types.ts), one JSON
 * object per line, written by agy under
 * ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { shouldSkipMessage } from "../../../core/observer/noise-filter.js";
import type { TranscriptMessage } from "../../../core/observer/types.js";
import type { AgyTranscriptStep } from "./types.js";

/**
 * Count the USER_INPUT steps in an agy transcript.
 *
 * Used as the per-turn cache key for PreInvocation injection: the count is
 * stable across the many model calls within one turn and increments when a
 * new user request lands. Cheap string scan, no per-line JSON parse.
 *
 * Returns null when the transcript cannot be read (missing path, perms) so
 * callers can fall back to uncached rendering.
 */
export function countUserTurns(transcriptPath: string): number | null {
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const matches = raw.match(/"type"\s*:\s*"USER_INPUT"/g);
    return matches ? matches.length : 0;
  } catch {
    return null;
  }
}

/**
 * Strip agy's prompt scaffolding from a USER_INPUT step. The user's actual
 * words arrive wrapped in <USER_REQUEST> tags alongside metadata blocks
 * (<ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>, ...) we don't want in
 * observations. Falls back to the raw content when the tag is absent.
 */
export function extractUserRequest(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\n?([\s\S]*?)<\/USER_REQUEST>/);
  return (match ? match[1] : raw).trim();
}

/**
 * Normalise one transcript step into the observer's TranscriptMessage
 * shape, or null when the step is not observable conversation content.
 * Observer parity with CC: user + assistant text only — tool steps
 * (VIEW_FILE, RUN_COMMAND, ...) and SYSTEM steps are skipped, matching
 * how the CC reader extracts only text blocks.
 */
export function normaliseStep(step: AgyTranscriptStep): TranscriptMessage | null {
  if (typeof step?.type !== "string") return null;

  let role: "user" | "assistant";
  let content: string;

  if (step.type === "USER_INPUT") {
    role = "user";
    content = extractUserRequest(step.content ?? "");
  } else if (step.type === "PLANNER_RESPONSE") {
    role = "assistant";
    content = (step.content ?? "").trim();
  } else {
    return null;
  }

  if (!content) return null;

  return {
    role,
    content,
    timestamp:
      typeof step.created_at === "string" && step.created_at
        ? step.created_at
        : new Date().toISOString(),
  };
}

export interface AgyTranscriptReadResult {
  messages: TranscriptMessage[];
  newOffset: number;
  /** Lines in the delta that failed to parse as JSON — caller logs a warn. */
  malformedLines: number;
}

/**
 * Read unobserved messages from an agy transcript.jsonl starting at the
 * given byte offset. Mirrors core/observer/transcript.ts
 * readTranscriptFromOffset (truncation reset, EOF offset return) with the
 * agy step normalisation on top. Malformed lines are counted and skipped,
 * never thrown.
 */
export function readAgyTranscriptFromOffset(
  transcriptPath: string,
  offset: number,
): AgyTranscriptReadResult {
  const messages: TranscriptMessage[] = [];
  let malformedLines = 0;

  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return { messages, newOffset: offset, malformedLines };
  }

  try {
    const fileSize = fstatSync(fd).size;

    // File was truncated or rotated — reset to start
    const readFrom = fileSize < offset ? 0 : offset;

    const bufSize = fileSize - readFrom;
    if (bufSize <= 0) {
      closeSync(fd);
      return { messages, newOffset: fileSize, malformedLines };
    }

    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, readFrom);
    closeSync(fd);

    for (const line of buf.toString("utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let step: AgyTranscriptStep;
      try {
        step = JSON.parse(trimmed);
      } catch {
        malformedLines++;
        continue;
      }

      const msg = normaliseStep(step);
      if (!msg) continue;
      if (shouldSkipMessage(msg.content)) continue;

      messages.push(msg);
    }

    return { messages, newOffset: fileSize, malformedLines };
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    console.error("[agy-observer] Error reading transcript:", err);
    return { messages, newOffset: offset, malformedLines };
  }
}
