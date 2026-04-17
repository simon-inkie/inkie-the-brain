/**
 * Shared observation-trigger logic for the Claude Code adapter.
 *
 * Both the Stop hook (throttled fire) and the PreCompact hook (force fire
 * before compaction destroys detail) funnel through `runObservation()`.
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateShouldObserve,
  readTranscriptFromOffset,
  readState,
  loadPointer,
  savePointer,
  MAX_OBSERVATION_MESSAGES,
  type TranscriptMessage,
} from "../../../core/observer/index.js";
import { resolveMemoryDir } from "./memory-root.js";

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  trigger?: "auto" | "manual";
}

export interface TriggerResult {
  fired: boolean;
  reason: string;
}

export interface TriggerOptions {
  /** Bypass cooldown + below-threshold skip. Any unobserved content fires. */
  force: boolean;
  /** Label for the observation temp-file (defaults to "obs"). */
  label?: string;
}

export function sessionKeyFor(projectDir: string, sessionId: string): string {
  const slug = projectDir.replace(/\//g, "-").replace(/^-+/, "");
  return `cc:${slug}:${sessionId}`;
}

export async function runObservation(
  input: HookInput,
  opts: TriggerOptions,
): Promise<TriggerResult> {
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
    pointer.transcriptPath = input.transcript_path;
  }

  const { messages, newOffset } = readTranscriptFromOffset(
    input.transcript_path,
    pointer.lastObservedOffset,
  );

  if (!opts.force) {
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
  }

  if (messages.length === 0) {
    pointer.lastObservedOffset = newOffset;
    savePointer(pointersDir, pointer);
    return {
      fired: false,
      reason: opts.force
        ? "force-fire: no unobserved content"
        : "no substantive messages in delta",
    };
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

  const label = opts.label ?? "obs";
  const tmpFile = `/tmp/gm-${label}-${Date.now()}-${process.pid}.txt`;
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

  pointer.lastObservedOffset = newOffset;
  pointer.lastObservedTimestamp = new Date().toISOString();
  pointer.messagesSinceLastObservation = 0;
  pointer.charsSinceLastObservation = 0;
  savePointer(pointersDir, pointer);

  return {
    fired: true,
    reason: opts.force
      ? `force-fire: ${messages.length} msgs, ${capped.length} observed`
      : `threshold fire: ${messages.length} msgs in delta`,
  };
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
