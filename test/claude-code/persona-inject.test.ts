import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * persona-inject SessionStart hook.
 *
 * The hook reads ~/agents/<name>/CORE.md and emits it inline plus a forceful
 * first-action read wrapper, guarding on a 9,500-byte cap. We drive it as a
 * real subprocess with a temp HOME holding a fixture agent dir, exactly as a
 * Claude Code SessionStart invocation would.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOOK = join(
  REPO_ROOT,
  "adapters",
  "claude-code",
  "hooks",
  "persona-inject.sh",
);

const AGENT = "tagent";
const CORE_MARKER = "TAGENT-CORE-SENTINEL-LINE";
const OVERSIZED_MARKER = "TAGENT-OVERSIZED-SENTINEL";

interface Env {
  home: string;
  agentDir: string;
  coreFile: string;
  logFile: string;
}

let env: Env;

beforeEach(async () => {
  const home = join(
    tmpdir(),
    `tb-persona-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const agentDir = join(home, "agents", AGENT);
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  env = {
    home,
    agentDir,
    coreFile: join(agentDir, "CORE.md"),
    logFile: join(home, ".claude", "persona-inject.log"),
  };
});

afterEach(async () => {
  await rm(env.home, { recursive: true, force: true });
});

/** Run the hook with a chosen HOME / AGENT_NAME / one-shot flag. */
function runHook(opts: { agentName?: string; oneShot?: boolean } = {}): string {
  const childEnv: Record<string, string> = {
    ...process.env,
    HOME: env.home,
  };
  delete childEnv.AGENT_NAME;
  if (opts.agentName) childEnv.AGENT_NAME = opts.agentName;
  if (opts.oneShot) childEnv.BRAIN_ONE_SHOT_SESSION = "1";
  return execFileSync("bash", [HOOK], {
    input: "",
    env: childEnv,
    timeout: 30000,
  }).toString();
}

function additionalContext(out: string): string {
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return parsed.hookSpecificOutput.additionalContext as string;
}

async function readLog(): Promise<string> {
  try {
    return await readFile(env.logFile, "utf-8");
  } catch {
    return "";
  }
}

describe("persona-inject SessionStart hook", () => {
  it("CORE present + under cap -> emits CORE + wrapper inline, assembled < 9,500 bytes", async () => {
    await writeFile(
      env.coreFile,
      `# fixture CORE\n${CORE_MARKER}\nsome distilled persona content\n`,
    );

    const out = runHook({ agentName: AGENT });
    const ac = additionalContext(out);

    // CORE content present
    expect(ac).toContain(CORE_MARKER);
    // First-action wrapper present, with the lean read-list as absolute paths
    expect(ac).toContain("FIRST ACTION THIS SESSION");
    expect(ac).toContain(join(env.home, "agents", "SYSTEM.md"));
    expect(ac).toContain(join(env.home, "agents", "ROSTER.md"));
    expect(ac).toContain(join(env.agentDir, "SOUL.md"));
    expect(ac).toContain(join(env.agentDir, "IDENTITY.md"));
    expect(ac).toContain(join(env.agentDir, "TOOLS.md"));
    expect(ac).toContain(join(env.agentDir, "USER.md"));
    // Under cap
    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(9500);

    expect(await readLog()).toContain("branch=core");
  });

  it("CORE missing -> emits wrapper alone + loud log, exit 0, no truncated CORE", async () => {
    // No CORE.md written.
    const out = runHook({ agentName: AGENT });
    const ac = additionalContext(out);

    expect(ac).toContain("FIRST ACTION THIS SESSION");
    expect(ac).toContain(join(env.agentDir, "SOUL.md"));
    expect(ac).not.toContain(CORE_MARKER);
    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(9500);

    const log = await readLog();
    expect(log).toContain("LOUD");
    expect(log).toContain("CORE.md missing");
  });

  it("CORE oversized -> emits wrapper alone (NOT the truncated CORE) + loud log", async () => {
    // Build a CORE well over the 9,500-byte cap.
    const big = `${OVERSIZED_MARKER}\n` + "x".repeat(12000) + "\n";
    await writeFile(env.coreFile, big);

    const out = runHook({ agentName: AGENT });
    const ac = additionalContext(out);

    // The wrapper is emitted, the oversized CORE is NOT (not even truncated)
    expect(ac).toContain("FIRST ACTION THIS SESSION");
    expect(ac).not.toContain(OVERSIZED_MARKER);
    expect(ac).not.toContain("xxxxxxxxxx");
    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(9500);

    const log = await readLog();
    expect(log).toContain("LOUD");
    expect(log).toContain("CORE too big");
  });

  it("no AGENT_NAME -> emits empty additionalContext (gate intact)", () => {
    const out = runHook({});
    expect(additionalContext(out)).toBe("");
  });

  it("one-shot session -> emits empty additionalContext (gate intact)", () => {
    const out = runHook({ agentName: AGENT, oneShot: true });
    expect(additionalContext(out)).toBe("");
  });

  it("no agent dir -> emits empty additionalContext (gate intact)", () => {
    const out = runHook({ agentName: "nonexistent-agent" });
    expect(additionalContext(out)).toBe("");
  });
});
