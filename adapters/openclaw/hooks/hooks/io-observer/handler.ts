import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execFile } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// --- Config ---

const WORKSPACE =
  process.env.WORKSPACE_DIR ?? join(homedir(), ".openclaw", "workspace");
const STATE_FILE = join(WORKSPACE, "memory", "observer-state.json");
const POINTERS_DIR = join(WORKSPACE, "memory", "observer-pointers");
const LEGACY_BUFFER_FILE = join(WORKSPACE, "memory", "observer-buffer.json");
const SESSIONS_FILE = join(
  homedir(),
  ".openclaw",
  "agents",
  "main",
  "sessions",
  "sessions.json",
);
const SESSIONS_DIR = join(
  homedir(),
  ".openclaw",
  "agents",
  "main",
  "sessions",
);

// Resolve bundled shell scripts relative to this handler's install location.
// At install time openclaw copies the hook pack dir (adapters/openclaw/hooks/)
// to ~/.openclaw/hooks/<pack>/, so memory-tools/ travels with it.
// Env override GREYMATTER_TOOLS_DIR lets development/CI point elsewhere.
const TOOLS_DIR =
  process.env.GREYMATTER_TOOLS_DIR ??
  fileURLToPath(new URL("../../memory-tools/", import.meta.url));
const OBSERVE_SH = join(TOOLS_DIR, "observe.sh");
const REFLECT_SH = join(TOOLS_DIR, "reflect.sh");

export const MIN_OBSERVATION_GAP_MS = 25 * 60 * 1000; // 25 minutes
export const DEFAULT_OBSERVATION_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_OBSERVATION_MESSAGES = 50; // Cap per observation to avoid overwhelming observe.sh
const SESSION_CHECK_INTERVAL = 10; // Check sessions.json every N messages

// --- Noise filtering ---

