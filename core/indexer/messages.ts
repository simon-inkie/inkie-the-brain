import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join, basename, dirname } from "path";
import { createHash } from "crypto";
import { config } from "../config.js";
import { embedTexts, resetTickCounter, flushTelemetry } from "../embedder/text.js";
import { isDryRun, remainingTickBudget, MAX_EMBEDS_PER_TICK } from "../embedder/gate.js";
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
  // NEW — optional for back-compat with existing state file entries.
  // lastPairIndex: highest pair index that has been embedded (0-based).
  // firstPairUuid: userMessageId of pair[0] — used to detect content rewrites.
  lastPairIndex?: number;
  firstPairUuid?: string;
  // partial: this checkpoint covers only a PREFIX of the file's pairs — the
  // tick's embed budget ran out mid-session. Absent = complete (every existing
  // state entry written before this landed is complete by definition, so
  // back-compat is automatic). A partial entry must NOT be early-skipped on an
  // unchanged file, otherwise a cold session freezes half-indexed forever.
  partial?: true;
  // --- Append-only resume point (see readCCSessionPairs) -------------------
  // A verified byte position the NEXT tick can start reading from, so a session
  // transcript is not re-read and re-parsed from byte 0 on every tick.
  //
  // These three MUST be written and read as a unit. `lastSize` is deliberately
  // NOT reused as the seek offset: it records the size of the file at the last
  // READ, while a partial checkpoint's committed pairs may end far earlier —
  // seeking to lastSize on a partial session would skip every parsed-but-not-
  // embedded pair, silently and permanently.
  //
  // resumeLineStart: byte offset where the LAST LINE of pair
  //   (resumePairCount - 1) begins. That line is re-read and hash-checked
  //   before anything after it is trusted, so a wrong offset degrades to a
  //   full read rather than to a mis-parse.
  // resumeLineHash: fingerprint of that line's text — the check above.
  // resumePairCount: how many pairs (global, 0-based indices 0..n-1) the file
  //   yields up to and including that line.
  resumeLineStart?: number;
  resumeLineHash?: string;
  resumePairCount?: number;
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

// --- File reading ---

interface ReadLinesResult {
  lines: string[];
  /** Absolute byte offset at which lines[i] begins. */
  starts: number[];
}

/**
 * Read a JSONL transcript into its individual lines WITHOUT ever materialising
 * the whole file as one JS string, optionally starting at a byte offset.
 *
 * `readFile(path, "utf-8")` builds a single string for the entire file, and V8
 * caps a string at `buffer.constants.MAX_STRING_LENGTH` (~512MB on Node 22).
 * A session transcript past that ceiling threw `RangeError: Invalid string
 * length` before a single line was parsed, so the session could never index —
 * deterministically, on every tick, forever (one live agent's transcript passed
 * 1GB and had zero indexed messages as a result).
 *
 * Streaming through `readline` yields one bounded line at a time. Only the SUM
 * of a transcript's lines approaches the V8 limit; no individual JSONL line
 * comes close, so the parsers downstream keep their existing `string[]`
 * contract unchanged.
 *
 * `starts` is accumulated as `byteLength(line) + 1`, assuming single-`\n`
 * terminators (what every CC transcript writer emits). If that assumption were
 * ever wrong the offsets would drift — which is why nothing seeks on an offset
 * without re-reading and hash-checking the line it points at first. A drift
 * therefore costs a full re-read, never a mis-parse.
 */
async function readFileLines(filePath: string, startOffset = 0): Promise<ReadLinesResult> {
  const lines: string[] = [];
  const starts: number[] = [];
  let offset = startOffset;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8", start: startOffset }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lines.push(line);
    starts.push(offset);
    offset += Buffer.byteLength(line, "utf-8") + 1;
  }
  return { lines, starts };
}

