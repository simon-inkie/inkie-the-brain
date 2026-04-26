/**
 * the-brain — Claude Code PreCompact hook handler.
 *
 * Fires just before Claude Code compacts conversation context. Forces an
 * observation pass regardless of cooldown or thresholds — compaction is
 * about to destroy detail, so we capture whatever unobserved material is
 * in the transcript right now. Also handles the `"manual"` trigger from
 * `/compact` to cover the same ground.
 *
 * Fail-open: any error → no observation + exit 0. Never blocks compaction.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import { spawn } from "node:child_process";

import {
  runObservation,
  type HookInput,
  type TriggerResult,
} from "./observe-trigger.js";

export async function run(rawInput: string): Promise<TriggerResult> {
  let input: HookInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { fired: false, reason: "malformed stdin" };
  }
  return runObservation(input, { force: true, label: "precompact" });
}

interface PreCompactOutput {
  suppressOutput: true;
}

function emit(): never {
  const output: PreCompactOutput = { suppressOutput: true };
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
        `[the-brain/on-pre-compact] fired=${result.fired} reason=${result.reason}`,
      );
    }
  } catch (err) {
    if (process.env.BRAIN_DEBUG === "1") {
      console.error(
        `[the-brain/on-pre-compact] error: ${(err as Error).message}`,
      );
    }
  }

  // Index current agent's CC conversations in background before context is lost
  const agentName = process.env.AGENT_NAME;
  if (agentName) {
    try {
      const brainRoot = resolve(homedir(), "io-projects", "the-brain");
      const child = spawn(
        "node",
        ["--import", "tsx/esm", "cli/index.ts", "index-messages", "--agent", agentName],
        {
          cwd: brainRoot,
          detached: true,
          stdio: "ignore",
          env: { ...process.env },
        },
      );
      child.unref();
    } catch {
      // fail-open
    }
  }

  emit();
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("on-pre-compact.js") ||
  process.argv[1]?.endsWith("on-pre-compact.ts");

if (isMain) {
  void main();
}
