import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  fstatSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "fs";
import { execFile } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import {
  SESSION_CHECK_INTERVAL,
  MAX_OBSERVATION_MESSAGES,
  evaluateShouldObserve,
  readState,
  readTranscriptFromOffset,
  shouldSkipMessage,
  sanitiseSessionKey,
  loadPointer,
  savePointer,
  type Pointer,
} from "../../../../../core/observer/index.js";

// Re-export for tests + downstream code that previously imported from this module.
export {
  MIN_OBSERVATION_GAP_MS,
  DEFAULT_OBSERVATION_MAX_AGE_MS,
  evaluateShouldObserve,
  shouldSkipMessage,
  readTranscriptFromOffset,
  sanitiseSessionKey,
  type ObserverState,
  type Pointer,
  type EvaluateParams,
  type EvaluateResult,
} from "../../../../../core/observer/index.js";

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
// Env override BRAIN_TOOLS_DIR lets development/CI point elsewhere.
const TOOLS_DIR =
  process.env.BRAIN_TOOLS_DIR ??
  fileURLToPath(new URL("../../memory-tools/", import.meta.url));
const OBSERVE_SH = join(TOOLS_DIR, "observe.sh");
const REFLECT_SH = join(TOOLS_DIR, "reflect.sh");

// --- Session key derivation (OpenClaw-specific) ---

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

// --- Session resolution (OpenClaw sessions.json format) ---

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
  let pointer = loadPointer(POINTERS_DIR, sessionKey);

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
        savePointer(POINTERS_DIR, pointer);
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
    savePointer(POINTERS_DIR, pointer);
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
      const speaker = m.role === "user" ? (process.env.USER_NAME || "User") : (process.env.AGENT_NAME || "Agent");
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
      savePointer(POINTERS_DIR, pointer);

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
  const state = readState(STATE_FILE);
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
            const speaker = m.role === "user" ? (process.env.USER_NAME || "User") : (process.env.AGENT_NAME || "Agent");
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
      savePointer(POINTERS_DIR, pointer);
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
    savePointer(POINTERS_DIR, pointer);

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
      state: readState(STATE_FILE),
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
