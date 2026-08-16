/**
 * media-filer.ts
 *
 * Watches ~/.openclaw/media/inbound/ for new files.
 * When a file lands, reads the most recent user message from the active
 * session JSONL to get caption context, then copies to brain/assets/ with
 * a .md sidecar. The existing watcher/asset-indexer picks it up from there.
 */

import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { extname, join, basename } from "path";
import { homedir } from "os";
import { watch } from "chokidar";
import { config } from "../config.js";

const INBOUND_DIR = join(homedir(), ".openclaw", "media", "inbound");
const SESSIONS_DIR = join(homedir(), ".openclaw", "agents", "main", "sessions");
const ASSETS_DIR = join(config.workspaceRoot, "brain", "assets");

// How long to wait for the session JSONL to catch up after the file lands
const SESSION_READ_DELAY_MS = 3000;

// --- Helpers ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function generateFilename(description: string | undefined, ext: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16).replace(":", "");
  const slug =
    description && description.length > 3
      ? slugify(description)
      : `image-${time}`;
  return `${date}-${slug}${ext}`;
}

function buildSidecar(
  caption: string | undefined,
  channel: string,
  sender: string
): string {
  const description = caption
    ? caption.replace(/^.*?\]\s*/, "").slice(0, 200) // strip "[Mon 2026-03-29 10:18 GMT+1] "
    : `Incoming media from ${channel}`;
  const truncated = description.replace(/"/g, '\\"').slice(0, 200);

  return `---
origin:
  channel: ${channel}
  timestamp: ${new Date().toISOString()}
  message: "${truncated}"
  sender: ${sender}
---

${description}
`;
}

// --- Session context ---

interface SessionMessage {
  type: string;
  timestamp: string;
  message: {
    role: string;
    content: unknown;
    timestamp?: number;
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block
      ) {
        return String(block.text);
      }
    }
  }
  return "";
}

async function getMostRecentSessionFile(): Promise<string | null> {
  try {
    const entries = await readdir(SESSIONS_DIR);
    const jsonl = entries.filter((e) => e.endsWith(".jsonl"));
    if (!jsonl.length) return null;

    let newest: { path: string; mtimeMs: number } | null = null;
    for (const entry of jsonl) {
      const fullPath = join(SESSIONS_DIR, entry);
      const s = await stat(fullPath);
      if (!newest || s.mtimeMs > newest.mtimeMs) {
        newest = { path: fullPath, mtimeMs: s.mtimeMs };
      }
    }
    return newest?.path ?? null;
  } catch {
    return null;
  }
}

async function getLastUserMessage(since: number): Promise<{ text: string | undefined; channel: string; sender: string } | null> {
  const sessionFile = await getMostRecentSessionFile();
  if (!sessionFile) return null;

  try {
    const raw = await readFile(sessionFile, "utf-8");
    const lines = raw.split("\n").filter(Boolean);

    // Walk backwards to find last user message within last 30s
    const cutoff = since - 30_000;
    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: SessionMessage;
      try {
        parsed = JSON.parse(lines[i]) as SessionMessage;
      } catch {
        continue;
      }
      if (parsed.type !== "message") continue;
      if (parsed.message?.role !== "user") continue;

      const msgTs = parsed.message.timestamp
        ? parsed.message.timestamp
        : new Date(parsed.timestamp).getTime();
      if (msgTs < cutoff) break; // too old

      const text = extractText(parsed.message.content);
      if (!text.trim()) continue;

        // Extract channel from metadata block if present
      const channelMatch = text.match(/"channel":\s*"([^"]+)"|"provider":\s*"([^"]+)"/);
      const channel = channelMatch?.[1] ?? channelMatch?.[2] ?? "webchat";

      const senderMatch = text.match(/"name":\s*"([^"]+)"|"id":\s*"([^"]+)"/);
      const sender = senderMatch?.[1] ?? senderMatch?.[2] ?? "unknown";

      // Extract the human-readable caption — text after the last timestamp marker
      // Handles: "[Sun 2026-03-29 10:41 GMT+1] here the image"
      // Also handles WhatsApp: "[WhatsApp ... (self)]: <media:document>" — skip those
      const captionMatch = text.match(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\]]+\]\s*(.+)/s);
      let caption = captionMatch?.[1]?.trim();

      // Skip if caption is just a media placeholder
      if (!caption || /^<media:|^\(self\)|^<file /.test(caption)) {
        caption = undefined;
      } else {
        caption = caption.slice(0, 120);
      }

      return { text: caption, channel, sender };
    }
  } catch {
    return null;
  }

  return null;
}

// --- Core filing ---

const inFlight = new Set<string>();

async function fileInboundMedia(filePath: string): Promise<void> {
  if (inFlight.has(filePath)) return;
  inFlight.add(filePath);

  try {
    await mkdir(ASSETS_DIR, { recursive: true });

    // Wait briefly for session JSONL to catch up
    await new Promise((r) => setTimeout(r, SESSION_READ_DELAY_MS));

    const context = await getLastUserMessage(Date.now());

    const ext = extname(filePath) || ".png";
    const filename = generateFilename(context?.text, ext);
    const destPath = join(ASSETS_DIR, filename);
    const sidecarPath = `${destPath}.md`;

    await copyFile(filePath, destPath);
    await writeFile(
      sidecarPath,
      buildSidecar(context?.text, context?.channel ?? "webchat", context?.sender ?? "unknown")
    );

    console.log(`[media-filer] Filed ${basename(filePath)} → ${filename}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[media-filer] Error filing ${basename(filePath)}: ${msg}`);
  } finally {
    inFlight.delete(filePath);
  }
}

// --- Watcher ---

const SUPPORTED_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".pdf",
  ".ogg", ".mp3", ".wav", ".m4a",
]);

export function startMediaFilerWatcher(log: (msg: string) => void): void {
  log(`[media-filer] Watching ${INBOUND_DIR} for new inbound media`);

  const watcher = watch(INBOUND_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on("add", (filePath: string) => {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      log(`[media-filer] Skipping unsupported type: ${basename(filePath)}`);
      return;
    }
    log(`[media-filer] New inbound media: ${basename(filePath)}`);
    void fileInboundMedia(filePath);
  });

  watcher.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[media-filer] Watcher error: ${msg}`);
  });
}