const SKIP_PATTERNS = [
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^\[cron:/,
  /^Read HEARTBEAT\.md/,
  /^System: \[/,
];
const MIN_CONTENT_LENGTH = 20;

export function shouldSkipMessage(content: string): boolean {
  if (content.length < MIN_CONTENT_LENGTH) return true;
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  return false;
}

// --- Pointer types ---

export interface Pointer {
  sessionKey: string;
  sessionId: string;
  transcriptPath: string;
  lastObservedOffset: number;
  lastObservedTimestamp: string | null;
  messagesSinceLastObservation: number;
  charsSinceLastObservation: number;
}

// --- Session key utilities ---

export function sanitiseSessionKey(key: string): string {
  return key.replace(/[/:]/g, "-");
}

function deriveSessionKey(
  channelId: string | undefined,
  conversationId: string | undefined,
): string {
  // Default to the main session if no context available
  if (!channelId && !conversationId) return "agent:main:main";
  const channel = channelId ?? "main";
  const convo = conversationId ?? "main";
  return `agent:main:${channel}:${convo}`;
}

// --- Pointer persistence ---

function pointerPath(sessionKey: string): string {
  return join(POINTERS_DIR, `${sanitiseSessionKey(sessionKey)}.json`);
}

function loadPointer(sessionKey: string): Pointer | null {
  try {
    const path = pointerPath(sessionKey);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // corrupt file — will be recreated
  }
  return null;
}

function savePointer(pointer: Pointer): void {
  try {
    mkdirSync(POINTERS_DIR, { recursive: true });
    const path = pointerPath(pointer.sessionKey);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pointer, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    console.error("[io-observer] Failed to persist pointer:", err);
  }
}

// --- Session resolution ---

interface SessionInfo {
  sessionId: string;
  transcriptPath: string;
}

function resolveSession(sessionKey: string): SessionInfo | null {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    const entry = sessions[sessionKey];
    if (!entry?.sessionId) return null;
    return {
      sessionId: entry.sessionId,
      transcriptPath: join(SESSIONS_DIR, `${entry.sessionId}.jsonl`),
    };
  } catch {
    return null;
  }
}

// Session check counter per key (avoid reading sessions.json on every message)
const sessionCheckCounters = new Map<string, number>();

function resolveOrCreatePointer(sessionKey: string): Pointer {
  let pointer = loadPointer(sessionKey);

  // Check for session changes periodically
  const counter = (sessionCheckCounters.get(sessionKey) ?? 0) + 1;
  sessionCheckCounters.set(sessionKey, counter);
  const shouldCheckSession = !pointer || counter % SESSION_CHECK_INTERVAL === 0;

  if (shouldCheckSession) {
    const session = resolveSession(sessionKey);
    if (session) {
      if (!pointer || pointer.sessionId !== session.sessionId) {
        // Session changed (or first time) — reset pointer
        if (pointer && pointer.sessionId !== session.sessionId) {
          console.error(
            `[io-observer] Session changed for ${sessionKey}: ${pointer.sessionId} → ${session.sessionId}. Resetting pointer.`,
          );
        }
        // Set offset to current file size (treat everything before now as "observed")
        // unless this is the very first pointer (offset 0 to read everything)
        let initialOffset = 0;
        if (pointer) {
          // Session changed — start from current EOF (we observed previous session)
          try {
            const fd = openSync(session.transcriptPath, "r");
            initialOffset = fstatSync(fd).size;
            closeSync(fd);
          } catch {
            initialOffset = 0;
          }
        }
        pointer = {
          sessionKey,
          sessionId: session.sessionId,
          transcriptPath: session.transcriptPath,
          lastObservedOffset: initialOffset,
          lastObservedTimestamp: null,
          messagesSinceLastObservation: 0,
          charsSinceLastObservation: 0,
        };
        savePointer(pointer);
      }
    }
  }

  // If we still don't have a pointer, create a blank one
  if (!pointer) {
    pointer = {
      sessionKey,
      sessionId: "",
      transcriptPath: "",
      lastObservedOffset: 0,
      lastObservedTimestamp: null,
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    };
  }

  return pointer;
}

// --- Observer state ---

export interface ObserverState {
  lastObservationAt?: string | null;
  observationMessageThreshold?: number;
  observationCharThreshold?: number;
  observationMaxAgeMs?: number;
  reflectionTriggerThreshold?: number;
  reflectionCharThreshold?: number;
  unprocessedObservationCount?: number;
  unprocessedObservationChars?: number;
}

function readState(): ObserverState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// --- Threshold evaluation (pure, testable) ---

export interface EvaluateParams {
  messageCount: number;
  charCount: number;
  oldestUnobservedTimestamp: number | null;
  state: ObserverState;
  now: number;
  observationInFlight: boolean;
}

export interface EvaluateResult {
  shouldFire: boolean;
  reason: string;
}

/**
 * Pure decision function: should an observation pass fire now?
 *
 * Trigger logic (OR, not AND): fire if ANY of
 *   - messageCount >= messageThreshold
 *   - charCount >= charThreshold
 *   - oldest unobserved message age >= maxAgeMs
 *
 * Blocking conditions (short-circuit, never fire):
 *   - observationInFlight
 *   - gap since last observation < MIN_OBSERVATION_GAP_MS (25 min cooldown)
 *   - no messages
 */
export function evaluateShouldObserve(params: EvaluateParams): EvaluateResult {
  if (params.observationInFlight) {
    return { shouldFire: false, reason: "observation already in flight" };
  }

  const msgThreshold = params.state.observationMessageThreshold ?? 6;
  const charThreshold = params.state.observationCharThreshold ?? 500;
  const maxAgeMs =
    params.state.observationMaxAgeMs ?? DEFAULT_OBSERVATION_MAX_AGE_MS;

  const lastAt = params.state.lastObservationAt
    ? new Date(params.state.lastObservationAt).getTime()
    : 0;
  const gap = params.now - lastAt;

  if (gap < MIN_OBSERVATION_GAP_MS) {
    const remainMin = Math.ceil((MIN_OBSERVATION_GAP_MS - gap) / 60000);
    return {
      shouldFire: false,
      reason: `cooldown: ${remainMin}m until next observation allowed`,
    };
  }

  if (params.messageCount === 0) {
    return { shouldFire: false, reason: "no messages" };
  }

  const age =
    params.oldestUnobservedTimestamp != null
      ? params.now - params.oldestUnobservedTimestamp
      : 0;

  const msgPassed = params.messageCount >= msgThreshold;
  const charPassed = params.charCount >= charThreshold;
  const agePassed = age >= maxAgeMs;

  if (msgPassed || charPassed || agePassed) {
    const triggers: string[] = [];
    if (msgPassed)
      triggers.push(`msgs=${params.messageCount}/${msgThreshold}`);
    if (charPassed)
      triggers.push(`chars=${params.charCount}/${charThreshold}`);
    if (agePassed) {
      const ageMin = Math.floor(age / 60000);
      const maxAgeMin = Math.floor(maxAgeMs / 60000);
      triggers.push(`age=${ageMin}m/${maxAgeMin}m`);
    }
    return {
      shouldFire: true,
      reason: `triggered: ${triggers.join(" OR ")}`,
    };
  }

  const ageMin = Math.floor(age / 60000);
  const maxAgeMin = Math.floor(maxAgeMs / 60000);
  return {
    shouldFire: false,
    reason: `below thresholds: msgs=${params.messageCount}/${msgThreshold}, chars=${params.charCount}/${charThreshold}, age=${ageMin}m/${maxAgeMin}m`,
  };
}

// --- Transcript reading ---

interface TranscriptMessage {
  role: string;
  content: string;
  timestamp: string;
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

      if (parsed.type !== "message") continue;

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
    console.error("[io-observer] Error reading transcript:", err);
    return { messages, newOffset: offset };
  }
}

