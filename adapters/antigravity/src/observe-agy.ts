/**
 * the-brain — agy (Antigravity CLI) Stop hook handler.
 *
 * Fires at execution end (agy's flat-form Stop hook). Two jobs:
 *
 * 1. OBSERVE — parse the agy transcript.jsonl delta since the
 *    per-conversation cursor into the observer's TranscriptMessage shape
 *    and feed the existing observe pipeline (same cooldown + threshold
 *    evaluator as the CC Stop hook). Cursor follows the
 *    core/observer/transcript.ts pointer pattern, keyed `agy:<conversationId>`.
 *
 * 2. REFRESH — spawn the full build-context.sh (the splice path) out of
 *    band. The PreInvocation hook's --emit is deliberately a pure read, so
 *    turn end is where the silo MEMORY.md splice is kept fresh as the
 *    degraded-mode fallback context layer.
 *
 * Fail-open: any error → no observation + exit 0. Never blocks the agent.
 * Malformed transcript lines are counted, logged as a warn, and skipped.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Best-effort env load — mirrors the CC adapter preamble.
//
// Candidates in precedence order: BRAIN_ENV_FILE, then ~/.the-brain/.env (the
// documented location), then ~/io-data/.env (legacy, kept so an install that
// predates the ~/.the-brain/ layout keeps working). Mirrors core/env.ts,
// inlined here because it has to run before the imports below.
for (const envPath of [
  process.env.BRAIN_ENV_FILE,
  resolve(homedir(), ".the-brain", ".env"),
  resolve(homedir(), "io-data", ".env"),
]) {
  if (!envPath) continue;
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#]\w*)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    /* .env not found */
  }
}

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateShouldObserve,
  readState,
  loadPointer,
  savePointer,
  MAX_OBSERVATION_MESSAGES,
  type TranscriptMessage,
} from "../../../core/observer/index.js";
import { resolveMemoryDir } from "../../claude-code/src/memory-root.js";
import { log, makeTraceId } from "../../../core/log.js";
import { readAgyTranscriptFromOffset } from "./agy-transcript.js";
import type { AgyStopInput } from "./types.js";

export interface AgyStopResult {
  fired: boolean;
  reason: string;
}

export function sessionKeyFor(conversationId: string): string {
  return `agy:${conversationId}`;
}

export async function run(rawInput: string): Promise<AgyStopResult> {
  let input: AgyStopInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { fired: false, reason: "malformed stdin" };
  }

  const workspaceDir = input.workspacePaths?.[0] ?? process.cwd();
  const memoryDir = resolveMemoryDir(workspaceDir);
  const traceId = makeTraceId(input.conversationId);

  let result: AgyStopResult;
  try {
    result = observe(input, memoryDir, traceId);
  } catch (err) {
    result = {
      fired: false,
      reason: `observe error: ${(err as Error).message}`,
    };
  }

  // Turn-end MEMORY.md splice refresh, out of band so a slow era rebuild can
  // never block the hook. flock inside build-context.sh handles any overlap
  // with the observe.sh-triggered run.
  spawnBuildContext(memoryDir, traceId);

  log(
    result.fired ? "info" : "warn",
    "agy-on-stop",
    "hook-fired",
    {
      cwd: workspaceDir,
      sessionId: input.conversationId,
      memoryDir,
      data: {
        transcriptPath: input.transcriptPath,
        terminationReason: input.terminationReason,
        fired: result.fired,
        reason: result.reason,
      },
    },
    traceId,
  );

  return result;
}

