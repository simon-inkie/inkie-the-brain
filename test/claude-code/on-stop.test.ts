import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { run, sessionKeyFor } from "../../adapters/claude-code/src/on-stop.js";
import {
  loadPointer,
  savePointer,
} from "../../core/observer/index.js";

/**
 * Build a Claude Code-style transcript JSONL with N user+assistant pairs.
 */
function buildTranscript(turns: number, contentLen = 40): string {
  const lines: string[] = [];
  // Use a recent base — old hardcoded date would trigger the age-threshold
  // (oldest unobserved message age >= maxAgeMs) on tests that expect "below
  // thresholds". Keep timestamps within the same minute as 'now'.
  const base = Date.now() - turns * 60_000;
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

describe("on-stop — run() (compact-only observation / session-flush)", () => {
  let testDir: string;
  let memoryDir: string;
  let pointersDir: string;
  let transcriptPath: string;
  let toolsDir: string;
  let observeLog: string;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tb-on-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    memoryDir = join(testDir, "memory");
    pointersDir = join(memoryDir, "observer-pointers");
    mkdirSync(memoryDir, { recursive: true });
    transcriptPath = join(testDir, "transcript.jsonl");

    // Build a mock observe.sh that just logs its invocation.
    toolsDir = join(testDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    // OUTSIDE testDir on purpose: observe.sh is spawned detached and may write
    // after afterEach has started deleting testDir (ENOTEMPTY race).
    observeLog = `${testDir}-observe.log`;
    writeFileSync(
      join(toolsDir, "observe.sh"),
      `#!/bin/bash\necho "fired MEMORY_DIR=$MEMORY_DIR file=$2" >> "${observeLog}"\n`,
    );
    // Must be executable for spawn
    require("fs").chmodSync(join(toolsDir, "observe.sh"), 0o755);

    process.env.BRAIN_TOOLS_DIR = toolsDir;
    // Prevent resolver from finding a real ~/.the-brain/memory.
    // Clear AGENT_NAME so tier-0 persona override doesn't route to the live silo.
    process.env.BRAIN_MEMORY_DIR = memoryDir;
    delete process.env.BRAIN_DEBUG;
    delete process.env.AGENT_NAME;
    delete process.env.USER_NAME;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(observeLog, { force: true });
    process.env = { ...prevEnv };
  });

  function makeInput(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: "test-session",
      transcript_path: transcriptPath,
      cwd: testDir,
      hook_event_name: "Stop",
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

  // ── Basic guard cases ────────────────────────────────────────────────────

  it("returns reason when transcript_path missing", async () => {
    const result = await run(
      JSON.stringify({ session_id: "s", cwd: testDir }),
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/transcript_path/);
  });

  it("returns reason when session_id missing", async () => {
    const result = await run(
      JSON.stringify({ transcript_path: transcriptPath, cwd: testDir }),
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/session_id/);
  });

  it("returns malformed when stdin is not JSON", async () => {
    const result = await run("not json{{{}");
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/malformed/);
  });

  // ── Flush conditions ─────────────────────────────────────────────────────

  it("no-op when no pointer exists (session not yet started)", async () => {
    // No pointer file written — fresh session with no accumulation.
    writeFileSync(transcriptPath, buildTranscript(4, 40));
    const result = await run(makeInput());
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/no pointer/);
  });

  it("no-op when pointer has already been observed (lastObservedTimestamp set)", async () => {
    // Session already has a prior observation — subsequent Stops should no-op.
    writeFileSync(transcriptPath, buildTranscript(4, 40));
    const key = sessionKeyFor(testDir, "test-session");
    const transcriptSize = require("fs").statSync(transcriptPath).size;
    savePointer(pointersDir, {
      sessionKey: key,
      sessionId: "test-session",
      transcriptPath,
      lastObservedOffset: transcriptSize,
      lastObservedTimestamp: new Date().toISOString(), // already observed
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    });

    const result = await run(makeInput());
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/already observed/);
  });

  it("no-op when pointer exists but no unobserved content (offset at EOF)", async () => {
    // Pointer exists with null lastObservedTimestamp but offset is at EOF — nothing to flush.
    writeFileSync(transcriptPath, buildTranscript(2, 40));
    const key = sessionKeyFor(testDir, "test-session");
    const transcriptSize = require("fs").statSync(transcriptPath).size;
    savePointer(pointersDir, {
      sessionKey: key,
      sessionId: "test-session",
      transcriptPath,
      lastObservedOffset: transcriptSize, // already at EOF
      lastObservedTimestamp: null,         // never formally observed
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    });

    const result = await run(makeInput());
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/no unobserved content/);
  });

  it("fires once (force=true, session-flush) when pointer exists, null timestamp, unobserved content", async () => {
    // The flush condition: pointer exists (session ran), never observed, content waiting.
    writeFileSync(transcriptPath, buildTranscript(3, 40));
    const key = sessionKeyFor(testDir, "test-session");
    savePointer(pointersDir, {
      sessionKey: key,
      sessionId: "test-session",
      transcriptPath,
      lastObservedOffset: 0,    // content starts from beginning
      lastObservedTimestamp: null, // never observed
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    });

    const result = await run(makeInput());
    expect(result.fired).toBe(true);
    expect(result.reason).toMatch(/force-fire/);
    expect(result.reason).toMatch(/session-flush|6 msgs/);

    // Detached spawn → wait for observe.sh log
    const fired = await waitForObserveLog();
    expect(fired).toBe(true);
  });

  it("after flush, pointer lastObservedTimestamp is set — subsequent Stop no-ops", async () => {
    // After the flush fires, the pointer is updated with a timestamp.
    // A second Stop call should no-op.
    writeFileSync(transcriptPath, buildTranscript(3, 40));
    const key = sessionKeyFor(testDir, "test-session");
    savePointer(pointersDir, {
      sessionKey: key,
      sessionId: "test-session",
      transcriptPath,
      lastObservedOffset: 0,
      lastObservedTimestamp: null,
      messagesSinceLastObservation: 0,
      charsSinceLastObservation: 0,
    });

    const first = await run(makeInput());
    expect(first.fired).toBe(true);
    await waitForObserveLog();

    // Pointer should now have a timestamp set — second call should no-op.
    const pointer = loadPointer(pointersDir, key);
    expect(pointer?.lastObservedTimestamp).not.toBeNull();

    const second = await run(makeInput());
    expect(second.fired).toBe(false);
    expect(second.reason).toMatch(/already observed/);
  });
});

describe("sessionKeyFor", () => {
  // The implementation deliberately ignores projectDir (kept in the signature
  // for back-compat) — including it caused pointer fragmentation when an
  // agent cd'd between worktrees mid-session. See observe-trigger.ts.
  it("returns cc:<sessionId>, ignoring projectDir", () => {
    expect(sessionKeyFor("/home/test-user/projects/the-brain", "abc123")).toBe(
      "cc:abc123",
    );
  });

  it("returns the same key regardless of projectDir", () => {
    expect(sessionKeyFor("/tmp/proj", "s1")).toBe("cc:s1");
    expect(sessionKeyFor("/totally/different", "s1")).toBe("cc:s1");
  });
});
