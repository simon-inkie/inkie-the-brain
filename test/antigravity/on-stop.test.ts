import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  setupAgyWorkspace,
  teardownAgyWorkspace,
  eventFromFixture,
  runHook,
  waitFor,
  type AgyTestEnv,
} from "./helpers.js";

/**
 * Regression harness — Stop hook observe, driven through bin/on-stop.sh with
 * recorded agy event fixtures. The observe pipeline and the turn-end
 * build-context refresh are detached spawns, so the side-effect assertions
 * poll.
 */

let env: AgyTestEnv;

beforeEach(async () => {
  env = await setupAgyWorkspace();
});

afterEach(async () => {
  await teardownAgyWorkspace(env);
});

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

describe("agy Stop hook", () => {
  it("observes the transcript delta: user + assistant only, noise and malformed lines skipped", async () => {
    const event = await eventFromFixture("stop-event.json", env);
    const out = runHook("on-stop.sh", event, env);
    expect(JSON.parse(out)).toEqual({});

    // observe.sh stub is spawned detached — poll for the recorded call
    expect(
      await waitFor(async () => (await readOrNull(env.observeCallsLog)) !== null),
    ).toBe(true);
    const calls = (await readFile(env.observeCallsLog, "utf-8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--file");

    const observed = await readFile(env.observeInputLog, "utf-8");
    // User request extracted from the <USER_REQUEST> wrapper
    expect(observed).toContain("the-brain-watcher unit keeps restarting");
    expect(observed).toContain("User:");
    // Assistant planner response captured
    expect(observed).toContain("exit code 203");
    expect(observed).toContain("Assistant:");
    // Tool steps + agy prompt scaffolding excluded
    expect(observed).not.toContain("TOOL-NOISE-MARKER");
    expect(observed).not.toContain("ADDITIONAL_METADATA");
    expect(observed).not.toContain("USER_SETTINGS_CHANGE");
  });

  it("persists a per-conversation cursor and does not re-observe on the next stop", async () => {
    const event = await eventFromFixture("stop-event.json", env);
    runHook("on-stop.sh", event, env);
    await waitFor(async () => (await readOrNull(env.observeCallsLog)) !== null);

    const pointerPath = join(
      env.memoryDir,
      "observer-pointers",
      "agy-fixture-conv-1.json",
    );
    const pointer = JSON.parse(await readFile(pointerPath, "utf-8"));
    expect(pointer.sessionKey).toBe("agy:fixture-conv-1");
    expect(pointer.lastObservedOffset).toBeGreaterThan(0);

    // Second stop with no new transcript content: cursor is at EOF, no fire
    runHook("on-stop.sh", event, env);
    await new Promise((r) => setTimeout(r, 1000));
    const calls = (await readFile(env.observeCallsLog, "utf-8")).trim().split("\n");
    expect(calls).toHaveLength(1);
  });

  it("refreshes the silo MEMORY.md splice at turn end via the build-context path", async () => {
    const memoryMd = join(env.siloDir, "MEMORY.md");
    expect(await readFile(memoryMd, "utf-8")).toContain("stale spliced content");

    const event = await eventFromFixture("stop-event.json", env);
    runHook("on-stop.sh", event, env);

    // build-context.sh is spawned detached — poll for the splice.
    expect(
      await waitFor(async () =>
        ((await readOrNull(memoryMd)) ?? "").includes("Live Observation Context"),
      ),
    ).toBe(true);
    const after = await readFile(memoryMd, "utf-8");
    expect(after).not.toContain("stale spliced content");
  });

  it("fails open on malformed stdin", async () => {
    const out = runHook("on-stop.sh", "not json at all", env);
    expect(JSON.parse(out)).toEqual({});
  });

  it("fails open when the transcript path does not exist", async () => {
    const event = (await eventFromFixture("stop-event.json", env)).replace(
      env.transcriptPath,
      join(env.testDir, "gone.jsonl"),
    );
    const out = runHook("on-stop.sh", event, env);
    expect(JSON.parse(out)).toEqual({});
  });
});
