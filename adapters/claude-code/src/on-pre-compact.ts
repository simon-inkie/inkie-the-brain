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

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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

/**
 * Locate a the-brain checkout that can run `cli/index.ts`, or null.
 * BRAIN_ROOT wins; otherwise walk up from this module looking for the CLI.
 */
function resolveBrainRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.BRAIN_ROOT) candidates.push(process.env.BRAIN_ROOT);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // checkout: adapters/claude-code/src/ -> three levels up
    candidates.push(resolve(here, "..", "..", ".."));
  } catch {
    /* no module URL (bundled in an odd way) — fall through */
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "cli", "index.ts"))) return candidate;
  }
  return null;
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

  // Index the current agent's conversations in the background before context is
  // lost. This runs the-brain's own CLI from source (via tsx), so it needs the
  // checkout rather than the installed adapter. BRAIN_ROOT names it explicitly;
  // otherwise derive it from this module's own location, which holds when the
  // adapter is run straight from a checkout. If neither yields a tree with
  // cli/index.ts, skip: background indexing is best-effort and must never block
  // compaction.
  const agentName = process.env.AGENT_NAME;
  if (agentName) {
    try {
      const brainRoot = resolveBrainRoot();
      if (!brainRoot) {
        emit();
      }
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
