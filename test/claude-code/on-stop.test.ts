import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { run, sessionKeyFor } from "../../adapters/claude-code/src/on-stop.js";
import {
  MIN_OBSERVATION_GAP_MS,
  loadPointer,
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

describe("on-stop — run()", () => {
  let testDir: string;
  let memoryDir: string;
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
    mkdirSync(memoryDir, { recursive: true });
    transcriptPath = join(testDir, "transcript.jsonl");

    // Build a mock observe.sh that just logs its invocation.
    toolsDir = join(testDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    observeLog = join(testDir, "observe.log");
    writeFileSync(
      join(toolsDir, "observe.sh"),
      `#!/bin/bash\necho "fired MEMORY_DIR=$MEMORY_DIR file=$2" >> "${observeLog}"\n`,
    );
    // Must be executable for spawn
    require("fs").chmodSync(join(toolsDir, "observe.sh"), 0o755);

    process.env.BRAIN_TOOLS_DIR = toolsDir;
    // Prevent resolver from finding a real ~/.the-brain/memory
    process.env.BRAIN_MEMORY_DIR = memoryDir;
    delete process.env.BRAIN_DEBUG;
    delete process.env.AGENT_NAME;
    delete process.env.USER_NAME;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
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

  it("does not fire below thresholds", async () => {
    // 2 turns * 40 chars ~= 160 chars, below balanced default of 500
    writeFileSync(transcriptPath, buildTranscript(2, 40));
    // Seed observer-state so we're past cooldown and use strict thresholds
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
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/below thresholds/);
  });

  it("fires when over message threshold, spawns observe.sh with MEMORY_DIR", async () => {
    writeFileSync(transcriptPath, buildTranscript(8, 40));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(
          Date.now() - MIN_OBSERVATION_GAP_MS - 1000,
        ).toISOString(),
        observationMessageThreshold: 6,
        observationCharThreshold: 10000,
      }),
    );

    const result = await run(makeInput());
    expect(result.fired).toBe(true);
    expect(result.reason).toMatch(/16 msgs/);

    // Detached spawn → wait for observe.sh log
    const fired = await waitForObserveLog();
    expect(fired).toBe(true);
    const log = readFileSync(observeLog, "utf-8");
    expect(log).toContain(`MEMORY_DIR=${memoryDir}`);
    expect(log).toContain("file=/tmp/tb-obs-");
  });

  it("advances pointer after firing", async () => {
    writeFileSync(transcriptPath, buildTranscript(8, 40));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(
          Date.now() - MIN_OBSERVATION_GAP_MS - 1000,
        ).toISOString(),
        observationMessageThreshold: 6,
      }),
    );

    await run(makeInput());
    await waitForObserveLog();

    const key = sessionKeyFor(testDir, "test-session");
    const pointer = loadPointer(join(memoryDir, "observer-pointers"), key);
    expect(pointer).not.toBeNull();
    expect(pointer!.lastObservedOffset).toBeGreaterThan(0);
    expect(pointer!.lastObservedTimestamp).not.toBeNull();
  });

  it("does not fire within cooldown window", async () => {
    writeFileSync(transcriptPath, buildTranscript(20, 100));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
        observationMessageThreshold: 6,
      }),
    );

    const result = await run(makeInput());
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/cooldown/);
  });

  it("second Stop with no new turns does not re-observe the same content", async () => {
    writeFileSync(transcriptPath, buildTranscript(8, 40));
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(
          Date.now() - MIN_OBSERVATION_GAP_MS - 1000,
        ).toISOString(),
        observationMessageThreshold: 6,
      }),
    );

    const first = await run(makeInput());
    expect(first.fired).toBe(true);
    await waitForObserveLog();

    // Reset cooldown so only the pointer gates us
    writeFileSync(
      join(memoryDir, "observer-state.json"),
      JSON.stringify({
        lastObservationAt: new Date(
          Date.now() - MIN_OBSERVATION_GAP_MS - 1000,
        ).toISOString(),
        observationMessageThreshold: 6,
      }),
    );

    const second = await run(makeInput());
    // No new content since last observation → no messages to fire on
    expect(second.fired).toBe(false);
    expect(second.reason).toMatch(/no messages|below thresholds/);
  });
});

describe("sessionKeyFor", () => {
  // The implementation deliberately ignores projectDir (kept in the signature
  // for back-compat) — including it caused pointer fragmentation when an
  // agent cd'd between worktrees mid-session. See observe-trigger.ts.
  it("returns cc:<sessionId>, ignoring projectDir", () => {
    expect(sessionKeyFor("/home/test-user/io-projects/the-brain", "abc123")).toBe(
      "cc:abc123",
    );
  });

  it("returns the same key regardless of projectDir", () => {
    expect(sessionKeyFor("/tmp/proj", "s1")).toBe("cc:s1");
    expect(sessionKeyFor("/totally/different", "s1")).toBe("cc:s1");
  });
});