// --- Shell environment ---

function shellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: (process.env.PATH ?? "") + ":" + join(homedir(), ".local", "bin"),
  };
}

// --- In-flight tracking per session key ---

const inFlightKeys = new Set<string>();

// --- Observation trigger ---

function triggerObservation(pointer: Pointer): void {
  inFlightKeys.add(pointer.sessionKey);

  // Read unobserved messages from the transcript
  const { messages, newOffset } = readTranscriptFromOffset(
    pointer.transcriptPath,
    pointer.lastObservedOffset,
  );

  if (messages.length === 0) {
    inFlightKeys.delete(pointer.sessionKey);
    // Still advance the pointer (no substantive messages, but we've read to EOF)
    pointer.lastObservedOffset = newOffset;
    pointer.messagesSinceLastObservation = 0;
    pointer.charsSinceLastObservation = 0;
    savePointer(pointer);
    console.error(
      `[io-observer] ${pointer.sessionKey}: no substantive messages in transcript since offset ${pointer.lastObservedOffset}`,
    );
    return;
  }

  // Cap at MAX_OBSERVATION_MESSAGES (most recent)
  const capped =
    messages.length > MAX_OBSERVATION_MESSAGES
      ? messages.slice(-MAX_OBSERVATION_MESSAGES)
      : messages;
  const skipped = messages.length - capped.length;

  // Format transcript (same format observe.sh expects)
  const transcript = capped
    .map((m) => {
      const t = m.timestamp.slice(11, 16); // HH:MM from ISO
      const speaker = m.role === "user" ? "Simon" : "Io";
      return `[${t}] ${speaker}: ${m.content}`;
    })
    .join("\n\n");

  const header =
    skipped > 0
      ? `[Note: ${skipped} older messages skipped — observing most recent ${capped.length}]\n\n`
      : "";

  // Write temp file
  const tmpFile = `/tmp/obs-input-${Date.now()}-${sanitiseSessionKey(pointer.sessionKey)}.txt`;
  writeFileSync(tmpFile, header + transcript);

  console.error(
    `[io-observer] ${pointer.sessionKey}: observing ${capped.length} messages from transcript (offset ${pointer.lastObservedOffset} → ${newOffset})`,
  );

  execFile(
    "bash",
    [OBSERVE_SH, "--file", tmpFile],
    { timeout: 60_000, cwd: WORKSPACE, env: shellEnv() },
    (err, stdout, stderr) => {
      inFlightKeys.delete(pointer.sessionKey);

      if (err) {
        console.error("[io-observer] observe.sh error:", err.message);
        if (stderr) console.error("[io-observer] stderr:", stderr);
        // Don't advance pointer on failure — will retry next trigger
        return;
      }

      // Success — advance pointer
      pointer.lastObservedOffset = newOffset;
      pointer.lastObservedTimestamp = new Date().toISOString();
      pointer.messagesSinceLastObservation = 0;
      pointer.charsSinceLastObservation = 0;
      savePointer(pointer);

      if (stdout.trim()) {
        console.error(`[io-observer] ${stdout.trim()}`);
      }

      // Try to clean up temp file
      try {
        unlinkSync(tmpFile);
      } catch {
        /* non-critical */
      }

      // Check if reflection is due
      checkReflection();
    },
  );
}

