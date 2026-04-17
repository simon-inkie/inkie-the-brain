/**
 * greymatter — Claude Code Stop hook handler.
 *
 * Fires after each assistant turn. Reads the transcript delta since the
 * last observation, evaluates thresholds, and — when due — kicks off
 * observe.sh (fire-and-forget) so the LLM observation pass happens out
 * of band without blocking the user's next prompt.
 *
 * Fail-open: any error → no observation + exit 0. Never blocks the agent.
 */

import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

try {
  const envPath = resolve(homedir(), "io-data", ".env");
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

import {
  evaluateShouldObserve,
  readTranscriptFromOffset,
  readState,
  loadPointer,
  savePointer,
  MAX_OBSERVATION_MESSAGES,
  type Pointer,
  type TranscriptMessage,
} from "../../../core/observer/index.js";
import { resolveMemoryDir } from "./memory-root.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

export interface StopResult {
  fired: boolean;
  reason: string;
}

export function sessionKeyFor(projectDir: string, sessionId: string): string {
  const slug = projectDir.replace(/\//g, "-").replace(/^-+/, "");
  return `cc:${slug}:${sessionId}`;
}

export async function run(rawInput: string): Promise<StopResult> {
  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { fired: false, reason: "malformed stdin" };
  }

  if (!input.transcript_path) {
    return { fired: false, reason: "no transcript_path in hook payload" };
  }
  if (!input.session_id) {
    return { fired: false, reason: "no session_id in hook payload" };
  }

  const projectDir = input.cwd ?? process.cwd();
  const memoryDir = resolveMemoryDir(projectDir);
  const pointersDir = join(memoryDir, "observer-pointers");
  const stateFile = join(memoryDir, "observer-state.json");

  const sessionKey = sessionKeyFor(projectDir, input.session_id);

  let pointer = loadPointer(pointersDir, sessionKey);
  if (!pointer) {
    pointer = {
      sessionKey,
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      lastObservedOffset: 0,
      lastObservedTimestamp: null,
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    };
  } else {
    // Transcript path may rotate between sessions; always trust the hook payload
    pointer.transcriptPath = input.transcript_path;
  }

  const { messages, newOffset } = readTranscriptFromOffset(
    input.transcript_path,
    pointer.lastObservedOffset,
  );

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
    // Persist pointer with latest path even when not firing, so the next
    // hook invocation sees the current transcript path.
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

  const tmpFile = `/tmp/gm-obs-${Date.now()}-${process.pid}.txt`;
  try {
    writeFileSync(tmpFile, header + transcript);
  } catch (err) {
    return {
      fired: false,
      reason: `failed to write temp file: ${(err as Error).message}`,
    };
  }

  const toolsDir = resolveToolsDir();
  const observeSh = join(toolsDir, "observe.sh");
  if (!existsSync(observeSh)) {
    return { fired: false, reason: `observe.sh not found at ${observeSh}` };
  }

  // Fire-and-forget — detach so the Stop hook returns quickly.
  try {
    mkdirSync(memoryDir, { recursive: true });
    const child = spawn("bash", [observeSh, "--file", tmpFile], {
      cwd: dirname(memoryDir),
      env: { ...process.env, MEMORY_DIR: memoryDir },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    return {
      fired: false,
      reason: `spawn failed: ${(err as Error).message}`,
    };
  }

  // Optimistically advance the pointer now. If observe.sh fails the worst
  // case is a missed observation — the next pass catches new material.
  pointer.lastObservedOffset = newOffset;
  pointer.lastObservedTimestamp = new Date().toISOString();
  pointer.messagesSinceLastObservation = 0;
  pointer.charsSinceLastObservation = 0;
  savePointer(pointersDir, pointer);

  return { fired: true, reason: decision.reason };
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
  if (process.env.GREYMATTER_TOOLS_DIR) {
    return process.env.GREYMATTER_TOOLS_DIR;
  }
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const candidate = join(process.env.CLAUDE_PLUGIN_ROOT, "memory-tools");
    if (isDirectory(candidate)) return candidate;
  }
  // Dev fallback — locate the OpenClaw adapter's memory-tools relative
  // to this source file: adapters/claude-code/src/ → ../../openclaw/hooks/memory-tools
  const here = fileURLToPath(import.meta.url);
  const dev = resolve(
    dirname(here),
    "..",
    "..",
    "openclaw",
    "hooks",
    "memory-tools",
  );
  return dev;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface StopHookOutput {
  suppressOutput: true;
}

function emit(): never {
  // Stop hooks don't need to inject anything — just acknowledge silently.
  // `suppressOutput: true` tells Claude Code not to surface the hook's
  // stdout in transcript mode.
  const output: StopHookOutput = { suppressOutput: true };
  process.stdout.write(JSON.stringify(output) + "\n");
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
    if (process.env.GREYMATTER_DEBUG === "1") {
      console.error(
        `[greymatter/on-stop] fired=${result.fired} reason=${result.reason}`,
      );
    }
  } catch (err) {
    if (process.env.GREYMATTER_DEBUG === "1") {
      console.error(`[greymatter/on-stop] error: ${(err as Error).message}`);
    }
  }
  emit();
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("on-stop.js") ||
  process.argv[1]?.endsWith("on-stop.ts");

if (isMain) {
  void main();
}
