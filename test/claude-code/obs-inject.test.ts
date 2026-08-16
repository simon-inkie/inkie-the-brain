import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * obs-inject SessionStart hook belt-and-braces cap guard.
 *
 * The hook emits the cached three-zone observation block from build-context
 * --cached as additionalContext. build-context already hard-caps that block,
 * but the hook must not trust that blindly: if the cached block ever exceeds
 * the emit ceiling, emitting it as-is lets Claude Code silently truncate
 * anything over 10,000 chars to a ~2KB stub. The guard
 * tail-truncates to whole lines and appends a visible marker instead.
 *
 * Driven as a real subprocess with a temp HOME holding a fixture memory dir
 * and a stub build-context.sh, exactly as persona-inject.test.ts drives
 * persona-inject.sh.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOOK = join(REPO_ROOT, "adapters", "claude-code", "hooks", "obs-inject.sh");

const AGENT = "toagent";
const HEAD_MARKER = "TOAGENT-OBS-HEAD-SENTINEL";
const TAIL_MARKER = "TOAGENT-OBS-TAIL-SENTINEL";

interface Env {
  home: string;
  memoryDir: string;
  buildContextScript: string;
  fixtureFile: string;
  logFile: string;
}

let env: Env;

beforeEach(async () => {
  const home = join(
    tmpdir(),
    `tb-obsinject-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const memoryDir = join(home, ".the-brain", "agents", AGENT, "memory");
  const buildContextDir = join(home, "hooks", "memory-tools");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(buildContextDir, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });

  const buildContextScript = join(buildContextDir, "build-context.sh");
  const fixtureFile = join(home, "obs-fixture.txt");

  // Stub build-context.sh: ignore all args, cat a fixture file the test
  // controls. Written per-test so each case can point at a different fixture.
  await writeFile(
    buildContextScript,
    `#!/usr/bin/env bash\ncat "${fixtureFile}"\n`,
  );
  await chmod(buildContextScript, 0o755);

  env = {
    home,
    memoryDir,
    buildContextScript,
    fixtureFile,
    logFile: join(home, ".claude", "obs-inject.log"),
  };
});

afterEach(async () => {
  await rm(env.home, { recursive: true, force: true });
});