// --- Reflection check ---

function checkReflection(): void {
  const state = readState();
  const countThreshold = state.reflectionTriggerThreshold ?? 8;
  const charThreshold = state.reflectionCharThreshold ?? 25000;
  const count = state.unprocessedObservationCount ?? 0;
  const chars = state.unprocessedObservationChars ?? 0;

  if (count >= countThreshold || chars >= charThreshold) {
    execFile(
      "bash",
      [REFLECT_SH],
      { timeout: 120_000, cwd: WORKSPACE, env: shellEnv() },
      (err, stdout, stderr) => {
        if (err) {
          console.error("[io-observer] reflect.sh error:", err.message);
          if (stderr) console.error("[io-observer] stderr:", stderr);
          return;
        }
        if (stdout.trim()) {
          console.error(`[io-observer] ${stdout.trim()}`);
        }
      },
    );
  }
}

// --- Legacy buffer migration ---

function migrateLegacyBuffer(): void {
  if (!existsSync(LEGACY_BUFFER_FILE)) return;
  if (existsSync(POINTERS_DIR)) return; // already migrated

  console.error("[io-observer] Migrating legacy buffer to transcript pointers...");

  try {
    const buffer = JSON.parse(readFileSync(LEGACY_BUFFER_FILE, "utf-8"));

    // Flush the buffer one last time if it has content
    if (Array.isArray(buffer) && buffer.length > 0) {
      const transcript = buffer
        .map(
          (m: { role: string; content: string; timestamp: number }) => {
            const t = new Date(m.timestamp).toISOString().slice(11, 16);
            const speaker = m.role === "user" ? "Simon" : "Io";
            return `[${t}] ${speaker}: ${m.content}`;
          },
        )
        .join("\n\n");

      const tmpFile = `/tmp/obs-migration-${Date.now()}.txt`;
      writeFileSync(tmpFile, transcript);

      console.error(
        `[io-observer] Flushing ${buffer.length} buffered messages as final buffer observation...`,
      );

      // Synchronous-ish: fire and forget, the pointer will be created regardless
      execFile(
        "bash",
        [OBSERVE_SH, "--file", tmpFile],
        { timeout: 60_000, cwd: WORKSPACE, env: shellEnv() },
        (err) => {
          if (err) {
            console.error(
              "[io-observer] Migration flush failed (non-fatal):",
              err.message,
            );
          } else {
            console.error("[io-observer] Migration flush complete");
          }
          try {
            unlinkSync(tmpFile);
          } catch {
            /* non-critical */
          }
        },
      );
    }

    // Create pointers directory
    mkdirSync(POINTERS_DIR, { recursive: true });

    // Create initial pointer for agent:main:main at current EOF
    const session = resolveSession("agent:main:main");
    if (session) {
      let offset = 0;
      try {
        const fd = openSync(session.transcriptPath, "r");
        offset = fstatSync(fd).size;
        closeSync(fd);
      } catch {
        /* start from 0 */
      }

      const pointer: Pointer = {
        sessionKey: "agent:main:main",
        sessionId: session.sessionId,
        transcriptPath: session.transcriptPath,
        lastObservedOffset: offset,
        lastObservedTimestamp: new Date().toISOString(),
        messagesSinceLastObservation: 0,
        charsSinceLastObservation: 0,
      };
      savePointer(pointer);
      console.error(
        `[io-observer] Created initial pointer for agent:main:main at offset ${offset}`,
      );
    }

    // Archive the old buffer
    renameSync(LEGACY_BUFFER_FILE, `${LEGACY_BUFFER_FILE}.bak`);
    console.error("[io-observer] Legacy buffer archived to observer-buffer.json.bak");
  } catch (err) {
    console.error("[io-observer] Migration error (non-fatal):", err);
    // Ensure pointers dir exists regardless
    mkdirSync(POINTERS_DIR, { recursive: true });
  }
}

