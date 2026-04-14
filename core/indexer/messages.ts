import { readFile, writeFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { createHash } from "crypto";
import { config } from "../config.js";
import { embedTexts } from "../embedder/text.js";
import { ensureCollections, client, getCollectionPointCount } from "../qdrant/client.js";

// --- Types ---

interface SessionLine {
  type: "session";
  id: string;
  timestamp: string;
}

interface MessageLine {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: string;
    content: string | ContentBlock[];
    timestamp?: number;
    [key: string]: unknown;
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

interface MessageIndexState {
  sessions: Record<
    string,
    {
      file: string;
      lastSize: number;
      lastModified: string;
      messagesIndexed: number;
      lastSeq: number;
    }
  >;
  lastRun: string;
  totalMessagesIndexed: number;
}

interface ExtractedMessage {
  sessionId: string;
  messageId: string;
  seq: number;
  role: string;
  content: string;
  timestamp: string;
  timestampMs: number;
}

// --- State management ---

async function loadState(): Promise<MessageIndexState> {
  try {
    const data = await readFile(config.messageIndexing.stateFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return { sessions: {}, lastRun: "", totalMessagesIndexed: 0 };
  }
}

async function saveState(state: MessageIndexState): Promise<void> {
  await writeFile(
    config.messageIndexing.stateFile,
    JSON.stringify(state, null, 2)
  );
}

export interface MessageReconcileOptions {
  getCount?: (collection: string) => Promise<number>;
  log?: (msg: string) => void;
  tolerance?: number;
}

/**
 * Drift detection for message state. See brain/decisions/2026-04-11-qdrant-tmpfs-rescue.md.
 * Pure function modulo injectable getCount — testable.
 */
export async function reconcileMessageState(
  state: MessageIndexState,
  options: MessageReconcileOptions = {}
): Promise<MessageIndexState> {
  const getCount = options.getCount ?? getCollectionPointCount;
  const log = options.log ?? ((msg: string) => console.error(msg));
  const tolerance = options.tolerance ?? 0.8;

  const expectedCount = Object.values(state.sessions).reduce(
    (sum, s) => sum + s.messagesIndexed,
    0
  );
  if (expectedCount === 0) return state;

  let actualCount: number;
  try {
    actualCount = await getCount(config.collections.messages);
  } catch (err) {
    log(
      `[message-indexer] reconcile: failed to query ${config.collections.messages}: ${err}. Assuming state is trustworthy.`
    );
    return state;
  }

  const threshold = Math.floor(expectedCount * tolerance);
  if (actualCount < threshold) {
    log(
      `[message-indexer] DRIFT DETECTED: state expects ${expectedCount} messages, ` +
        `Qdrant has ${actualCount} (< ${Math.round(tolerance * 100)}% threshold of ${threshold}). ` +
        `Wiping state to force full reindex.`
    );
    return { sessions: {}, lastRun: "", totalMessagesIndexed: 0 };
  }
  return state;
}

// --- Content extraction ---

export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
    }
    // Skip thinking, toolCall, toolResult, image blocks
  }
  return texts.join("\n");
}

// --- Noise filtering ---

function shouldSkipMessage(role: string, content: string): boolean {
  // Role filter
  if (!config.messageIndexing.roles.includes(role)) return true;

  // Empty or too short
  if (content.length < config.messageIndexing.minContentLength) return true;

  // Skip patterns
  for (const pattern of config.messageIndexing.skipPatterns) {
    if (pattern.test(content)) return true;
  }

  return false;
}

function hasTextContent(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "text" && block.text);
}

// --- Point ID ---

