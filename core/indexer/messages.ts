import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { join, basename, dirname } from "path";
import { createHash } from "crypto";
import { config } from "../config.js";
import { embedTexts } from "../embedder/text.js";
import { ensureCollections, client, getCollectionPointCount } from "../qdrant/client.js";
import { discoverCCSessions, type DiscoveredSession } from "./cc-session-discovery.js";

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

interface CCSessionState {
  file: string;
  projectDir: string;
  agentName: string;
  lastSize: number;
  lastModified: string;
  pairsIndexed: number;
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
  ccSessions: Record<string, CCSessionState>;
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
    return { sessions: {}, ccSessions: {}, lastRun: "", totalMessagesIndexed: 0 };
  }
}

async function saveState(state: MessageIndexState): Promise<void> {
  await mkdir(dirname(config.messageIndexing.stateFile), { recursive: true });
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
    return { sessions: {}, ccSessions: {}, lastRun: "", totalMessagesIndexed: 0 };
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

// --- CC conversation pair ---

interface CCPair {
  pairIndex: number;
  userContent: string | null;
  userMessageId: string | null;
  assistantContent: string | null;
  assistantMessageId: string | null;
  timestamp: string;
  timestampMs: number;
}

function parseCCSessionFile(lines: string[]): CCPair[] {
  const pairs: CCPair[] = [];
  let currentUser: { content: string; id: string; timestamp: string; timestampMs: number } | null = null;
  let pairIndex = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const type = parsed.type as string;
    if (type !== "user" && type !== "assistant") continue;

    const msg = parsed.message as { role: string; content: string | ContentBlock[] } | undefined;
    if (!msg) continue;

    if (
      config.messageIndexing.skipToolOnlyMessages &&
      type === "assistant" &&
      !hasTextContent(msg.content)
    ) {
      continue;
    }

    const content = extractTextContent(msg.content);
    if (shouldSkipMessage(msg.role, content)) continue;

    const timestampStr = (parsed.timestamp as string) || new Date().toISOString();
    const timestampMs = new Date(timestampStr).getTime();

    if (type === "user") {
      // Flush previous user if it had no assistant response
      if (currentUser) {
        pairs.push({
          pairIndex: pairIndex++,
          userContent: currentUser.content,
          userMessageId: currentUser.id,
          assistantContent: null,
          assistantMessageId: null,
          timestamp: currentUser.timestamp,
          timestampMs: currentUser.timestampMs,
        });
      }
      currentUser = {
        content,
        id: (parsed.uuid as string) || (parsed.promptId as string) || "",
        timestamp: timestampStr,
        timestampMs,
      };
    } else if (type === "assistant") {
      if (currentUser) {
        pairs.push({
          pairIndex: pairIndex++,
          userContent: currentUser.content,
          userMessageId: currentUser.id,
          assistantContent: content,
          assistantMessageId: (parsed.uuid as string) || "",
          timestamp: currentUser.timestamp,
          timestampMs: currentUser.timestampMs,
        });
        currentUser = null;
      } else {
        // Orphan assistant (e.g. after /compact)
        pairs.push({
          pairIndex: pairIndex++,
          userContent: null,
          userMessageId: null,
          assistantContent: content,
          assistantMessageId: (parsed.uuid as string) || "",
          timestamp: timestampStr,
          timestampMs,
        });
      }
    }
  }

  // Flush trailing user with no response
  if (currentUser) {
    pairs.push({
      pairIndex: pairIndex++,
      userContent: currentUser.content,
      userMessageId: currentUser.id,
      assistantContent: null,
      assistantMessageId: null,
      timestamp: currentUser.timestamp,
      timestampMs: currentUser.timestampMs,
    });
  }

  return pairs;
}

function ccPairToText(pair: CCPair): string {
  const parts: string[] = [];
  if (pair.userContent) parts.push(`[User] ${pair.userContent}`);
  if (pair.assistantContent) parts.push(`[Assistant] ${pair.assistantContent}`);
  return parts.join("\n\n");
}

