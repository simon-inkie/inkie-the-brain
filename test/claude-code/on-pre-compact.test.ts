import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  statSync,
} from "fs";
import { spawn } from "child_process";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { run } from "../../adapters/claude-code/src/on-pre-compact.js";
import { sessionKeyFor } from "../../adapters/claude-code/src/observe-trigger.js";
import {
  MIN_OBSERVATION_GAP_MS,
  savePointer,
} from "../../core/observer/index.js";

function buildTranscript(turns: number, contentLen = 40): string {
  const lines: string[] = [];
  const base = new Date("2026-04-17T10:00:00Z").getTime();
  for (let i = 0; i < turns; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "u".repeat(contentLen) + ` ${i}` },
        timestamp: new Date(base + i * 60_000).toISOString(),
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "a".repeat(contentLen) + ` ${i}` }],
        },
        timestamp: new Date(base + i * 60_000 + 1000).toISOString(),
      }),
    );
  }
  return lines.join("\n") + "\n";
}

describe("on-pre-compact — force-fire semantics", () => {
  let testDir: string;
  let memoryDir: string;
  let transcriptPath: string;
  let toolsDir: string;
  let observeLog: string;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tb-precompact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    memoryDir = join(testDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    transcriptPath = join(testDir, "transcript.jsonl");

    toolsDir = join(testDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    // OUTSIDE testDir on purpose. observe.sh is spawned detached and keeps
    // writing after run() resolves; a log file inside testDir means the child
    // can recreate an entry under the tree afterEach is deleting, which is an
    // ENOTEMPTY race no retry budget reliably wins.
    observeLog = `${testDir}-observe.log`;
    writeFileSync(
      join(toolsDir, "observe.sh"),
      `#!/bin/bash\necho "fired MEMORY_DIR=$MEMORY_DIR file=$2" >> "${observeLog}"\n`,
    );
    chmodSync(join(toolsDir, "observe.sh"), 0o755);

    process.env.BRAIN_TOOLS_DIR = toolsDir;
    process.env.BRAIN_MEMORY_DIR = memoryDir;
    delete process.env.BRAIN_DEBUG;
    // Clear AGENT_NAME (and USER_NAME) so the tier-0 persona override does not
    // hijack memory resolution to a live agent silo. A real shell usually has
    // AGENT_NAME set, and it resolves ahead of the BRAIN_MEMORY_DIR sandbox
    // above, silently bypassing this test's fixtures.
    delete process.env.AGENT_NAME;
    delete process.env.USER_NAME;
  });

  afterEach(() => {
    // Retries stay as a backstop: the child no longer writes inside testDir
    // (see observeLog above), but it is still detached and unwaited.
    rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(observeLog, { force: true });
    process.env = { ...prevEnv };
  });

  function makeInput(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: "precompact-session",
      transcript_path: transcriptPath,
      cwd: testDir,
      hook_event_name: "PreCompact",
      trigger: "auto",
      ...overrides,
    });
  }

  async function waitForObserveLog(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(observeLog)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("fires even within the cooldown window", async () => {
    writeFileSync(transcriptPath, buildTranscript(3, 40));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
        observationMessageThreshold: 6,
        observationCharThreshold: 10000,
      }),
    );

    const result = await run(makeInput());
    expect(result.fired).toBe(true);
    expect(result.reason).toMatch(/force-fire/);

    const fired = await waitForObserveLog();
    expect(fired).toBe(true);
    expect(readFileSync(observeLog, "utf-8")).toContain(
      `MEMORY_DIR=${memoryDir}`,
    );
  });

  it("fires even below the normal thresholds", async () => {
    // Only 1 turn — well below balanced defaults
    writeFileSync(transcriptPath, buildTranscript(1, 40));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(
          Date.now() - MIN_OBSERVATION_GAP_MS - 1000,
        ).toISOString(),
        observationMessageThreshold: 20,
        observationCharThreshold: 10000,
      }),
    );

    const result = await run(makeInput());
    expect(result.fired).toBe(true);
    expect(await waitForObserveLog()).toBe(true);
  });

  it("does not fire when there is nothing unobserved", async () => {
    writeFileSync(transcriptPath, buildTranscript(4, 40));
    // Pre-seed pointer at EOF so the delta is empty
    const pointersDir = join(memoryDir, "observer-pointers");
    const size = readFileSync(transcriptPath).length;
    const key = sessionKeyFor(testDir, "precompact-session");
    savePointer(pointersDir, {
      sessionKey: key,
      sessionId: "precompact-session",
      transcriptPath,
      lastObservedOffset: size,
      lastObservedTimestamp: new Date().toISOString(),
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    });

    const result = await run(makeInput());
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/no unobserved/);
  });

  it("handles manual trigger identically to auto", async () => {
    writeFileSync(transcriptPath, buildTranscript(2, 40));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date().toISOString(), // just now, within cooldown
      }),
    );

    const result = await run(makeInput({ trigger: "manual" }));
    expect(result.fired).toBe(true);
    // Let the detached observe.sh land before afterEach tears down testDir,
    // matching the other force-fire cases above (avoids an ENOTEMPTY cleanup race).
    expect(await waitForObserveLog()).toBe(true);
  });

  it("fails soft on malformed stdin", async () => {
    const result = await run("not-json{{{");
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// Background-indexer spawn branch.
//
// The suite above only exercises the exported `run()` (observation semantics)
// and never enters `main()`, where the hook spawns `index-messages` for the
// compacting agent. That branch is what these cover, and specifically the
// fail-closed regression review caught: the diagnostic-log setup (`mkdirSync`
// + `openSync` on ~/.the-brain/logs) shared a try block with the spawn, so any
// failure to create or open that log skipped the indexing entirely. Before the
// logging was added, stdio was an unconditional "ignore" and the spawn always
// fired — observability had quietly become a hard prerequisite for the thing
// it observes.
//
// These run the hook as a REAL child process rather than mocking node:fs. The
// failure is injected the way it actually presents on a live box (an ordinary
// file sitting where ~/.the-brain/logs should be a directory), and the
// assertions are on what a live box would see: the indexer process started,
// `{"suppressOutput":true}` on stdout, exit 0. Mocking `openSync` would have
// proven the same thing about a stubbed filesystem only, and the hook's
// stdout/exit contract — the half that keeps compaction unblocked — cannot be
// observed from inside the module at all.
//
// HOME is redirected at a temp dir for both, so nothing here can reach the
// real ~/.the-brain, and the indexer is never actually run: one case shims
// `node` on PATH so it only records its argv, the other empties PATH so the
// spawn cannot resolve `node` at all.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_ENTRY = join(
  REPO_ROOT,
  "adapters",
  "claude-code",
  "src",
  "on-pre-compact.ts",
);
const SPAWN_TEST_AGENT = "precompact-spawn-test";

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the hook end to end as its own process, feeding `payload` on stdin. */
function runHookProcess(
  env: NodeJS.ProcessEnv,
  payload: string,
): Promise<HookRun> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", HOOK_ENTRY], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.end(payload);
  });
}

