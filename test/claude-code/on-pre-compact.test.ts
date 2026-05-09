import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "fs";
import { join } from "path";
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
    observeLog = join(testDir, "observe.log");
    writeFileSync(
      join(toolsDir, "observe.sh"),
      `#!/bin/bash\necho "fired MEMORY_DIR=$MEMORY_DIR file=$2" >> "${observeLog}"\n`,
    );
    chmodSync(join(toolsDir, "observe.sh"), 0o755);

    process.env.BRAIN_TOOLS_DIR = toolsDir;
    process.env.BRAIN_MEMORY_DIR = memoryDir;
    delete process.env.BRAIN_DEBUG;
    delete process.env.AGENT_NAME;
    delete process.env.USER_NAME;
  });

  afterEach(() => {
    // observe.sh spawns detached and may still be writing files to testDir
    // when this fires — maxRetries handles the ENOTEMPTY race.
    rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  });

  it("fails soft on malformed stdin", async () => {
    const result = await run("not-json{{{");
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/malformed/);
  });
});