/** Run the hook with a chosen HOME / AGENT_NAME / flag combination. */
function runHook(
  opts: {
    agentName?: string;
    viaSessionStart?: boolean;
    oneShot?: boolean;
    noMemoryDir?: boolean;
    emitCeiling?: string;
  } = {},
): string {
  const childEnv: Record<string, string> = {
    ...process.env,
    HOME: env.home,
  };
  delete childEnv.AGENT_NAME;
  delete childEnv.BRAIN_OBS_VIA_SESSIONSTART;
  delete childEnv.BRAIN_ONE_SHOT_SESSION;
  delete childEnv.BRAIN_OBS_EMIT_CEILING;

  // The hook resolves build-context.sh relative to its own location, which in
  // a checkout is the REAL script. Point it at the stub instead, which is what
  // BRAIN_BUILD_CONTEXT exists for.
  childEnv.BRAIN_BUILD_CONTEXT = env.buildContextScript;

  if (opts.agentName) childEnv.AGENT_NAME = opts.agentName;
  if (opts.viaSessionStart) childEnv.BRAIN_OBS_VIA_SESSIONSTART = "1";
  if (opts.oneShot) childEnv.BRAIN_ONE_SHOT_SESSION = "1";
  if (opts.emitCeiling !== undefined)
    childEnv.BRAIN_OBS_EMIT_CEILING = opts.emitCeiling;

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

/**
 * A ~15,000-byte over-ceiling fixture: head marker, 400 discrete fixed-width
 * lines (so a whole-line cut is distinguishable from a mid-char cut), tail
 * marker at the very end. Shared by every guard-truncation test.
 */
function buildLargeFixture(): string {
  const lines = Array.from(
    { length: 400 },
    (_, i) => `LINE-${String(i).padStart(4, "0")}-${"z".repeat(30)}`,
  );
  return `${HEAD_MARKER}\n${lines.join("\n")}\n${TAIL_MARKER}`;
}

describe("obs-inject SessionStart hook cap guard", () => {
  it("normal block under ceiling -> emitted additionalContext is byte-for-byte identical, no guard marker", async () => {
    // ~9000 bytes, well under the 9,800-byte ceiling. No trailing newline:
    // bash command substitution ($(...)) strips trailing newlines regardless
    // of the guard, so a trailing-newline fixture could never round-trip
    // byte-for-byte -- that's pre-existing $(...) behaviour, not something
    // the guard introduces.
    const body = "y".repeat(8900);
    const fixture = `${HEAD_MARKER}\n${body}\n${TAIL_MARKER}`;
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: true });
    const ac = additionalContext(out);

    expect(ac).toBe(fixture);
    expect(ac).not.toContain("obs-inject guard:");
    expect(ac).not.toContain("GUARD TRIPPED");

    const log = await readLog();
    expect(log).not.toContain("GUARD TRIPPED");
  });

  it("over-ceiling block -> tail-truncated to whole lines under 10,000 bytes, head preserved, tail dropped, guard marker + loud log", async () => {
    // ~15000 bytes: distinctive head marker near the top, many discrete lines
    // (each with a fixed-width tail so a mid-char cut is distinguishable from
    // a whole-line cut), tail marker at the very end.
    const fixture = buildLargeFixture();
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: true });
    const ac = additionalContext(out);

    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(10000);
    expect(ac).toContain("obs-inject guard:");
    expect(ac).toContain(HEAD_MARKER);
    expect(ac).not.toContain(TAIL_MARKER);

    // Byte-safe tail-truncation to whole lines: the kept portion (everything
    // before the guard marker) must end on a COMPLETE line, not a mid-char /
    // mid-line fragment from a raw head -c cut.
    const kept = ac.slice(0, ac.indexOf("\n\n[obs-inject guard:"));
    expect(kept.split("\n").at(-1)).toMatch(/^LINE-\d{4}-z{30}$/);

    const log = await readLog();
    expect(log).toContain("GUARD TRIPPED");
  });

  it("non-integer BRAIN_OBS_EMIT_CEILING -> guard still fires (does NOT silently skip), falls back to default + loud log", async () => {
    // A non-integer override would break the numeric -gt test and skip the
    // guard, emitting the oversized block unguarded (the harness then silently
    // truncates it). The validation must reject it and use the safe default.
    const fixture = buildLargeFixture();
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: true, emitCeiling: "foo" });
    const ac = additionalContext(out);

    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(10000);
    expect(ac).toContain("obs-inject guard:");
    expect(ac).not.toContain(TAIL_MARKER);

    const log = await readLog();
    expect(log).toContain("bad BRAIN_OBS_EMIT_CEILING");
    expect(log).toContain("GUARD TRIPPED");
  });

  it("out-of-range BRAIN_OBS_EMIT_CEILING (too small -> negative head budget) -> falls back to default + loud log, no negative head -c", async () => {
    // A ceiling under ~320 makes GUARD_BUDGET negative; GNU head -c <negative>
    // means "all but the last N bytes" and BSD head errors. The clamp forces the
    // default so head -c always receives a positive budget.
    const fixture = buildLargeFixture();
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: true, emitCeiling: "100" });
    const ac = additionalContext(out);

    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(10000);
    expect(ac).toContain("obs-inject guard:");
    expect(ac).toContain(HEAD_MARKER);
    expect(ac).not.toContain(TAIL_MARKER);
    // Kept portion still ends on a complete line (positive, sane head budget).
    const kept = ac.slice(0, ac.indexOf("\n\n[obs-inject guard:"));
    expect(kept.split("\n").at(-1)).toMatch(/^LINE-\d{4}-z{30}$/);

    const log = await readLog();
    expect(log).toContain("out of [1000,9900]");
  });

  it("leading-zero BRAIN_OBS_EMIT_CEILING '09800' -> base-10 forced (no octal abort), behaves like default 9800, hook does not crash", async () => {
    // 09800 is an all-digit string so it passes the case check and the decimal
    // -lt/-gt range tests, then reaches the GUARD_BUDGET arithmetic. Without the
    // 10# base-10 force, $(( 09800 - 320 )) octal-parses 09800, whose 8/9 are not
    // octal digits -> "value too great for base" -> the hook aborts on EVERY
    // SessionStart. The fix must treat it as decimal 9800 and guard normally.
    const fixture = buildLargeFixture();
    await writeFile(env.fixtureFile, fixture);

    // execFileSync throws on a non-zero exit, so a crash here fails the test.
    const out = runHook({ agentName: AGENT, viaSessionStart: true, emitCeiling: "09800" });
    const ac = additionalContext(out);

    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(10000);
    expect(ac).toContain("obs-inject guard:");
    expect(ac).toContain(HEAD_MARKER);
    expect(ac).not.toContain(TAIL_MARKER);
    // Kept portion ends on a complete line, budget = 9800 - 320 = 9480 (decimal).
    const kept = ac.slice(0, ac.indexOf("\n\n[obs-inject guard:"));
    expect(kept.split("\n").at(-1)).toMatch(/^LINE-\d{4}-z{30}$/);
    expect(Buffer.byteLength(kept, "utf8")).toBeGreaterThan(5000);

    const log = await readLog();
    expect(log).toContain("GUARD TRIPPED");
  });

  it("leading-zero BRAIN_OBS_EMIT_CEILING '01200' -> parsed as decimal 1200 (not octal 640), budget not under-sized", async () => {
    // 01200 passes the digit + range checks. Without 10#, $(( 01200 - 320 ))
    // parses octal 640 -> budget 320 (over-truncation to ~7 lines). Base-10 gives
    // decimal 1200 -> budget 880 (~21 lines). Assert the kept portion is well
    // above what the octal budget would leave, proving decimal parsing.
    const fixture = buildLargeFixture();
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: true, emitCeiling: "01200" });
    const ac = additionalContext(out);

    expect(ac).toContain("obs-inject guard:");
    expect(ac).toContain(HEAD_MARKER);
    // Assert the core guard guarantee explicitly (as the sibling ceiling tests
    // do), not just infer it from the marker/line-boundary checks: emitted block
    // stays under Claude's 10K cap and the tail is dropped.
    expect(ac).not.toContain(TAIL_MARKER);
    expect(Buffer.byteLength(ac, "utf8")).toBeLessThan(10000);
    const kept = ac.slice(0, ac.indexOf("\n\n[obs-inject guard:"));
    expect(kept.split("\n").at(-1)).toMatch(/^LINE-\d{4}-z{30}$/);
    // Octal 640 -> budget 320 -> ~287B kept; decimal 1200 -> budget 880 -> ~860B.
    // 500 cleanly separates the two.
    expect(Buffer.byteLength(kept, "utf8")).toBeGreaterThan(500);

    const log = await readLog();
    expect(log).toContain("GUARD TRIPPED");
  });

  it("flag off -> emits empty additionalContext (gate intact)", async () => {
    const fixture = `${HEAD_MARKER}\nsome obs content\n${TAIL_MARKER}\n`;
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: false });
    expect(additionalContext(out)).toBe("");
  });

  it("no AGENT_NAME -> emits empty additionalContext (gate intact)", async () => {
    const fixture = `${HEAD_MARKER}\nsome obs content\n${TAIL_MARKER}\n`;
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ viaSessionStart: true });
    expect(additionalContext(out)).toBe("");
  });

  it("one-shot session -> emits empty additionalContext (gate intact)", async () => {
    const fixture = `${HEAD_MARKER}\nsome obs content\n${TAIL_MARKER}\n`;
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: AGENT, viaSessionStart: true, oneShot: true });
    expect(additionalContext(out)).toBe("");
  });

  it("no memory dir -> emits empty additionalContext (gate intact)", async () => {
    const fixture = `${HEAD_MARKER}\nsome obs content\n${TAIL_MARKER}\n`;
    await writeFile(env.fixtureFile, fixture);

    const out = runHook({ agentName: "no-memory-agent", viaSessionStart: true });
    expect(additionalContext(out)).toBe("");
  });
});
