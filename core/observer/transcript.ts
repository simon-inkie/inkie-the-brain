import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { shouldSkipMessage } from "./noise-filter.js";
import type { Pointer, TranscriptMessage } from "./types.js";

export function sanitiseSessionKey(key: string): string {
  return key.replace(/[/:]/g, "-");
}

export function pointerPath(pointersDir: string, sessionKey: string): string {
  return join(pointersDir, `${sanitiseSessionKey(sessionKey)}.json`);
}

export function loadPointer(
  pointersDir: string,
  sessionKey: string,
): Pointer | null {
  try {
    const path = pointerPath(pointersDir, sessionKey);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // corrupt file — will be recreated
  }
  return null;
}

export function savePointer(pointersDir: string, pointer: Pointer): void {
  try {
    mkdirSync(pointersDir, { recursive: true });
    const path = pointerPath(pointersDir, pointer.sessionKey);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pointer, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    console.error("[observer] Failed to persist pointer:", err);
  }
}

/**
 * Read unobserved messages from the transcript JSONL starting at the given
 * byte offset. Returns the messages and the new offset (EOF position).
 */
export function readTranscriptFromOffset(
  transcriptPath: string,
  offset: number,
): { messages: TranscriptMessage[]; newOffset: number } {
  const messages: TranscriptMessage[] = [];

  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return { messages, newOffset: offset };
  }

  try {
    const fileSize = fstatSync(fd).size;

    // File was truncated or rotated — reset to start
    const readFrom = fileSize < offset ? 0 : offset;

    const bufSize = fileSize - readFrom;
    if (bufSize <= 0) {
      closeSync(fd);
      return { messages, newOffset: fileSize };
    }

    const buf = Buffer.alloc(bufSize);
    readSync(fd, buf, 0, bufSize, readFrom);
    closeSync(fd);

    const lines = buf.toString("utf-8").split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Accept both OpenClaw ({type:"message"}) and Claude Code
      // ({type:"user"|"assistant"}) transcript shapes. The inner
      // message.role is what we ultimately gate on.
      const topType = parsed.type;
      if (
        topType !== "message" &&
        topType !== "user" &&
        topType !== "assistant"
      )
        continue;

      const msg = parsed.message as
        | { role?: string; content?: unknown; timestamp?: number }
        | undefined;
      if (!msg?.role) continue;

      // Only observe user and assistant messages
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      // Extract text content
      let content: string;
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Content blocks — extract text parts
        content = (msg.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("\n");
      } else {
        continue;
      }

      if (!content.trim() || shouldSkipMessage(content.trim())) continue;

      messages.push({
        role: msg.role,
        content: content.trim(),
        timestamp:
          (parsed.timestamp as string) ??
          new Date(msg.timestamp ?? Date.now()).toISOString(),
      });
    }

    return { messages, newOffset: fileSize };
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    console.error("[observer] Error reading transcript:", err);
    return { messages, newOffset: offset };
  }
}