// --- Init ---

migrateLegacyBuffer();
mkdirSync(POINTERS_DIR, { recursive: true });
console.error(`[io-observer] Transcript-pointer mode. Pointers dir: ${POINTERS_DIR}`);

// --- Hook handler ---

export default function handler(event: Record<string, unknown>): void {
  try {
    const type = event.type as string | undefined;
    const action = event.action as string | undefined;
    const ctx = (event.context ?? {}) as Record<string, unknown>;

    let content: string;

    if (type === "message" && action === "preprocessed") {
      content =
        ((ctx.bodyForAgent ?? ctx.body ?? ctx.content) as string) ?? "";
    } else if (type === "message" && action === "sent") {
      if (!ctx.success) return;
      content = (ctx.content as string) ?? "";
    } else {
      return;
    }

    const text = content.trim();
    if (!text || shouldSkipMessage(text)) return;

    // Resolve session key from event context
    const channelId = ctx.channelId as string | undefined;
    const conversationId = (ctx.conversationId ?? ctx.threadId) as
      | string
      | undefined;
    const sessionKey =
      channelId || conversationId
        ? deriveSessionKey(channelId, conversationId)
        : "agent:main:main";

    // Load/create pointer for this thread
    const pointer = resolveOrCreatePointer(sessionKey);

    // Increment counters (hot path — no transcript reading)
    pointer.messagesSinceLastObservation++;
    pointer.charsSinceLastObservation += text.length;
    if (!pointer.lastObservedTimestamp && pointer.messagesSinceLastObservation === 1) {
      pointer.lastObservedTimestamp = new Date().toISOString();
    }
    savePointer(pointer);

    console.error(
      `[io-observer] ${sessionKey}: ${pointer.messagesSinceLastObservation} msgs, ${pointer.charsSinceLastObservation} chars since last observation`,
    );

    // Evaluate thresholds
    const oldestTs = pointer.lastObservedTimestamp
      ? new Date(pointer.lastObservedTimestamp).getTime()
      : null;

    const decision = evaluateShouldObserve({
      messageCount: pointer.messagesSinceLastObservation,
      charCount: pointer.charsSinceLastObservation,
      oldestUnobservedTimestamp: oldestTs,
      state: readState(),
      now: Date.now(),
      observationInFlight: inFlightKeys.has(sessionKey),
    });

    if (decision.shouldFire) {
      console.error(
        `[io-observer] ${sessionKey}: ${decision.reason} — triggering observation`,
      );
      triggerObservation(pointer);
    } else {
      console.error(
        `[io-observer] ${sessionKey}: not firing: ${decision.reason}`,
      );
    }
  } catch (err) {
    console.error("[io-observer] Handler error:", err);
  }
}