/** The indexer is detached, so it can land just after the hook exits. */
async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("on-pre-compact — background indexer spawn", () => {
  let fakeHome: string;
  let transcriptPath: string;
  let logsDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "tb-precompact-spawn-"));
    logsDir = join(fakeHome, ".the-brain", "logs");
    transcriptPath = join(fakeHome, "transcript.jsonl");
    // Empty transcript: the observation half returns "no unobserved content"
    // and spawns nothing, leaving the indexer branch as the only spawn.
    writeFileSync(transcriptPath, "");
  });

  afterEach(() => {
    rmSync(fakeHome, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  /**
   * Child env built from scratch rather than inherited: AGENT_NAME, HOME,
   * BRAIN_MEMORY_DIR and BRAIN_ROOT can all be live in the surrounding shell
   * and every one of them would pull the hook back out of the sandbox.
   * BRAIN_ROOT in particular is deleted so `resolveBrainRoot()` falls through
   * to its walk-up from the module's own location, which lands on this
   * checkout — the same resolution a real install performs.
   */
  function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BRAIN_DEBUG;
    delete env.BRAIN_MEMORY_DIR;
    delete env.BRAIN_ROOT;
    // Default is "info"; a level set in the surrounding shell would filter
    // out the spawn-attempt line the second case asserts on.
    delete env.BRAIN_LOG_LEVEL;
    return {
      ...env,
      HOME: fakeHome,
      AGENT_NAME: SPAWN_TEST_AGENT,
      // No observe.sh here, so the observation half cannot fire either.
      BRAIN_TOOLS_DIR: join(fakeHome, "no-tools"),
      ...extra,
    };
  }

  function payload(): string {
    return JSON.stringify({
      session_id: "precompact-spawn-session",
      transcript_path: transcriptPath,
      cwd: fakeHome,
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
  }

  /** A `node` on PATH that records its argv instead of running the indexer. */
  function installNodeShim(): string {
    const shimDir = join(fakeHome, "shim-bin");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "node");
    writeFileSync(
      shim,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "$PRECOMPACT_SPAWN_MARKER"\n`,
    );
    chmodSync(shim, 0o755);
    return shimDir;
  }

  it("still spawns the indexer when the diagnostic log cannot be opened", async () => {
    // An ordinary FILE where ~/.the-brain/logs should be a directory: both
    // mkdirSync (EEXIST) and openSync fail, exactly as they would on a
    // permissions or ownership drift, or on ENOSPC / fd exhaustion.
    mkdirSync(join(fakeHome, ".the-brain"), { recursive: true });
    writeFileSync(logsDir, "not a directory\n");

    const marker = join(fakeHome, "indexer-spawned.txt");
    const shimDir = installNodeShim();

    const result = await runHookProcess(
      hookEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        PRECOMPACT_SPAWN_MARKER: marker,
      }),
      payload(),
    );

    // Positive control: the injected failure really happened. If mkdirSync
    // had somehow succeeded, `logs` would now be a directory and this test
    // would be asserting the happy path under a misleading name.
    expect(statSync(logsDir).isFile()).toBe(true);

    // The regression: with the log setup inside the spawn's try block, the
    // catch swallowed EEXIST and the indexer was never started.
    expect(await waitForFile(marker)).toBe(true);
    expect(readFileSync(marker, "utf-8")).toContain(
      `index-messages --agent ${SPAWN_TEST_AGENT}`,
    );

    // And compaction stays unblocked regardless.
    expect(result.stdout.trim()).toBe('{"suppressOutput":true}');
    expect(result.code).toBe(0);
  });

  it("records a failed indexer spawn in the activity log", async () => {
    // Log setup succeeds here, so the fd path is the one under test.
    mkdirSync(logsDir, { recursive: true });
    // PATH holds one empty directory, so `node` resolves nowhere and the
    // spawn fails ENOENT asynchronously — the case the 150ms window after
    // unref() exists to catch. Without it the process exits first and the
    // failure is never recorded.
    const emptyBin = join(fakeHome, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });

    const result = await runHookProcess(
      hookEnv({ PATH: emptyBin }),
      payload(),
    );

    const activity = readFileSync(
      join(logsDir, "hook-activity.jsonl"),
      "utf-8",
    );
    expect(activity).toContain("index-messages-spawn-attempt");
    expect(activity).toContain("index-messages-spawn-error");
    // The child's stdout/stderr fd was obtained and used, not the "ignore"
    // fallback — openSync(…, "a") creates the file.
    expect(existsSync(join(logsDir, "precompact-index-messages.log"))).toBe(
      true,
    );

    expect(result.stdout.trim()).toBe('{"suppressOutput":true}');
    expect(result.code).toBe(0);
  });
});
