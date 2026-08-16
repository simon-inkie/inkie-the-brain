/**
 * the-brain — agy (Antigravity CLI) PreInvocation hook handler.
 *
 * Renders the live three-zone memory block via `build-context.sh --emit`
 * (pure read, no MEMORY.md splice, no live-state writes) and injects it as a
 * transient `ephemeralMessage` for the upcoming model call. This is the
 * agy equivalent of the Claude Code UserPromptSubmit hook; the NOW line
 * and <the-brain> wrapper are REUSED from the CC handler so the two
 * injection envelopes cannot drift apart.
 *
 * PreInvocation fires per MODEL CALL (many times a turn in tool loops),
 * and build-context is a heavy render, so results are cached per turn:
 * key = conversationId + count of USER_INPUT steps in the transcript.
 * Same turn, same render; new user request, fresh render.
 *
 * Fail-open: any error emits {"injectSteps":[]} and exits 0. We never
 * block the agent's model call over a memory-read failure.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Best-effort env load. Hook subprocesses don't inherit the user's full
// shell env; mirrors the CC adapter preamble.
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
  /* .env not found — env vars must already be set */
}

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMemoryDir } from "../../claude-code/src/memory-root.js";
import { wrapForInjection } from "../../claude-code/src/user-prompt-submit.js";
import { sanitiseSessionKey } from "../../../core/observer/transcript.js";
import { log, makeTraceId } from "../../../core/log.js";
import { countUserTurns } from "./agy-transcript.js";
import type { AgyHookInput, AgyInjectEnvelope } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_INJECTED_CHARS_DEFAULT = 40000;
const ANCHOR_START = "<!-- IO_LIVE_START -->";
const ANCHOR_END = "<!-- IO_LIVE_END -->";

const EMPTY_ENVELOPE: AgyInjectEnvelope = { injectSteps: [] };

interface CacheEntry {
  turnKey: number;
  envelope: AgyInjectEnvelope;
}

function emit(envelope: AgyInjectEnvelope): never {
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function run(rawInput: string): Promise<AgyInjectEnvelope> {
  let input: AgyHookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return EMPTY_ENVELOPE;
  }

  const workspaceDir = input.workspacePaths?.[0] ?? process.cwd();
  const memoryDir = resolveMemoryDir(workspaceDir);
  const traceId = makeTraceId(input.conversationId);

  // --- Per-turn cache (sharpening 2: build-context is heavy) ---
  const turnKey = input.transcriptPath
    ? countUserTurns(input.transcriptPath)
    : null;
  let cacheFile: string | null = null;
  if (input.conversationId && turnKey !== null) {
    cacheFile = join(
      memoryDir,
      "inject-cache",
      `${sanitiseSessionKey(input.conversationId)}.json`,
    );
    const cached = readCache(cacheFile);
    if (cached && cached.turnKey === turnKey) {
      log(
        "info",
        "agy-pre-invocation",
        "cache-hit",
        {
          memoryDir,
          sessionId: input.conversationId,
          data: { turnKey },
        },
        traceId,
      );
      return cached.envelope;
    }
  }

  const block = await renderLiveBlock(memoryDir);
  if (!block.trim()) {
    log(
      "warn",
      "agy-pre-invocation",
      "empty-block",
      { memoryDir, sessionId: input.conversationId },
      traceId,
    );
    return EMPTY_ENVELOPE;
  }

  const maxChars =
    parseMaxChars(process.env.BRAIN_MAX_INJECTED_CHARS) ??
    MAX_INJECTED_CHARS_DEFAULT;
  const bounded = truncateFromTop(stripAnchors(block), maxChars);

  const envelope: AgyInjectEnvelope = {
    injectSteps: [{ ephemeralMessage: wrapForInjection(bounded) }],
  };

  if (cacheFile && turnKey !== null) {
    writeCache(cacheFile, { turnKey, envelope });
  }

  log(
    "info",
    "agy-pre-invocation",
    "hook-fired",
    {
      memoryDir,
      sessionId: input.conversationId,
      data: { blockChars: bounded.length, maxChars, turnKey },
    },
    traceId,
  );

  return envelope;
}

async function renderLiveBlock(memoryDir: string): Promise<string> {
  const buildContext = join(resolveToolsDir(), "build-context.sh");
  if (!existsSync(buildContext)) {
    throw new Error(`build-context.sh not found at ${buildContext}`);
  }
  const { stdout } = await execFileAsync("bash", [buildContext, "--emit"], {
    env: {
      ...process.env,
      MEMORY_DIR: memoryDir,
      WORKSPACE_DIR: dirname(memoryDir),
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20000,
  });
  return stdout;
}

function readCache(cacheFile: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (
      typeof parsed?.turnKey === "number" &&
      Array.isArray(parsed?.envelope?.injectSteps)
    ) {
      return parsed as CacheEntry;
    }
  } catch {
    /* missing or corrupt cache — render fresh */
  }
  return null;
}

function writeCache(cacheFile: string, entry: CacheEntry): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, cacheFile);
  } catch {
    /* cache write failure is non-fatal — next call re-renders */
  }
}

function stripAnchors(block: string): string {
  return block
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== ANCHOR_START && line.trim() !== ANCHOR_END,
    )
    .join("\n")
    .trim();
}

/** Mirrors core/context-engine/memory-reader.ts truncateFromTop (not exported there). */
function truncateFromTop(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const kept = text.slice(cut);
  return `[...truncated ${cut} chars from top]\n${kept}`;
}

function parseMaxChars(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit(EMPTY_ENVELOPE);
  }
  try {
    emit(await run(raw));
  } catch {
    emit(EMPTY_ENVELOPE);
  }
}

// Only run when invoked as a script (not when imported by tests).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pre-invocation.js") ||
  process.argv[1]?.endsWith("pre-invocation.ts");

if (isMain) {
  void main();
}
