/**
 * Shared fixture-workspace builder for the antigravity adapter tests.
 *
 * Builds a temp HOME with a tagent silo (memory + anchored MEMORY.md), a
 * tools dir holding the real build-context.sh plus stubs for
 * everything that would call out (compress-era.sh, observe.sh, _log.sh),
 * and a copy of the recorded agy transcript fixture. The bin/ hook entries
 * are run as real subprocesses with stdin piped, exactly as agy invokes
 * them.
 */

import { mkdir, writeFile, readFile, copyFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AGENT = "tagent";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURES_DIR = join(REPO_ROOT, "test", "fixtures", "agy-workspace");
const BUILD_CONTEXT_SH = join(
  REPO_ROOT,
  "adapters",
  "openclaw",
  "hooks",
  "memory-tools",
  "build-context.sh",
);
const BIN_DIR = join(REPO_ROOT, "adapters", "antigravity", "bin");

export interface AgyTestEnv {
  testDir: string;
  siloDir: string;
  memoryDir: string;
  toolsDir: string;
  workspaceDir: string;
  transcriptPath: string;
  observeCallsLog: string;
  observeInputLog: string;
}

export async function setupAgyWorkspace(): Promise<AgyTestEnv> {
  const testDir = join(
    tmpdir(),
    `tb-agy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const siloDir = join(testDir, ".the-brain", "agents", AGENT);
  const memoryDir = join(siloDir, "memory");
  const toolsDir = join(testDir, "tools");
  const workspaceDir = join(testDir, "ws");

  await mkdir(join(memoryDir, "observations"), { recursive: true });
  await mkdir(join(memoryDir, "reflections"), { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  // Real build-context.sh + stubs for its callees
  await copyFile(BUILD_CONTEXT_SH, join(toolsDir, "build-context.sh"));
  await chmod(join(toolsDir, "build-context.sh"), 0o755);
  await writeFile(join(toolsDir, "_log.sh"), "log() { :; }\n");
  await writeFile(join(toolsDir, "compress-era.sh"), "#!/bin/bash\ntrue\n");
  await chmod(join(toolsDir, "compress-era.sh"), 0o755);

  // observe.sh stub — records each invocation + the observation input
  const observeCallsLog = join(testDir, "observe-calls.log");
  const observeInputLog = join(testDir, "observe-input.log");
  await writeFile(
    join(toolsDir, "observe.sh"),
    `#!/bin/bash\necho "called $@" >> "${observeCallsLog}"\ncat "$2" >> "${observeInputLog}"\n`,
  );
  await chmod(join(toolsDir, "observe.sh"), 0o755);

  // Silo state
  await writeFile(
    join(memoryDir, "live-state.json"),
    JSON.stringify({
      hotReflectionCount: 3,
      eraCompressionLevel: 0,
      softBudgetChars: 50000,
      hardBudgetChars: 80000,
      minHotReflectionCount: 1,
      maxEraCompressionLevel: 3,
      eraCoverageThroughReflectionDate: null,
      lastBlockCharCount: 0,
      lastRebuildAt: null,
    }),
  );
  await writeFile(join(memoryDir, "era-summary.md"), "");
  await writeFile(
    join(memoryDir, "reflections", "2026-06-10.md"),
    "Fixture reflection content for the hot zone",
  );

  // Anchored MEMORY.md (workspace for build-context = dirname(memoryDir))
  await writeFile(
    join(siloDir, "MEMORY.md"),
    ["<!-- IO_LIVE_START -->", "stale spliced content", "<!-- IO_LIVE_END -->", ""].join("\n"),
  );

  // Recorded transcript fixture, copied so tests can append to it
  const transcriptPath = join(testDir, "transcript.jsonl");
  await copyFile(join(FIXTURES_DIR, "transcript.jsonl"), transcriptPath);

  return {
    testDir,
    siloDir,
    memoryDir,
    toolsDir,
    workspaceDir,
    transcriptPath,
    observeCallsLog,
    observeInputLog,
  };
}

export async function teardownAgyWorkspace(env: AgyTestEnv): Promise<void> {
  await rm(env.testDir, { recursive: true, force: true });
}

/** Read a recorded event fixture and point it at this test workspace. */
export async function eventFromFixture(
  name: "pre-invocation-event.json" | "stop-event.json",
  env: AgyTestEnv,
): Promise<string> {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf-8");
  return raw
    .replaceAll("__TRANSCRIPT__", env.transcriptPath)
    .replaceAll("__WORKSPACE__", env.workspaceDir);
}

/** Pipe stdin into a bin/ hook entry exactly as agy would. */
export function runHook(
  script: "pre-invocation.sh" | "on-stop.sh",
  stdin: string,
  env: AgyTestEnv,
): string {
  return execFileSync("bash", [join(BIN_DIR, script)], {
    input: stdin,
    env: {
      ...process.env,
      HOME: env.testDir,
      AGENT_NAME: AGENT,
      BRAIN_TOOLS_DIR: env.toolsDir,
      // HOME is a fresh temp dir, so npx (tsx fallback in bin/) would print
      // update-notifier noise into the captured stderr without this.
      npm_config_update_notifier: "false",
    },
    timeout: 60000,
  }).toString();
}

/** Poll for an async side effect of a detached spawn. */
export async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return cond();
}
