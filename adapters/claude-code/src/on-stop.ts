/**
 * the-brain — Claude Code Stop hook handler.
 *
 * Session-end-flush strategy: fires AT MOST ONCE per session.
 *
 * On each Stop call, we check whether this session has ever been observed.
 * If not, and there is unobserved content, we fire a single force observation
 * (label: "session-flush"). On all subsequent Stop calls for the same session,
 * we no-op — the flush condition is already satisfied.
 *
 * This eliminates the per-turn Haiku burst that occurred on agent restart when
 * many Stop calls fired back-to-back for accumulated turns. Compact + mid-session
 * observation is handled entirely by on-pre-compact.ts (force=true, always).
 *
 * Fail-open: any error → no observation + exit 0. Never blocks the agent.
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

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
  runObservation,
  sessionKeyFor,
  type HookInput,
  type TriggerResult,
} from "./observe-trigger.js";
import {
  loadPointer,
  readTranscriptFromOffset,
} from "../../../core/observer/index.js";
import { resolveMemoryDir } from "./memory-root.js";

// Re-exports for tests + back-compat.
export { sessionKeyFor };
export type StopResult = TriggerResult;

export async function run(rawInput: string): Promise<TriggerResult> {
  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { fired: false, reason: "malformed stdin" };
  }

  // Resolve pointer for this session to check whether we've already observed.
  const projectDir = input.cwd ?? process.cwd();
  const memoryDir = resolveMemoryDir(projectDir);
  const pointersDir = join(memoryDir, "observer-pointers");

  // Guard: need session_id + transcript_path to do anything useful.
  if (!input.session_id) {
    return { fired: false, reason: "no session_id in hook payload" };
  }
  if (!input.transcript_path) {
    return { fired: false, reason: "no transcript_path in hook payload" };
  }

  const sessionKey = sessionKeyFor(projectDir, input.session_id);
  const pointer = loadPointer(pointersDir, sessionKey);

  // No pointer yet → session just started, nothing accumulated. No-op.
  if (!pointer) {
    return { fired: false, reason: "no pointer — session not yet started" };
  }

  // Already observed this session → no-op. PreCompact handles mid-session.
  if (pointer.lastObservedTimestamp !== null) {
    return { fired: false, reason: "already observed this session" };
  }

  // Check whether there is any unobserved content.
  const { messages } = readTranscriptFromOffset(
    input.transcript_path,
    pointer.lastObservedOffset,
  );

  if (messages.length === 0) {
    return { fired: false, reason: "no unobserved content" };
  }

  // Flush condition met: first observation for this session, content exists.
  return runObservation(input, { force: true, label: "session-flush" });
}

interface StopHookOutput {
  suppressOutput: true;
}

function emit(): never {
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
    if (process.env.BRAIN_DEBUG === "1") {
      console.error(
        `[the-brain/on-stop] fired=${result.fired} reason=${result.reason}`,
      );
    }
  } catch (err) {
    if (process.env.BRAIN_DEBUG === "1") {
      console.error(`[the-brain/on-stop] error: ${(err as Error).message}`);
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