function lineFingerprint(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
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
 * Drift detection for message state. Same failure mode, and the same reasoning,
 * as reconcileState in files.ts.
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
  /**
   * Index (into the `lines` array this pair was parsed from) of the LAST line
   * that contributes to this pair, or null when this pair is not a safe place
   * to resume from.
   *
   * Only null for the trailing user-with-no-response pair: an assistant line
   * appended later ABSORBS that user into a complete pair, so a resume point
   * after it would mis-parse the assistant as an orphan and permanently lose
   * the user half of the pair. Every other pair is final the moment it is
   * emitted and can never be changed by a later append.
   */
  endLineIndex: number | null;
}

/**
 * @param startPairIndex global index to assign to the first pair emitted.
 *   Non-zero when only the appended SUFFIX of a transcript is being parsed —
 *   pair indices are the identity of a point in Qdrant (ccPointId), so a suffix
 *   parse must continue the numbering, never restart it at 0.
 */
function parseCCSessionFile(lines: string[], startPairIndex = 0): CCPair[] {
  const pairs: CCPair[] = [];
  let currentUser:
    | { content: string; id: string; timestamp: string; timestampMs: number; lineIndex: number }
    | null = null;
  let pairIndex = startPairIndex;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
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
      // Flush previous user if it had no assistant response. A NEW user line
      // closes it for good, so it IS a safe resume point — and the boundary is
      // the old user's own line, not this one.
      if (currentUser) {
        pairs.push({
          pairIndex: pairIndex++,
          userContent: currentUser.content,
          userMessageId: currentUser.id,
          assistantContent: null,
          assistantMessageId: null,
          timestamp: currentUser.timestamp,
          timestampMs: currentUser.timestampMs,
          endLineIndex: currentUser.lineIndex,
        });
      }
      currentUser = {
        content,
        id: (parsed.uuid as string) || (parsed.promptId as string) || "",
        timestamp: timestampStr,
        timestampMs,
        lineIndex,
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
          endLineIndex: lineIndex,
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
          endLineIndex: lineIndex,
        });
      }
    }
  }

  // Flush trailing user with no response. NOT a resume point — see endLineIndex.
  if (currentUser) {
    pairs.push({
      pairIndex: pairIndex++,
      userContent: currentUser.content,
      userMessageId: currentUser.id,
      assistantContent: null,
      assistantMessageId: null,
      timestamp: currentUser.timestamp,
      timestampMs: currentUser.timestampMs,
      endLineIndex: null,
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

interface CCParseResult {
  /** Pairs parsed THIS tick — the appended suffix only, on a resumed read. */
  pairs: CCPair[];
  /** Global pair index of pairs[0]. Always 0 on a full read. */
  basePairIndex: number;
  /** Pairs the WHOLE file yields: basePairIndex + pairs.length. */
  totalPairs: number;
  /** Read started at byte 0, so pairs[0] really is the file's first pair. */
  fullRead: boolean;
  /** The lines `pairs` were parsed from, with their absolute byte offsets. */
  lines: string[];
  starts: number[];
}

function toParseResult(
  lines: string[],
  starts: number[],
  basePairIndex: number,
  fullRead: boolean,
): CCParseResult {
  const pairs = parseCCSessionFile(lines, basePairIndex);
  return { pairs, basePairIndex, totalPairs: basePairIndex + pairs.length, fullRead, lines, starts };
}

async function readCCSessionFull(filePath: string): Promise<CCParseResult> {
  const { lines, starts } = await readFileLines(filePath);
  return toParseResult(lines, starts, 0, true);
}

/**
 * Read a CC transcript, skipping the prefix already accounted for when that is
 * provably safe.
 *
 * A transcript is append-only in normal operation, so re-reading and re-parsing
 * it from byte 0 on every tick is pure waste — and on a multi-gigabyte session
 * it is most of the tick. Seeking is only sound if the bytes before the seek
 * point are unchanged, which is exactly what a rewrite would violate, so this
 * takes the fast path only when BOTH of these hold:
 *
 *  1. The file grew (`fileSize > lastSize`) or is byte-for-byte untouched
 *     (`fileSize === lastSize` AND the mtime is the one already recorded). A
 *     shrink is a trim; the same size with a new mtime is a same-length
 *     rewrite. Neither is an append, and both need the whole file so the
 *     rewrite guards in indexCCSession can see pair[0] and the real pair count.
 *  2. The line the recorded offset points at still hashes to the recorded
 *     fingerprint. This is what makes a WRONG offset harmless: a drifted or
 *     stale offset lands on different bytes, the hash disagrees, and the read
 *     degrades to a full one instead of silently mis-parsing or skipping pairs.
 *
 * The verification line is re-read and then dropped — parsing continues from
 * the line after it.
 */
async function readCCSessionPairs(
  filePath: string,
  existing: CCSessionState | undefined,
  fileSize: number,
  fileModified: string,
): Promise<CCParseResult> {
  const resumeLineStart = existing?.resumeLineStart;
  const resumePairCount = existing?.resumePairCount;
  const resumeLineHash = existing?.resumeLineHash;

  const appendOnly =
    existing !== undefined &&
    (fileSize > existing.lastSize ||
      (fileSize === existing.lastSize && fileModified === existing.lastModified));

  if (
    appendOnly &&
    typeof resumeLineStart === "number" &&
    typeof resumePairCount === "number" &&
    typeof resumeLineHash === "string" &&
    resumeLineStart >= 0 &&
    resumeLineStart < fileSize
  ) {
    const { lines, starts } = await readFileLines(filePath, resumeLineStart);
    if (lines.length > 0 && lineFingerprint(lines[0]) === resumeLineHash) {
      return toParseResult(lines.slice(1), starts.slice(1), resumePairCount, false);
    }
    console.error(
      `[cc-indexer] resume point for ${basename(filePath)} did not verify at byte ` +
        `${resumeLineStart} — re-reading the whole file`
    );
  }

  return readCCSessionFull(filePath);
}

/**
 * The resume point to persist: the last line of the newest pair at or before
 * `uptoPairIndex` that is a safe boundary. Walks backwards, because the newest
 * pair may be a trailing user awaiting its assistant (endLineIndex null).
 * Returns undefined when this parse contains no safe boundary at all, in which
 * case the caller keeps whatever it already had rather than inventing one.
 */
function resumePointFor(
  parse: CCParseResult,
  uptoPairIndex: number,
): Pick<CCSessionState, "resumeLineStart" | "resumeLineHash" | "resumePairCount"> | undefined {
  for (let i = Math.min(uptoPairIndex - parse.basePairIndex, parse.pairs.length - 1); i >= 0; i--) {
    const pair = parse.pairs[i];
    if (pair.endLineIndex === null) continue;
    return {
      resumeLineStart: parse.starts[pair.endLineIndex],
      resumeLineHash: lineFingerprint(parse.lines[pair.endLineIndex]),
      resumePairCount: pair.pairIndex + 1,
    };
  }
  return undefined;
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
    existing.lastModified === fileModified &&
    // A PARTIAL checkpoint must re-enter even when the file has not changed —
    // the remaining pairs are still unindexed and nothing else will ever bring
    // them in (a finished session's file never changes again).
    !existing.partial
  ) {
    return { indexed: 0, skipped: existing.pairsIndexed };
  }

  // Resolve effective lastPairIndex from state (back-compat: old entries
  // have pairsIndexed but no lastPairIndex).
  const existingPairsIndexed = existing?.pairsIndexed ?? 0;
  const existingLastPairIndex =
    existing?.lastPairIndex ?? (existingPairsIndexed > 0 ? existingPairsIndexed - 1 : undefined);

  let parse = await readCCSessionPairs(session.filePath, existing, fileSize, fileModified);

  // A suffix parse cannot see pair[0] or the true pair count, which the rewrite
  // guards below are built on. Any sign that the suffix is not enough — the
  // total went BACKWARDS, or a pair we need to act on sits before the seek
  // point — and the tick pays for a full read rather than guessing.
  if (!parse.fullRead) {
    const totalWentBackwards = parse.totalPairs < existingPairsIndexed;
    const needsPairBeforeSeek =
      existingLastPairIndex !== undefined && existingLastPairIndex + 1 < parse.basePairIndex;
    const needsLastPairReEmbed =
      parse.totalPairs === existingPairsIndexed &&
      fileSize > (existing?.lastSize ?? 0) &&
      existingLastPairIndex !== undefined &&
      existingLastPairIndex < parse.basePairIndex;
    if (totalWentBackwards || needsPairBeforeSeek || needsLastPairReEmbed) {
      parse = await readCCSessionFull(session.filePath);
    }
  }

  const { pairs, basePairIndex, totalPairs } = parse;
  /** A pair by its GLOBAL index — the suffix is not zero-based. */
  const pairAt = (globalIndex: number): CCPair | undefined =>
    globalIndex < basePairIndex ? undefined : pairs[globalIndex - basePairIndex];

  if (totalPairs === 0) {
    if (!isDryRun()) {
      state.ccSessions[stateKey] = {
        file: basename(session.filePath),
        projectDir: session.projectDir,
        agentName: session.agentName,
        lastSize: fileSize,
        lastModified: fileModified,
        pairsIndexed: 0,
      };
    }
    return { indexed: 0, skipped: 0 };
  }

  const sourceValue = `cc:${session.projectDir}/${session.sessionId}`;
  const collection = config.collections.messages;
  const batchSize = 100;

  // -----------------------------------------------------------------
  // Tri-guard decision tree — incremental indexing
  // -----------------------------------------------------------------

  let pairsToEmbed: CCPair[];
  let fullReEmbed = false;

  // Both guards need the whole file. A suffix parse only ever happens after
  // readCCSessionPairs established the file was appended to or untouched, which
  // is precisely the case in which neither guard can fire.
  if (parse.fullRead) {
    if (totalPairs < existingPairsIndexed) {
      // Pair count DROPPED — file trimmed or rewritten. Full re-embed.
      fullReEmbed = true;
    } else if (
      existing?.firstPairUuid &&
      pairs[0]?.userMessageId !== undefined &&
      pairs[0].userMessageId !== existing.firstPairUuid
    ) {
      // First pair's identity changed — content rewritten in place. Full re-embed.
      fullReEmbed = true;
    }
  }

  if (fullReEmbed) {
    // Delete all existing points for this session, then embed from scratch.
    if (process.env.EMBED_DRY_RUN !== "true") {
      await client.delete(config.collections.messages, {
        wait: true,
        filter: { must: [{ key: "source", match: { value: sourceValue } }] },
      });
    }
    pairsToEmbed = pairs;
  } else {
    // Delta path: embed only new pairs since lastPairIndex.
    // Also defensively re-embed the last already-embedded pair if bytes grew
    // (covers in-progress pair that grew without a new pair being appended).
    if (existingLastPairIndex === undefined) {
      // First run: no state at all — embed everything.
      pairsToEmbed = pairs;
    } else if (totalPairs === existingPairsIndexed && fileSize > (existing?.lastSize ?? 0)) {
      // Same pair count but file grew — re-embed the last pair defensively.
      pairsToEmbed = [pairAt(existingLastPairIndex)].filter(Boolean) as CCPair[];
    } else {
      // Normal growth: embed pairs from lastPairIndex+1 onward.
      pairsToEmbed = pairs.slice(existingLastPairIndex + 1 - basePairIndex);
    }
    // No delete needed — upsert is safe (ccPointId is deterministic).
  }

  // Backfill firstPairUuid for sessions that existed before this code landed.
  // Log every backfill so post-hoc grep can surface anomalies.
  //
  // On the FULL RE-EMBED path the stored uuid is the one we just invalidated —
  // persisting it would re-trigger the rewrite guard on the very next tick and,
  // now that a partial checkpoint re-enters an unchanged file, delete-and-restart
  // forever without ever finishing. A full re-embed adopts the CURRENT pair[0].
  //
  // A suffix parse has no pair[0] to read, so it can only carry forward what
  // state already holds — which is sound precisely because a suffix parse means
  // the file was appended to, leaving pair[0] untouched.
  const currentFirstUuid = parse.fullRead ? (pairs[0]?.userMessageId ?? null) : null;
  const resolvedFirstPairUuid = fullReEmbed
    ? (currentFirstUuid ?? undefined)
    : (existing?.firstPairUuid ?? currentFirstUuid ?? undefined);
  if (!existing?.firstPairUuid && currentFirstUuid) {
    console.error(
      `[cc-indexer] backfill firstPairUuid for ${session.sessionId} from current pair[0]: ${currentFirstUuid}`
    );
  }

  // Where the next tick may start reading. Computed against the pairs this tick
  // actually COMMITS, never against everything parsed — a partial checkpoint
  // that recorded the end of the file would strand every parsed-but-unembedded
  // pair. `?? existingResumePoint` keeps a still-valid recorded point when this
  // parse offers no safe boundary of its own; a full re-embed discards it,
  // since the pair numbering it referred to no longer applies.
  const existingResumePoint = fullReEmbed
    ? undefined
    : {
        resumeLineStart: existing?.resumeLineStart,
        resumeLineHash: existing?.resumeLineHash,
        resumePairCount: existing?.resumePairCount,
      };

  if (pairsToEmbed.length === 0) {
    // Nothing new to embed — just update the state timestamps.
    if (!isDryRun()) {
      state.ccSessions[stateKey] = {
        file: basename(session.filePath),
        projectDir: session.projectDir,
        agentName: session.agentName,
        lastSize: fileSize,
        lastModified: fileModified,
        pairsIndexed: totalPairs,
        lastPairIndex: totalPairs > 0 ? totalPairs - 1 : existingLastPairIndex,
        firstPairUuid: resolvedFirstPairUuid,
        ...(resumePointFor(parse, totalPairs - 1) ?? existingResumePoint),
      };
    }
    return { indexed: 0, skipped: existing?.pairsIndexed ?? 0 };
  }

  // -----------------------------------------------------------------
  // Bounded pair-prefix selection (resumable quota halts)
  // -----------------------------------------------------------------
  // Kill-switch counter is reset at tick-start in indexAllMessages, NOT per
  // session: a ceiling expressed per agent ("total ≤ 50 × N_active_agents")
  // only catches a system-wide regression if the budget pools across sessions.
  //
  // Chunk every candidate pair once, then take the LONGEST PREFIX OF COMPLETE
  // PAIRS whose cumulative chunk count fits what is left of this tick's budget.
  // Sizing the work to the budget means chargeTick never has to throw here, and
  // a pair can never be split across ticks (boundaries intact by construction,
  // not by a downstream repair). Whatever does not fit rolls to the next tick.
  const chunkedPairs = pairsToEmbed.map((pair) => ({ pair, chunks: chunkPairText(pair) }));

  const budget = remainingTickBudget();
  const selected: { pair: CCPair; chunks: string[] }[] = [];
  let selectedChunks = 0;
  for (const candidate of chunkedPairs) {
    if (selectedChunks + candidate.chunks.length > budget) break;
    selected.push(candidate);
    selectedChunks += candidate.chunks.length;
  }

  if (selected.length === 0) {
    // Not even the first candidate pair fits. Leave state untouched — claiming
    // progress we did not make is the failure this whole change exists to kill.
    const firstPairChunks = chunkedPairs[0].chunks.length;
    if (firstPairChunks > MAX_EMBEDS_PER_TICK) {
      // Degenerate: this pair cannot fit a WHOLE tick, so no amount of waiting
      // helps. Loud and visibly stuck beats silently skipped forever.
      console.error(
        `[cc-indexer] ⚠️  STUCK: ${session.agentName}/${session.sessionId} pair ${chunkedPairs[0].pair.pairIndex} ` +
          `needs ${firstPairChunks} chunks, more than the entire per-tick cap (${MAX_EMBEDS_PER_TICK}). ` +
          `This session cannot advance until the cap is raised for a one-off run or the oversized pair is investigated. ` +
          `State left untouched.`
      );
    } else {
      console.error(
        `[cc-indexer] ${session.agentName}/${session.sessionId}: ${budget} chunk(s) of tick budget left, ` +
          `next pair needs ${firstPairChunks} — deferred to the next tick`
      );
    }
    return { indexed: 0, skipped: existing?.pairsIndexed ?? 0 };
  }

  const allChunks: { pair: CCPair; chunkIndex: number; totalChunks: number; text: string }[] = [];
  for (const { pair, chunks } of selected) {
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({ pair, chunkIndex: i, totalChunks: chunks.length, text: chunks[i] });
    }
  }

  // Batch embed
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
  const points = allChunks.map((c, i) => ({
    id: ccPointId(session.projectDir, session.sessionId, c.pair.pairIndex, c.chunkIndex),
    vector: allVectors[i],
    payload: {
      source: sourceValue,
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

  // Upsert in batches (skip when dry-run)
  if (process.env.EMBED_DRY_RUN !== "true") {
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await client.upsert(collection, { wait: true, points: batch });
    }
  }

  // Checkpoint. lastPairIndex advances only through the last FULLY COMMITTED
  // pair — every point of every pair up to it has been upserted above. Upsert
  // happens before the state mutation, so a crash in between re-embeds at most
  // this one slice, idempotently (ccPointId is deterministic).
  const committedLastPairIndex = selected[selected.length - 1].pair.pairIndex;
  const isPartial = committedLastPairIndex < totalPairs - 1;

  if (!isDryRun()) {
    state.ccSessions[stateKey] = {
      file: basename(session.filePath),
      projectDir: session.projectDir,
      agentName: session.agentName,
      lastSize: fileSize,
      lastModified: fileModified,
      pairsIndexed: committedLastPairIndex + 1,
      lastPairIndex: committedLastPairIndex,
      firstPairUuid: resolvedFirstPairUuid,
      ...(resumePointFor(parse, committedLastPairIndex) ?? existingResumePoint),
      // Completion omits `partial` entirely, which also CLEARS it on the tick
      // that finishes a previously partial session.
      ...(isPartial ? { partial: true as const } : {}),
    };
  }

  if (isPartial) {
    console.error(
      `[cc-indexer] ${session.agentName}/${session.sessionId}: partial checkpoint — ` +
        `pairs 0..${committedLastPairIndex} of ${pairs.length} committed ` +
        `(${allChunks.length} chunks this tick); resumes next tick`
    );
  }

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

  // Read and parse. Same streaming read as the CC path: this indexer is still
  // live (indexAllMessages calls it on every non-agent-filtered tick, over a
  // sessions dir that exists and holds real .jsonl files), and it carries the
  // identical unbounded-string hazard. Fixing only the transcript that happens
  // to be oversized today would leave the second crash site armed.
  const { lines } = await readFileLines(filePath);

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

  // Reset kill-switch counter at tick-start. Budget pools across all sessions
  // processed in this tick, so the ceiling is system-wide rather than per session.
  resetTickCounter();

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

  for (let si = 0; si < ccFiltered.length; si++) {
    const session = ccFiltered[si];

    // Tick budget spent — stop the loop cleanly. Every session already
    // processed keeps its (possibly partial) checkpoint; the rest resume on the
    // next tick. One log line, not one quota error per remaining session.
    if (remainingTickBudget() <= 0) {
      console.error(
        `[cc-indexer] tick embed budget spent (${MAX_EMBEDS_PER_TICK}/tick) — stopping cleanly, ` +
          `${ccFiltered.length - si} session(s) deferred to the next tick`
      );
      break;
    }

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

  // Flush telemetry JSONL after state is saved
  await flushTelemetry();

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
