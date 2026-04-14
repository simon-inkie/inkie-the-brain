import { copyFile, mkdir, writeFile } from "fs/promises";
import { join, extname } from "path";
import { homedir } from "os";

// --- Supported media types ---

const SUPPORTED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
};

// --- Brain dir resolution ---

function resolveBrainDir(): string {
  if (process.env.BRAIN_DIR) return process.env.BRAIN_DIR;
  const workspaceDir =
    process.env.WORKSPACE_DIR ??
    join(homedir(), ".openclaw", "workspace");
  return join(workspaceDir, "brain");
}

const BRAIN_DIR = resolveBrainDir();
const ASSETS_DIR = join(BRAIN_DIR, "assets");

// Ensure assets dir exists at module load
const dirReady = mkdir(ASSETS_DIR, { recursive: true }).catch((err) => {
  console.error("[io-media-filer] Failed to ensure assets dir:", err);
});

// --- Filename generation ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function generateFilename(
  mediaType: string,
  description: string | undefined
): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toISOString().slice(11, 16).replace(":", ""); // HHmm

  const ext = SUPPORTED_TYPES[mediaType] ?? (extname(mediaType) || ".bin");
  const typeSlug = mediaType.split("/")[1] ?? "file";

  const slug =
    description && description.length > 3
      ? slugify(description)
      : `${typeSlug}-${time}`;

  return `${date}-${slug}${ext}`;
}

// --- Sidecar content ---

function buildSidecar(
  channelId: string,
  from: string,
  mediaType: string,
  description: string | undefined
): string {
  const truncated = description
    ? description.slice(0, 200).replace(/"/g, '\\"')
    : "";
  const body =
    description || `Incoming ${mediaType.split("/")[0]} from ${channelId}`;

  return `---
origin:
  channel: ${channelId}
  timestamp: ${new Date().toISOString()}
  message: "${truncated}"
  sender: ${from}
---

${body}
`;
}

// --- Core filing ---

async function fileMedia(event: Record<string, unknown>): Promise<void> {
  try {
    await dirReady;

    const ctx = (event.context ?? {}) as Record<string, unknown>;
    const mediaPath = ctx.mediaPath as string | undefined;
    const mediaType = (ctx.mediaType ?? ctx.mimeType) as string | undefined;

    if (!mediaPath || !mediaType) return;
    if (!SUPPORTED_TYPES[mediaType]) {
      console.error(
        `[io-media-filer] Unsupported media type: ${mediaType}, skipping`
      );
      return;
    }

    const description = (ctx.bodyForAgent ?? ctx.caption ?? ctx.body) as
      | string
      | undefined;
    const channelId = (ctx.channelId ?? ctx.channel ?? "unknown") as string;
    const from = (ctx.from ?? ctx.sender ?? "unknown") as string;

    const filename = generateFilename(mediaType, description);
    const destPath = join(ASSETS_DIR, filename);
    const sidecarPath = `${destPath}.md`;

    await copyFile(mediaPath, destPath);
    await writeFile(sidecarPath, buildSidecar(channelId, from, mediaType, description));

    console.error(
      `[io-media-filer] Filed ${mediaType} as ${filename} from ${channelId}`
    );
  } catch (err) {
    console.error("[io-media-filer] Error filing media:", err);
  }
}

// --- Hook handler (default export) ---

export default function handler(event: Record<string, unknown>): void {
  try {
    const type = event.type as string | undefined;
    const action = event.action as string | undefined;

    if (type === "message" && action === "preprocessed") {
      const ctx = (event.context ?? {}) as Record<string, unknown>;
      if (ctx.mediaPath) {
        void fileMedia(event);
      }
    }
  } catch (err) {
    console.error("[io-media-filer] Handler error:", err);
  }
}
