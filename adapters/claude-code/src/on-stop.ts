/**
 * the-brain — Claude Code Stop hook handler.
 *
 * Fires after each assistant turn. Delegates to observe-trigger with
 * force=false, so the cooldown + three-trigger OR logic from core/observer
 * gates whether observe.sh actually runs.
 *
 * Fail-open: any error → no observation + exit 0. Never blocks the agent.
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

import {
  runObservation,
  sessionKeyFor,
  type HookInput,
  type TriggerResult,
} from "./observe-trigger.js";

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
  return runObservation(input, { force: false, label: "obs" });
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