function messagePointId(sessionId: string, messageId: string): string {
  const hash = createHash("sha256")
    .update(`io-messages:${sessionId}:${messageId}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

// --- Session file parsing ---

function parseSessionFile(
  lines: string[],
  sessionId: string
): ExtractedMessage[] {
  const messages: ExtractedMessage[] = [];
  let seq = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== "message") continue;

    const msg = parsed as unknown as MessageLine;
    const role = msg.message?.role;
    if (!role) continue;

    seq++;

    // Skip tool-only assistant messages
    if (
      config.messageIndexing.skipToolOnlyMessages &&
      role === "assistant" &&
      !hasTextContent(msg.message.content)
    ) {
      continue;
    }

    const content = extractTextContent(msg.message.content);
    if (shouldSkipMessage(role, content)) continue;

    const timestampStr = msg.timestamp || new Date().toISOString();
    const timestampMs =
      typeof msg.message.timestamp === "number"
        ? msg.message.timestamp
        : new Date(timestampStr).getTime();

    messages.push({
      sessionId,
      messageId: msg.id,
      seq,
      role,
      content,
      timestamp: timestampStr,
      timestampMs,
    });
  }

  return messages;
}

// --- Indexing ---

export async function indexSessionFile(
  filePath: string,
  state: MessageIndexState
): Promise<{ indexed: number; skipped: number }> {
  const filename = basename(filePath, ".jsonl");
  const sessionId = filename;

  // Check if file has changed
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;
  const fileModified = fileStat.mtime.toISOString();

  const existing = state.sessions[sessionId];
  if (
    existing &&
    existing.lastSize === fileSize &&
    existing.lastModified === fileModified
  ) {
    return { indexed: 0, skipped: existing.messagesIndexed };
  }

  // Read and parse
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n");

  const messages = parseSessionFile(lines, sessionId);

  if (messages.length === 0) {
    state.sessions[sessionId] = {
      file: basename(filePath),
      lastSize: fileSize,
      lastModified: fileModified,
      messagesIndexed: 0,
      lastSeq: 0,
    };
    return { indexed: 0, skipped: 0 };
  }

  // Batch embed
  const texts = messages.map((m) => m.content);
  const batchSize = 100;
  const allVectors: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await embedTexts(batch, "RETRIEVAL_DOCUMENT");
    allVectors.push(...vectors);
  }

  // Build points and upsert
  const collection = config.collections.messages;
  const points = messages.map((msg, i) => ({
    id: messagePointId(msg.sessionId, msg.messageId),
    vector: allVectors[i],
    payload: {
      source: basename(filePath),
      sessionId: msg.sessionId,
      messageId: msg.messageId,
      seq: msg.seq,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      timestampMs: msg.timestampMs,
      indexedAt: new Date().toISOString(),
    },
  }));

  // Upsert in batches of 100
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    await client.upsert(collection, { wait: true, points: batch });
  }

  // Update state
  state.sessions[sessionId] = {
    file: basename(filePath),
    lastSize: fileSize,
    lastModified: fileModified,
    messagesIndexed: messages.length,
    lastSeq: messages[messages.length - 1].seq,
  };

  return { indexed: messages.length, skipped: 0 };
}

export async function indexAllMessages(
  singleSession?: string
): Promise<{ sessionsProcessed: number; indexed: number; skipped: number }> {
  await ensureCollections();
  let state = await loadState();
  state = await reconcileMessageState(state);

  const sessionsDir = config.sources.messages;
  let files: string[];

  if (singleSession) {
    const filename = singleSession.endsWith(".jsonl")
      ? singleSession
      : `${singleSession}.jsonl`;
    files = [join(sessionsDir, filename)];
  } else {
    const entries = await readdir(sessionsDir);
    files = entries
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionsDir, f));
  }

  let totalIndexed = 0;
  let totalSkipped = 0;
  let sessionsProcessed = 0;

  for (const filePath of files) {
    try {
      const result = await indexSessionFile(filePath, state);
      if (result.indexed > 0) sessionsProcessed++;
      totalIndexed += result.indexed;
      totalSkipped += result.skipped;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error indexing ${basename(filePath)}: ${msg}`);
    }
  }

  state.lastRun = new Date().toISOString();
  state.totalMessagesIndexed = Object.values(state.sessions).reduce(
    (sum, s) => sum + s.messagesIndexed,
    0
  );
  await saveState(state);

  return { sessionsProcessed, indexed: totalIndexed, skipped: totalSkipped };
}

// --- Context retrieval ---

export async function getMessageContext(
  timestamp: string,
  windowMinutes: number = 15,
  limit: number = 30
): Promise<
  { role: string; content: string; timestamp: string; sessionId: string }[]
> {
  const targetMs = timestamp.match(/^\d+$/)
    ? parseInt(timestamp)
    : new Date(timestamp).getTime();

  const windowMs = windowMinutes * 60 * 1000;
  const minMs = targetMs - windowMs;
  const maxMs = targetMs + windowMs;

  const collection = config.collections.messages;

  const results = await client.scroll(collection, {
    filter: {
      must: [
        { key: "timestampMs", range: { gte: minMs, lte: maxMs } },
      ],
    },
    limit,
    with_payload: true,
    with_vector: false,
  });

  const messages = results.points
    .map((p) => {
      const payload = p.payload as Record<string, unknown>;
      return {
        role: payload.role as string,
        content: payload.content as string,
        timestamp: payload.timestamp as string,
        timestampMs: payload.timestampMs as number,
        sessionId: payload.sessionId as string,
      };
    })
    .sort((a, b) => a.timestampMs - b.timestampMs);

  return messages.map(({ timestampMs: _, ...rest }) => rest);
}