function ccPointId(projectDir: string, sessionId: string, pairIndex: number, chunk: number): string {
  const hash = createHash("sha256")
    .update(`io-messages:cc:${projectDir}/${sessionId}:pair-${pairIndex}:chunk-${chunk}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

const CHUNK_MAX_CHARS = config.chunkMaxTokens * 4;

function chunkPairText(pair: CCPair): string[] {
  const text = ccPairToText(pair);
  if (text.length <= CHUNK_MAX_CHARS) return [text];

  // Split long text, keeping user prefix on each chunk
  const userPrefix = pair.userContent ? `[User] ${pair.userContent}\n\n` : "";
  const assistantText = pair.assistantContent || "";

  if (userPrefix.length >= CHUNK_MAX_CHARS) {
    // User message itself exceeds limit — split it standalone
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_MAX_CHARS) {
      chunks.push(text.slice(i, i + CHUNK_MAX_CHARS));
    }
    return chunks;
  }

  const available = CHUNK_MAX_CHARS - userPrefix.length;
  const chunks: string[] = [];
  for (let i = 0; i < assistantText.length; i += available) {
    const slice = assistantText.slice(i, i + available);
    chunks.push(`${userPrefix}[Assistant] ${slice}`);
  }
  return chunks;
}

async function indexCCSession(
  session: DiscoveredSession,
  state: MessageIndexState,
): Promise<{ indexed: number; skipped: number }> {
  const stateKey = `${session.projectDir}/${session.sessionId}`;
  const fileStat = await stat(session.filePath);
  const fileSize = fileStat.size;
  const fileModified = fileStat.mtime.toISOString();

  const existing = state.ccSessions[stateKey];
  if (
    existing &&
    existing.lastSize === fileSize &&
    existing.lastModified === fileModified
  ) {
    return { indexed: 0, skipped: existing.pairsIndexed };
  }

  const raw = await readFile(session.filePath, "utf-8");
  const lines = raw.split("\n");
  const pairs = parseCCSessionFile(lines);

  if (pairs.length === 0) {
    state.ccSessions[stateKey] = {
      file: basename(session.filePath),
      projectDir: session.projectDir,
      agentName: session.agentName,
      lastSize: fileSize,
      lastModified: fileModified,
      pairsIndexed: 0,
    };
    return { indexed: 0, skipped: 0 };
  }

  // Delete previous points for this session (handles re-indexing on growth)
  const sourceValue = `cc:${session.projectDir}/${session.sessionId}`;
  await client.delete(config.collections.messages, {
    wait: true,
    filter: {
      must: [{ key: "source", match: { value: sourceValue } }],
    },
  });

  // Chunk all pairs and build embedding texts
  const allChunks: { pair: CCPair; chunkIndex: number; totalChunks: number; text: string }[] = [];
  for (const pair of pairs) {
    const chunks = chunkPairText(pair);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({ pair, chunkIndex: i, totalChunks: chunks.length, text: chunks[i] });
    }
  }

  // Batch embed
  const batchSize = 100;
  const allVectors: number[][] = [];
  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize).map((c) => c.text);
    const vectors = await embedTexts(batch, "RETRIEVAL_DOCUMENT");
    allVectors.push(...vectors);
    if (i + batchSize < allChunks.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Build points
  const collection = config.collections.messages;
  const points = allChunks.map((c, i) => ({
    id: ccPointId(session.projectDir, session.sessionId, c.pair.pairIndex, c.chunkIndex),
    vector: allVectors[i],
    payload: {
      source: `cc:${session.projectDir}/${session.sessionId}`,
      sessionId: session.sessionId,
      pairIndex: c.pair.pairIndex,
      chunk: c.chunkIndex,
      totalChunks: c.totalChunks,
      userMessageId: c.pair.userMessageId,
      assistantMessageId: c.pair.assistantMessageId,
      content: c.text,
      timestamp: c.pair.timestamp,
      timestampMs: c.pair.timestampMs,
      agentName: session.agentName,
      projectDir: session.projectDir,
      collection: "io-messages",
      indexedAt: new Date().toISOString(),
    },
  }));

  // Upsert in batches
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    await client.upsert(collection, { wait: true, points: batch });
  }

  state.ccSessions[stateKey] = {
    file: basename(session.filePath),
    projectDir: session.projectDir,
    agentName: session.agentName,
    lastSize: fileSize,
    lastModified: fileModified,
    pairsIndexed: pairs.length,
  };

  return { indexed: allChunks.length, skipped: 0 };
}

// --- Indexing (gateway format) ---

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
  singleSession?: string,
  agentFilter?: string,
): Promise<{ sessionsProcessed: number; indexed: number; skipped: number }> {
  await ensureCollections();
  let state = await loadState();
  if (!state.ccSessions) state.ccSessions = {};
  state = await reconcileMessageState(state);

  let totalIndexed = 0;
  let totalSkipped = 0;
  let sessionsProcessed = 0;

  // --- Gateway sessions (existing OpenClaw format) ---
  if (!agentFilter) {
    const sessionsDir = config.sources.messages;
    let files: string[];

    if (singleSession) {
      const filename = singleSession.endsWith(".jsonl")
        ? singleSession
        : `${singleSession}.jsonl`;
      files = [join(sessionsDir, filename)];
    } else {
      try {
        const entries = await readdir(sessionsDir);
        files = entries
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(sessionsDir, f));
      } catch {
        files = [];
      }
    }

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
  }

  // --- CC sessions ---
  const { sessions: ccSessions, unmappedDirs } = await discoverCCSessions();

  if (unmappedDirs.length > 0) {
    console.error(`[cc-indexer] Unmapped dirs (skipped): ${unmappedDirs.join(", ")}`);
  }

  let ccFiltered = ccSessions;
  if (agentFilter) {
    ccFiltered = ccSessions.filter((s) => s.agentName === agentFilter);
  }

  console.error(
    `[cc-indexer] Discovered ${ccFiltered.length} CC sessions` +
      (agentFilter ? ` for agent=${agentFilter}` : "") +
      ` across ${new Set(ccFiltered.map((s) => s.projectDir)).size} project dirs`
  );

  for (const session of ccFiltered) {
    try {
      const result = await indexCCSession(session, state);
      if (result.indexed > 0) {
        sessionsProcessed++;
        console.error(
          `[cc-indexer] ${session.agentName}/${session.sessionId}: ${result.indexed} chunks indexed`
        );
      }
      totalIndexed += result.indexed;
      totalSkipped += result.skipped;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cc-indexer] Error indexing ${session.projectDir}/${session.sessionId}: ${msg}`);
    }
  }

  state.lastRun = new Date().toISOString();
  state.totalMessagesIndexed =
    Object.values(state.sessions).reduce((sum, s) => sum + s.messagesIndexed, 0) +
    Object.values(state.ccSessions).reduce((sum, s) => sum + s.pairsIndexed, 0);
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