function observe(
  input: AgyStopInput,
  memoryDir: string,
  traceId: string,
): AgyStopResult {
  if (!input.transcriptPath) {
    return { fired: false, reason: "no transcriptPath in hook payload" };
  }
  if (!input.conversationId) {
    return { fired: false, reason: "no conversationId in hook payload" };
  }

  const pointersDir = join(memoryDir, "observer-pointers");
  const stateFile = join(memoryDir, "observer-state.json");
  const sessionKey = sessionKeyFor(input.conversationId);

  let pointer = loadPointer(pointersDir, sessionKey);
  if (!pointer) {
    pointer = {
      sessionKey,
      sessionId: input.conversationId,
      transcriptPath: input.transcriptPath,
      lastObservedOffset: 0,
      lastObservedTimestamp: null,
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    };
  } else {
    pointer.transcriptPath = input.transcriptPath;
  }

  const { messages, newOffset, malformedLines } = readAgyTranscriptFromOffset(
    input.transcriptPath,
    pointer.lastObservedOffset,
  );

  if (malformedLines > 0) {
    log(
      "warn",
      "agy-on-stop",
      "malformed-transcript-lines",
      {
        sessionId: input.conversationId,
        memoryDir,
        data: { malformedLines, transcriptPath: input.transcriptPath },
      },
      traceId,
    );
  }

  const charCount = messages.reduce((sum, m) => sum + m.content.length, 0);
  const oldestTs =
    messages.length > 0 ? new Date(messages[0].timestamp).getTime() : null;
  const state = readState(stateFile);
  const decision = evaluateShouldObserve({
    messageCount: messages.length,
    charCount,
    oldestUnobservedTimestamp: oldestTs,
    state,
    now: Date.now(),
    observationInFlight: false,
  });
  if (!decision.shouldFire) {
    savePointer(pointersDir, pointer);
    return { fired: false, reason: decision.reason };
  }

  if (messages.length === 0) {
    pointer.lastObservedOffset = newOffset;
    savePointer(pointersDir, pointer);
    return { fired: false, reason: "no substantive messages in delta" };
  }

  const capped =
    messages.length > MAX_OBSERVATION_MESSAGES
      ? messages.slice(-MAX_OBSERVATION_MESSAGES)
      : messages;
  const skipped = messages.length - capped.length;

  const transcript = formatTranscript(capped);
  const header =
    skipped > 0
      ? `[Note: ${skipped} older messages skipped — observing most recent ${capped.length}]\n\n`
      : "";

  const tmpFile = `/tmp/tb-agy-obs-${Date.now()}-${process.pid}.txt`;
  try {
    writeFileSync(tmpFile, header + transcript);
  } catch (err) {
    return {
      fired: false,
      reason: `failed to write temp file: ${(err as Error).message}`,
    };
  }

  const observeSh = join(resolveToolsDir(), "observe.sh");
  if (!existsSync(observeSh)) {
    return { fired: false, reason: `observe.sh not found at ${observeSh}` };
  }

  try {
    mkdirSync(memoryDir, { recursive: true });
    const child = spawn("bash", [observeSh, "--file", tmpFile], {
      cwd: dirname(memoryDir),
      env: {
        ...process.env,
        MEMORY_DIR: memoryDir,
        AUTO_REFLECT: "1",
        BRAIN_TRACE_ID: traceId,
        BRAIN_COMPONENT: "observe.sh",
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    return { fired: false, reason: `spawn failed: ${(err as Error).message}` };
  }

  pointer.lastObservedOffset = newOffset;
  pointer.lastObservedTimestamp = new Date().toISOString();
  pointer.messagesSinceLastObservation = 0;
  pointer.charsSinceLastObservation = 0;
  savePointer(pointersDir, pointer);

  return {
    fired: true,
    reason: `threshold fire: ${messages.length} msgs in delta`,
  };
}

/**
 * Run the full build-context.sh (the splice path) detached.
 * Missing MEMORY.md or anchors makes it exit 1 on its own stderr; that is
 * fail-open by design and never reaches the agent.
 */
function spawnBuildContext(memoryDir: string, traceId: string): void {
  try {
    const buildContext = join(resolveToolsDir(), "build-context.sh");
    if (!existsSync(buildContext)) {
      log(
        "warn",
        "agy-on-stop",
        "build-context-missing",
        { memoryDir, data: { buildContext } },
        traceId,
      );
      return;
    }
    const child = spawn("bash", [buildContext], {
      cwd: dirname(memoryDir),
      env: {
        ...process.env,
        MEMORY_DIR: memoryDir,
        WORKSPACE_DIR: dirname(memoryDir),
        BRAIN_TRACE_ID: traceId,
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    log(
      "warn",
      "agy-on-stop",
      "build-context-spawn-failed",
      { memoryDir, data: { err: (err as Error).message } },
      traceId,
    );
  }
}

function formatTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => {
      const t = m.timestamp.slice(11, 16);
      const speaker = m.role === "user" ? "User" : "Assistant";
      return `[${t}] ${speaker}: ${m.content}`;
    })
    .join("\n\n");
}

function resolveToolsDir(): string {
  if (process.env.BRAIN_TOOLS_DIR) {
    return process.env.BRAIN_TOOLS_DIR;
  }
  if (process.env.AGY_PLUGIN_ROOT) {
    const candidate = join(process.env.AGY_PLUGIN_ROOT, "memory-tools");
    if (isDirectory(candidate)) return candidate;
  }
  // Dev fallback — adapters/antigravity/src/ -> ../../openclaw/hooks/memory-tools
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "..", "..", "openclaw", "hooks", "memory-tools");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function emit(): never {
  // Neutral output — agy's Stop hook contract does not consume stdout the
  // way PreInvocation does; an empty JSON object is the safe shape.
  process.stdout.write("{}\n");
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit();
  }
  try {
    const result = await run(raw);
    if (process.env.BRAIN_DEBUG === "1") {
      console.error(
        `[the-brain/agy-on-stop] fired=${result.fired} reason=${result.reason}`,
      );
    }
  } catch (err) {
    if (process.env.BRAIN_DEBUG === "1") {
      console.error(
        `[the-brain/agy-on-stop] error: ${(err as Error).message}`,
      );
    }
  }
  emit();
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("observe-agy.js") ||
  process.argv[1]?.endsWith("observe-agy.ts");

if (isMain) {
  void main();
}
