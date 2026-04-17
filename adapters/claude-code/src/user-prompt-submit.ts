/**
 * greymatter — Claude Code UserPromptSubmit hook handler.
 *
 * Injects the MEMORY.md IO_LIVE block as `additionalContext` on every prompt
 * so the model sees curated long-term memory, even right after a /compact.
 *
 * Fail-open: any error → emit empty additionalContext + exit 0. We never
 * block the user's prompt over a memory-read failure.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Best-effort env load. Claude Code hooks run in a sandboxed env that doesn't
// inherit the user's shell vars.
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

import { readInjectedMemoryBlock } from "../../../core/context-engine/memory-reader.js";
import { resolveMemoryDir, memoryFilePath } from "./memory-root.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

const MAX_INJECTED_CHARS_DEFAULT = 40000;

function emit(additionalContext: string): never {
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
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

export async function run(rawInput: string): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return "";
  }

  const projectDir = input.cwd ?? process.cwd();
  const memoryDir = resolveMemoryDir(projectDir);
  const memFile = memoryFilePath(memoryDir);

  const maxChars =
    parseMaxChars(process.env.GREYMATTER_MAX_INJECTED_CHARS) ??
    MAX_INJECTED_CHARS_DEFAULT;

  const block = await readInjectedMemoryBlock({
    memoryBlockSource: "file",
    memoryFile: memFile,
    maxInjectedChars: maxChars,
    debug: process.env.GREYMATTER_DEBUG === "1",
  });

  if (!block.trim()) return "";

  return wrapForInjection(block);
}

function parseMaxChars(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function wrapForInjection(block: string): string {
  return `<greymatter-memory>\n${block}\n</greymatter-memory>`;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit("");
  }

  try {
    const ctx = await run(raw);
    emit(ctx);
  } catch {
    emit("");
  }
}

// Only run when invoked as a script (not when imported by tests).
// import.meta.url check works under both tsx and bundled Node execution.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("user-prompt-submit.js") ||
  process.argv[1]?.endsWith("user-prompt-submit.ts");

if (isMain) {
  void main();
}
