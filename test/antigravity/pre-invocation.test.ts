import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  setupAgyWorkspace,
  teardownAgyWorkspace,
  eventFromFixture,
  runHook,
  waitFor,
  type AgyTestEnv,
} from "./helpers.js";
import type { AgyInjectEnvelope } from "../../adapters/antigravity/src/types.js";

/**
 * Regression harness — PreInvocation injection hook, driven through
 * bin/pre-invocation.sh with recorded agy event fixtures, exactly as agy
 * invokes it.
 */

let env: AgyTestEnv;

beforeEach(async () => {
  env = await setupAgyWorkspace();
});

afterEach(async () => {
  await teardownAgyWorkspace(env);
});

function parseEnvelope(stdout: string): AgyInjectEnvelope {
  return JSON.parse(stdout);
}

describe("agy PreInvocation hook", () => {
  it("emits the wrapped live block as an injectSteps ephemeralMessage", async () => {
    const event = await eventFromFixture("pre-invocation-event.json", env);
    const out = parseEnvelope(runHook("pre-invocation.sh", event, env));

    expect(out.injectSteps).toHaveLength(1);
    const msg = out.injectSteps[0].ephemeralMessage;
    expect(msg).toContain("<the-brain>");
    expect(msg).toContain("</the-brain>");
    expect(msg).toContain("**NOW:");
    expect(msg).toContain("Live Observation Context");
    expect(msg).toContain("Fixture reflection content for the hot zone");
    // Anchors stripped from the injected block
    expect(msg).not.toContain("IO_LIVE_START");
  });

  it("is a pure read: no MEMORY.md splice", async () => {
    const memoryMd = join(env.siloDir, "MEMORY.md");
    const memoryBefore = await readFile(memoryMd, "utf-8");

    const event = await eventFromFixture("pre-invocation-event.json", env);
    runHook("pre-invocation.sh", event, env);

    expect(await readFile(memoryMd, "utf-8")).toBe(memoryBefore);
  });

  it("caches per turn and re-renders when a new user turn lands", async () => {
    const event = await eventFromFixture("pre-invocation-event.json", env);
    const first = runHook("pre-invocation.sh", event, env);

    // New silo content mid-turn must NOT appear (same turnKey = cache hit).
    // mtime pushed into the future: build-context's unprocessed-zone cut is
    // second-granular against the latest reflection mtime, and a warm run
    // can land both writes in the same second.
    const obsFile = join(env.memoryDir, "observations", "2026-06-12-11-00.md");
    await writeFile(obsFile, "MID-TURN-OBSERVATION-MARKER");
    const future = new Date(Date.now() + 60000);
    await utimes(obsFile, future, future);
    const second = runHook("pre-invocation.sh", event, env);
    expect(second).toBe(first);
    expect(second).not.toContain("MID-TURN-OBSERVATION-MARKER");

    // A new USER_INPUT step bumps the turn key -> fresh render
    await appendFile(
      env.transcriptPath,
      JSON.stringify({
        step_index: 6,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-06-12T10:05:00Z",
        content: "<USER_REQUEST>\nnext turn\n</USER_REQUEST>",
      }) + "\n",
    );
    const third = runHook("pre-invocation.sh", event, env);
    expect(third).not.toBe(first);
    expect(third).toContain("MID-TURN-OBSERVATION-MARKER");

    // Cache file lives in the silo, keyed by conversationId
    const cacheRaw = await readFile(
      join(env.memoryDir, "inject-cache", "fixture-conv-1.json"),
      "utf-8",
    );
    expect(JSON.parse(cacheRaw).turnKey).toBe(2);
  });

  it("fails open on malformed stdin", async () => {
    const out = parseEnvelope(runHook("pre-invocation.sh", "this is not json", env));
    expect(out).toEqual({ injectSteps: [] });
  });

  it("fails open when the silo is broken (missing live-state.json)", async () => {
    await rm(join(env.memoryDir, "live-state.json"));
    const event = await eventFromFixture("pre-invocation-event.json", env);
    const out = parseEnvelope(runHook("pre-invocation.sh", event, env));
    expect(out).toEqual({ injectSteps: [] });
  });

  it("renders without caching when the transcript is unreadable", async () => {
    const event = (await eventFromFixture("pre-invocation-event.json", env)).replace(
      env.transcriptPath,
      join(env.testDir, "no-such-transcript.jsonl"),
    );
    const out = parseEnvelope(runHook("pre-invocation.sh", event, env));
    expect(out.injectSteps).toHaveLength(1);
    const exists = await waitFor(
      async () => {
        try {
          await readFile(join(env.memoryDir, "inject-cache", "fixture-conv-1.json"));
          return true;
        } catch {
          return false;
        }
      },
      500,
    );
    expect(exists).toBe(false);
  });
});
