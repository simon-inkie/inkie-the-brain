import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm, chmod, access, symlink, utimes } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Integration tests for build-context.sh (Phase 1a).
 *
 * Sets up a temp directory mimicking the workspace/memory layout,
 * stubs out compress-era.sh (since it calls Claude CLI), and runs
 * build-context.sh against the temp layout to verify three-zone
 * assembly and MEMORY.md splicing.
 */

import { fileURLToPath } from "node:url";

const BUILD_CONTEXT_SH = fileURLToPath(
  new URL(
    "../../adapters/openclaw/hooks/memory-tools/build-context.sh",
    import.meta.url,
  ),
);

const LOG_SH = fileURLToPath(
  new URL(
    "../../adapters/openclaw/hooks/memory-tools/_log.sh",
    import.meta.url,
  ),
);

let testDir: string;
let workspaceDir: string;
let memoryDir: string;
let toolsDir: string;
let obsDir: string;
let refDir: string;
let promptsDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `the-brain-build-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspaceDir = testDir;
  memoryDir = join(testDir, "memory");
  toolsDir = join(memoryDir, "tools");
  obsDir = join(memoryDir, "observations");
  refDir = join(memoryDir, "reflections");
  promptsDir = join(memoryDir, "prompts");

  await mkdir(toolsDir, { recursive: true });
  await mkdir(obsDir, { recursive: true });
  await mkdir(refDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });

  // Stub compress-era.sh — just copies input reflections into era-summary.md
  const stubCompressEra = `#!/bin/bash
set -euo pipefail
MEMORY_DIR="$(dirname "$(cd "$(dirname "$0")" && pwd)")"
ERA_FILE="$MEMORY_DIR/era-summary.md"
INPUT="$2"
echo "Compressed era summary stub" > "$ERA_FILE"
for f in $(find -L "$INPUT" -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort); do
  echo "- $(basename "$f")" >> "$ERA_FILE"
done
`;
  await writeFile(join(toolsDir, "compress-era.sh"), stubCompressEra);
  await chmod(join(toolsDir, "compress-era.sh"), 0o755);

  // Stub _log.sh — build-context.sh sources it best-effort and then calls
  // `log` unconditionally; without a stub every run dies "command not found".
  await writeFile(join(toolsDir, "_log.sh"), "log() { :; }\n");

  // Copy build-context.sh into our test layout
  const buildContextSrc = await readFile(BUILD_CONTEXT_SH, "utf8");
  await writeFile(join(toolsDir, "build-context.sh"), buildContextSrc);
  await chmod(join(toolsDir, "build-context.sh"), 0o755);

  // build-context.sh sources _log.sh from $SCRIPT_DIR — copy it alongside.
  // Without this the source fails silently (2>/dev/null || true) and `log`
  // is undefined → tests exit with "log: command not found".
  const logShSrc = await readFile(LOG_SH, "utf8");
  await writeFile(join(toolsDir, "_log.sh"), logShSrc);
  await chmod(join(toolsDir, "_log.sh"), 0o755);

  // Default live-state.json
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

  // Default era-summary.md (empty)
  await writeFile(join(memoryDir, "era-summary.md"), "");
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeMemoryMd(content: string): Promise<void> {
  await writeFile(join(workspaceDir, "MEMORY.md"), content);
}

async function readMemoryMd(): Promise<string> {
  return readFile(join(workspaceDir, "MEMORY.md"), "utf8");
}

async function addReflection(name: string, content: string): Promise<void> {
  await writeFile(join(refDir, `${name}.md`), content);
}

async function addObservation(name: string, content: string): Promise<void> {
  await writeFile(join(obsDir, `${name}.md`), content);
  // Set mtime to future to ensure it's "newer" than reflections
  const futureTime = new Date(Date.now() + 60000);
  const { utimes } = await import("node:fs/promises");
  await utimes(join(obsDir, `${name}.md`), futureTime, futureTime);
}

async function runBuildContext(): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bash", [join(toolsDir, "build-context.sh")], {
    env: {
      ...process.env,
      // Override HOME isn't enough — the script uses SCRIPT_DIR-relative paths
    },
    timeout: 10000,
  });
}

describe("build-context.sh", () => {
  it("fails if MEMORY.md is missing", async () => {
    await expect(runBuildContext()).rejects.toThrow();
  });

  it("fails if MEMORY.md is missing anchors", async () => {
    await writeMemoryMd("# Memory\nNo anchors here.");
    await expect(runBuildContext()).rejects.toThrow();
  });

  it("rebuilds the live block between anchors with no reflections or observations", async () => {
    await writeMemoryMd([
      "# My Memory",
      "",
      "Some content above.",
      "",
      "<!-- IO_LIVE_START -->",
      "old content here",
      "<!-- IO_LIVE_END -->",
      "",
      "Some content below.",
    ].join("\n"));

    await runBuildContext();
    const result = await readMemoryMd();

    // Content outside anchors is preserved
    expect(result).toContain("My Memory");
    expect(result).toContain("Some content above.");
    expect(result).toContain("Some content below.");

    // Live block was replaced
    expect(result).not.toContain("old content here");
    expect(result).toContain("IO_LIVE_START");
    expect(result).toContain("IO_LIVE_END");
    expect(result).toContain("Live Observation Context");

    // Zone placeholders
    expect(result).toContain("Era Summary");
    expect(result).toContain("No elder reflections yet");
    expect(result).toContain("No reflections yet");
    expect(result).toContain("No new observations");
  });

  it("includes recent reflections in the hot zone", async () => {
    await writeMemoryMd([
      "<!-- IO_LIVE_START -->",
      "old",
      "<!-- IO_LIVE_END -->",
    ].join("\n"));

    await addReflection("2026-04-01", "First reflection content");
    await addReflection("2026-04-02", "Second reflection content");

    await runBuildContext();
    const result = await readMemoryMd();

    expect(result).toContain("First reflection content");
    expect(result).toContain("Second reflection content");
    expect(result).toContain("Reflection (2026-04-01)");
    expect(result).toContain("Reflection (2026-04-02)");
  });

  it("splits reflections into elder and hot zones when count exceeds hotReflectionCount", async () => {
    await writeMemoryMd([
      "<!-- IO_LIVE_START -->",
      "old",
      "<!-- IO_LIVE_END -->",
    ].join("\n"));

    // hotReflectionCount defaults to 3, so with 5 reflections:
    // 2 go to elder (era summary), 3 stay in hot
    await addReflection("2026-03-01", "Elder one");
    await addReflection("2026-03-15", "Elder two");
    await addReflection("2026-04-01", "Hot one");
    await addReflection("2026-04-05", "Hot two");
    await addReflection("2026-04-10", "Hot three");

    await runBuildContext();
    const result = await readMemoryMd();

    // Hot zone should have the last 3
    expect(result).toContain("Hot one");
    expect(result).toContain("Hot two");
    expect(result).toContain("Hot three");

    // Era summary should have been rebuilt (compress-era stub was called)
    expect(result).toContain("Era Summary");
    expect(result).toContain("Compressed era summary stub");
  });

  it("includes unprocessed observations newer than the latest reflection", async () => {
    await writeMemoryMd([
      "<!-- IO_LIVE_START -->",
      "old",
      "<!-- IO_LIVE_END -->",
    ].join("\n"));

    await addReflection("2026-04-01", "A reflection");
    await addObservation("2026-04-02-14-30", "New observation after reflection");

    await runBuildContext();
    const result = await readMemoryMd();

    expect(result).toContain("New observation after reflection");
    expect(result).toContain("Unprocessed Observations");
  });

  it("preserves content outside the anchor markers", async () => {
    const headerContent = "# alice's Memory\n\nThis is important non-live content.\n\n## Projects\n- Widgets\n- The Brain\n";
    const footerContent = "\n## Notes\nSome trailing notes.\n";
    await writeMemoryMd(
      `${headerContent}<!-- IO_LIVE_START -->\nold live block\n<!-- IO_LIVE_END -->${footerContent}`,
    );

    await runBuildContext();
    const result = await readMemoryMd();

    expect(result).toContain("alice's Memory");
    expect(result).toContain("This is important non-live content.");
    expect(result).toContain("Projects");
    expect(result).toContain("Widgets");
    expect(result).toContain("The Brain");
    expect(result).toContain("Some trailing notes.");
    // Old block was replaced
    expect(result).not.toContain("old live block");
  });

  it("updates live-state.json with block metrics after rebuild", async () => {
    await writeMemoryMd([
      "<!-- IO_LIVE_START -->",
      "old",
      "<!-- IO_LIVE_END -->",
    ].join("\n"));

    await runBuildContext();

    const state = JSON.parse(
      await readFile(join(memoryDir, "live-state.json"), "utf8"),
    );
    expect(state.lastBlockCharCount).toBeGreaterThan(0);
    expect(state.lastRebuildAt).toBeTruthy();
  });
});

describe("--emit mode (agy adapter)", () => {
  // --emit renders the three-zone block to stdout and exits: no MEMORY.md
  // splice, no era rebuild, no live-state writes. PreInvocation fires per
  // model call, so the flag must be a pure read.
  const AGENT = "tagent";

  beforeEach(async () => {
    await writeMemoryMd([
      "# Header content",
      "<!-- IO_LIVE_START -->",
      "stale spliced content",
      "<!-- IO_LIVE_END -->",
      "trailing content",
    ].join("\n"));
    await addReflection("2026-06-10", "A hot reflection for emit");
    await addObservation("2026-06-11-10-00", "An unprocessed observation for emit");
  });

  async function runEmit(): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("bash", [join(toolsDir, "build-context.sh"), "--emit"], {
      env: { ...process.env, HOME: testDir, AGENT_NAME: AGENT },
      timeout: 10000,
    });
  }

  it("prints the three-zone block to stdout", async () => {
    const { stdout } = await runEmit();
    expect(stdout).toContain("Live Observation Context");
    expect(stdout).toContain("A hot reflection for emit");
    expect(stdout).toContain("An unprocessed observation for emit");
  });

  it("leaves MEMORY.md byte-for-byte unchanged", async () => {
    const before = await readMemoryMd();
    await runEmit();
    const after = await readMemoryMd();
    expect(after).toBe(before);
    expect(after).toContain("stale spliced content");
  });

  it("leaves live-state.json unchanged (no metrics write)", async () => {
    const before = await readFile(join(memoryDir, "live-state.json"), "utf8");
    await runEmit();
    const after = await readFile(join(memoryDir, "live-state.json"), "utf8");
    expect(after).toBe(before);
  });

  it("works without MEMORY.md present (agy degraded workspaces)", async () => {
    await rm(join(workspaceDir, "MEMORY.md"));
    const { stdout } = await runEmit();
    expect(stdout).toContain("Live Observation Context");
  });

  it("splice path still rewrites MEMORY.md when the flag is absent (control)", async () => {
    await execFileAsync("bash", [join(toolsDir, "build-context.sh")], {
      env: { ...process.env, HOME: testDir, AGENT_NAME: AGENT },
      timeout: 10000,
    });
    const result = await readMemoryMd();
    expect(result).not.toContain("stale spliced content");
  });
});

// ---------------------------------------------------------------------------
// --cached mode: budget-capped gist assembly
// ---------------------------------------------------------------------------

describe("--cached mode", () => {
  // --cached = --emit PLUS no timestamp, AND reflection gists
  // instead of verbatim bodies. Total output must be < 9,500 chars.

  const FAT_REFLECTION = "x".repeat(8700);  // ~8.7K per reflection (the real-world bloat)

  async function runCached(
    envOverrides: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("bash", [join(toolsDir, "build-context.sh"), "--cached"], {
      env: { ...process.env, ...envOverrides },
      timeout: 10000,
    });
  }

  it("output is < 9,500 chars even with fat reflections (regression guard)", async () => {
    // 3 fat reflections of 8.7K each would be ~26K verbatim — the live bug.
    await addReflection("2026-06-01", FAT_REFLECTION);
    await addReflection("2026-06-15", FAT_REFLECTION);
    await addReflection("2026-06-29", FAT_REFLECTION);

    // Write a fat era-summary too
    await writeFile(join(memoryDir, "era-summary.md"), "e".repeat(6500));

    const { stdout } = await runCached();
    expect(stdout.length).toBeLessThan(9500);
  });

  it("era-summary is present in full in --cached output", async () => {
    const ERA_MARKER = "ERA_SUMMARY_UNIQUE_CONTENT_MARKER_12345";
    await writeFile(join(memoryDir, "era-summary.md"), `# Era\n\n${ERA_MARKER}\n`);
    await addReflection("2026-06-29", FAT_REFLECTION);

    const { stdout } = await runCached();
    expect(stdout).toContain(ERA_MARKER);
    // Full content — not just the marker but confirm it's not truncated
    expect(stdout).toContain("# Era");
  });

  it("unprocessed observations are present in --cached output", async () => {
    await addReflection("2026-06-28", "Old reflection");
    await addObservation("2026-06-29-10-00", "OBS_UNIQUE_CONTENT_12345");

    const { stdout } = await runCached();
    expect(stdout).toContain("OBS_UNIQUE_CONTENT_12345");
    expect(stdout).toContain("Unprocessed Observations");
  });

  it("most-recent reflection gist is present (first chars), full body is absent", async () => {
    const GIST_INTRO = "GIST_START_UNIQUE_CONTENT_99999";
    const DEEP_BODY = "DEEP_BODY_NOT_IN_CACHED_OUTPUT";
    // Reflection: GIST_INTRO at the start, DEEP_BODY buried after 1000 chars
    const refl = `${GIST_INTRO} ${"x".repeat(600)} ${DEEP_BODY}`;
    await addReflection("2026-06-29", refl);

    const { stdout } = await runCached();
    expect(stdout).toContain(GIST_INTRO);
    // Deep body is past the 500-char gist cap — should NOT appear
    expect(stdout).not.toContain(DEEP_BODY);
    // Recall pointer must be present
    expect(stdout).toContain("recall");
  });

  it("deep reflection body content (past gist cap) is absent (recall-fallback)", async () => {
    // Place unique markers AFTER the 500-char gist cap so they are never in the gist.
    const PAD = "x".repeat(520);  // more than CACHED_GIST_MAX=500
    const DEEP_OLD = "DEEP_OLD_BODY_UNIQUE_99988_PAST_CAP";
    const DEEP_NEW = "DEEP_NEW_BODY_UNIQUE_99977_PAST_CAP";
    // Two reflections: deep content is past the gist cut point
    await addReflection("2026-06-10", `${PAD} ${DEEP_OLD}`);
    await addReflection("2026-06-29", `${PAD} ${DEEP_NEW}`);

    // Make era fat so budget is tight
    await writeFile(join(memoryDir, "era-summary.md"), "e".repeat(6500));

    const { stdout } = await runCached();
    // Neither deep body should appear — they are past the gist cap
    expect(stdout).not.toContain(DEEP_NEW);
    expect(stdout).not.toContain(DEEP_OLD);
    // Recall pointer must be present
    expect(stdout).toContain("recall");
    // Output must still be within budget
    expect(stdout.length).toBeLessThan(9500);
  });


  it("does not include Current time wall-clock stamp", async () => {
    const { stdout } = await runCached();
    expect(stdout).not.toContain("Current time:");
    expect(stdout).not.toContain("UTC");
  });

  it("leaves MEMORY.md unchanged (pure read, no splice)", async () => {
    await writeMemoryMd([
      "# Header",
      "<!-- IO_LIVE_START -->",
      "stale content",
      "<!-- IO_LIVE_END -->",
    ].join("\n"));

    await runCached();
    const result = await readMemoryMd();
    expect(result).toContain("stale content");
  });

  it("leaves live-state.json unchanged (no metrics write)", async () => {
    const before = await readFile(join(memoryDir, "live-state.json"), "utf8");
    await runCached();
    const after = await readFile(join(memoryDir, "live-state.json"), "utf8");
    expect(after).toBe(before);
  });

  it("tracked source carries --cached arg dispatch (drift-prevention guard)", async () => {
    const src = await readFile(BUILD_CONTEXT_SH, "utf8");
    expect(src).toContain("--cached");
    expect(src).toContain("CACHED_MODE=true");
    expect(src).toContain("CACHED_BUDGET");
    expect(src).toContain("reflection_gist");
  });
});

// ---------------------------------------------------------------------------
// --cached mode: hard total-cap + unprocessed-zone bound
// ---------------------------------------------------------------------------

describe("--cached hard total-cap + unprocessed bound", () => {
  // The original gist scheme only capped the REFLECTION zone. On busy days
  // Era (full) + Unprocessed (full) alone breached the 9,500 budget for half
  // the agents measured. This suite pins the two-layer fix: per-zone bound
  // (Layer 1) and the post-assembly HARD total-cap (Layer 2).

  async function runCached(
    envOverrides: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("bash", [join(toolsDir, "build-context.sh"), "--cached"], {
      env: { ...process.env, ...envOverrides },
      timeout: 10000,
    });
  }

  it("output < 10,000 on a fat-unprocessed fixture (~10K of obs) - the regression", async () => {
    await addReflection("2026-06-20", "A small reflection");
    // Five fat observation files newer than the reflection (~2K each = ~10K)
    for (let i = 0; i < 5; i++) {
      await addObservation(
        `2026-06-2${i}-12-00`,
        `OBS_BLOCK_${i} ${"o".repeat(2000)}`,
      );
    }

    const { stdout } = await runCached();
    expect(stdout.length).toBeLessThan(10000);
    expect(stdout.length).toBeLessThan(9500);
  });

  it("output < 10,000 on a fat-era fixture (era alone over budget) - proves the hard total-cap", async () => {
    // Era alone is ~12K, larger than the whole budget. Only the Layer-2 hard
    // cap (not any per-zone cap) can bound this; era keeps the highest priority
    // and is truncated last, but the TOTAL must still come out under budget.
    await writeFile(join(memoryDir, "era-summary.md"), "E".repeat(12000));
    await addReflection("2026-06-20", "x".repeat(3000));
    await addObservation("2026-06-21-12-00", "y".repeat(3000));

    const { stdout } = await runCached();
    expect(stdout.length).toBeLessThan(10000);
    expect(stdout.length).toBeLessThan(9500);
    // The hard-cap recall pointer must be present
    expect(stdout).toContain("truncated to budget");
    expect(stdout).toContain("recall");
  });

  it("retains most-recent unprocessed, drops oldest, adds recall pointer", async () => {
    await addReflection("2026-06-20", "A reflection");
    // Three obs; each ~1.2K so the 2,000-char unprocessed sub-budget keeps the
    // newest, drops the older two. Distinct markers per file. addObservation
    // sets all mtimes ~now+60s, so the filename sort decides recency.
    await addObservation("2026-06-21-09-00", `OLDEST_OBS_MARKER ${"a".repeat(1200)}`);
    await addObservation("2026-06-22-09-00", `MIDDLE_OBS_MARKER ${"b".repeat(1200)}`);
    await addObservation("2026-06-23-09-00", `NEWEST_OBS_MARKER ${"c".repeat(1200)}`);

    const { stdout } = await runCached();
    // Newest retained
    expect(stdout).toContain("NEWEST_OBS_MARKER");
    // Oldest dropped (past the 2,000-char sub-budget)
    expect(stdout).not.toContain("OLDEST_OBS_MARKER");
    // Drop pointer present
    expect(stdout).toContain("older unprocessed observations available via recall");
    expect(stdout.length).toBeLessThan(9500);
  });

  it("normal case: era + unprocessed + reflection gist all present (no regression)", async () => {
    const ERA_MARKER = "NORMAL_ERA_MARKER_111";
    const OBS_MARKER = "NORMAL_OBS_MARKER_222";
    const REFL_MARKER = "NORMAL_REFL_MARKER_333";
    await writeFile(join(memoryDir, "era-summary.md"), `# Era\n\n${ERA_MARKER}\n`);
    await addReflection("2026-06-20", `${REFL_MARKER} a recent reflection body`);
    await addObservation("2026-06-21-09-00", `${OBS_MARKER} a fresh observation`);

    const { stdout } = await runCached();
    expect(stdout).toContain(ERA_MARKER);
    expect(stdout).toContain(OBS_MARKER);
    expect(stdout).toContain(REFL_MARKER);
    expect(stdout).toContain("Era Summary");
    expect(stdout).toContain("Unprocessed Observations");
    expect(stdout).toContain("Recent Reflections");
    expect(stdout.length).toBeLessThan(9500);
  });

  it("a single fat observation file is bounded by Layer 1 (not left to Layer 2)", async () => {
    // One ~6K observation file: Layer 1 must truncate WITHIN it to the
    // unprocessed sub-budget, so the per-entry truncation marker appears and
    // the era (highest priority) is never touched by the Layer-2 backstop.
    const ERA_MARKER = "ERA_STAYS_WHOLE_MARKER_444";
    await writeFile(join(memoryDir, "era-summary.md"), `# Era\n\n${ERA_MARKER}\n`);
    await addReflection("2026-06-20", "A reflection");
    await addObservation("2026-06-21-09-00", `FAT_OBS_HEAD ${"z".repeat(6000)}`);

    const { stdout } = await runCached();
    // Era untouched (Layer 2 never fired on it)
    expect(stdout).toContain(ERA_MARKER);
    // Per-entry truncation marker present
    expect(stdout).toContain("observation truncated");
    expect(stdout.length).toBeLessThan(9500);
  });
});

/**
 * macOS portability (#16). Stock macOS has no `flock`, its `stat` is BSD
 * (no `-c`), and /bin/bash is 3.2. The first of those made the script treat
 * "flock: command not found" as "another instance is running" and exit 0
 * without touching MEMORY.md, which is why most of this suite failed on the
 * macOS runner. These tests run the script with a PATH that lacks `flock` and
 * has a BSD-style `stat`, so the regression shows on Linux too.
 */
describe("build-context.sh without flock and with BSD stat (macOS)", () => {
  const NEEDED_TOOLS = [
    "bash", "jq", "find", "sort", "grep", "awk", "mktemp", "mv", "rm", "cat",
    "dirname", "basename", "ln", "date", "mkdir", "kill", "head", "tail", "sed",
    "tr", "wc", "cut", "env", "touch", "chmod", "sleep",
  ];

  let macBin: string;

  async function which(tool: string): Promise<string | undefined> {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = join(dir, tool);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
    return undefined;
  }

  /** A PATH directory of symlinks to the real tools, plus the BSD-style stat shim. */
  async function makeBin(
    name: string,
    opts: { flock: boolean; perl: boolean },
  ): Promise<string> {
    const dir = join(testDir, name);
    await mkdir(dir, { recursive: true });
    const tools = [...NEEDED_TOOLS];
    if (opts.flock) tools.push("flock");
    if (opts.perl) tools.push("perl");
    for (const tool of tools) {
      const real = await which(tool);
      if (real) await symlink(real, join(dir, tool));
    }
    // BSD stat: `-c` is an illegal option, `-f %m` prints the mtime. The real
    // stat is GNU on Linux (-c %Y) and BSD on macOS (-f %m); probe it once here
    // and bake the working form into the shim, so the shim never falls back
    // per call.
    const realStat = (await which("stat"))!;
    let realMtime: string;
    try {
      execFileSync(realStat, ["-c", "%Y", "."], { stdio: "ignore" });
      realMtime = `-c %Y`;
    } catch {
      realMtime = `-f %m`;
    }
    await writeFile(
      join(dir, "stat"),
      `#!/bin/sh
if [ "$1" = "-f" ] && [ "$2" = "%m" ]; then
  exec "${realStat}" ${realMtime} "$3"
fi
echo "stat: illegal option -- c" >&2
exit 1
`,
    );
    await chmod(join(dir, "stat"), 0o755);
    return dir;
  }

  beforeEach(async () => {
    // Stock macOS: perl, no flock.
    macBin = await makeBin("macbin", { flock: false, perl: true });
  });

  async function runMac(): Promise<{ stdout: string; stderr: string }> {
    // /bin/bash, like the older tests' intent: bash 3.2 on the macOS runner.
    return execFileAsync("/bin/bash", [join(toolsDir, "build-context.sh")], {
      env: { ...process.env, PATH: macBin },
      timeout: 10000,
    });
  }

  const ANCHORED = [
    "# Mem",
    "<!-- IO_LIVE_START -->",
    "stale live block",
    "<!-- IO_LIVE_END -->",
    "tail",
    "",
  ].join("\n");

  it("the PATH really has no flock (guards the harness itself)", async () => {
    await expect(
      execFileAsync(join(macBin, "bash"), ["-c", "command -v flock"], {
        env: { ...process.env, PATH: macBin },
      }),
    ).rejects.toThrow();
  });

  it("rebuilds the live block instead of skipping as 'another instance'", async () => {
    await writeMemoryMd(ANCHORED);
    await addReflection("2026-06-20", "A reflection about macOS");
    await addObservation("2026-06-21-09-00", "A fresh observation about macOS");

    const { stderr } = await runMac();
    expect(stderr).not.toContain("another instance is running");

    const result = await readMemoryMd();
    expect(result).not.toContain("stale live block");
    expect(result).toContain("A reflection about macOS");
    // Needs the BSD-compatible mtime path to classify the observation.
    expect(result).toContain("A fresh observation about macOS");
    expect(result).toContain("tail");
  });

  it("releases its lock when it finishes, so back-to-back runs both work", async () => {
    await writeMemoryMd(ANCHORED);
    await runMac();
    await writeMemoryMd(ANCHORED);
    const { stderr } = await runMac();
    expect(stderr).not.toContain("another instance is running");
    expect(await readMemoryMd()).not.toContain("stale live block");
  });

  /**
   * Locking. The lock is an flock(2) lock on fd 9, taken with flock(1) when
   * the PATH has it and with perl otherwise, so there is no pid file, no stale
   * lock to reclaim and nothing a live owner can lose. The tests below pause a
   * run at a controlled point while it holds the lock (the first jq call is
   * gated on a file) and check what other runs do meanwhile.
   */
  interface Holder {
    done: Promise<number | null>;
    pid: number;
  }

  async function waitForFile(path: string, ms = 10000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        await access(path);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    throw new Error(`timed out waiting for ${path}`);
  }

  /** A bin dir like macBin, with the first jq call paused until gate/release. */
  async function gatedBin(name: string, withFlock: boolean): Promise<string> {
    const dir = await makeBin(name, { flock: withFlock, perl: true });
    const realJq = await which("jq");
    await rm(join(dir, "jq"));
    const gate = join(testDir, "gate");
    await mkdir(gate, { recursive: true });
    await writeFile(
      join(dir, "jq"),
      `#!/bin/sh
if [ ! -e "${gate}/started" ]; then
  : > "${gate}/started"
  i=0
  while [ ! -e "${gate}/release" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done
fi
exec "${realJq}" "$@"
`,
    );
    await chmod(join(dir, "jq"), 0o755);
    return dir;
  }

  function startHolder(binDir: string): Holder {
    const child = spawn("/bin/bash", [join(toolsDir, "build-context.sh")], {
      env: { ...process.env, PATH: binDir },
      detached: true, // own process group, so the whole run can be killed
      stdio: "ignore",
    });
    const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { done, pid: child.pid! };
  }

  async function release(): Promise<void> {
    await writeFile(join(testDir, "gate", "release"), "");
  }

  async function runIn(binDir: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("/bin/bash", [join(toolsDir, "build-context.sh")], {
      env: { ...process.env, PATH: binDir },
      timeout: 10000,
    });
  }

  it("a run paused while holding the lock keeps it: others skip, then it finishes", async () => {
    await writeMemoryMd(ANCHORED);
    const holderBin = await gatedBin("holder-bin", false);
    const holder = startHolder(holderBin);
    await waitForFile(join(testDir, "gate", "started"));

    // Several contenders while the holder is paused (this is the interval in
    // which a pid-file lock could be judged stale).
    for (let i = 0; i < 3; i++) {
      const { stderr } = await runMac();
      expect(stderr).toContain("another instance is running");
      expect(await readMemoryMd()).toBe(ANCHORED);
    }

    await release();
    expect(await holder.done).toBe(0);
    expect(await readMemoryMd()).not.toContain("stale live block");

    // Lock released on exit: the next run is a normal run.
    await writeMemoryMd(ANCHORED);
    const next = await runMac();
    expect(next.stderr).not.toContain("another instance is running");
    expect(await readMemoryMd()).not.toContain("stale live block");
  });

  it("a holder killed at the pause point frees the lock with no reclaim step", async () => {
    await writeMemoryMd(ANCHORED);
    const holderBin = await gatedBin("holder-bin", false);
    const holder = startHolder(holderBin);
    await waitForFile(join(testDir, "gate", "started"));

    process.kill(-holder.pid, "SIGKILL");
    await holder.done;

    const { stderr } = await runMac();
    expect(stderr).not.toContain("another instance is running");
    expect(await readMemoryMd()).not.toContain("stale live block");
  });

  it("mixed PATH: a flock(1) holder excludes a perl-only run", async () => {
    await writeMemoryMd(ANCHORED);
    const holder = startHolder(await gatedBin("with-flock", true));
    await waitForFile(join(testDir, "gate", "started"));

    const { stderr } = await runMac(); // macBin has perl but no flock
    expect(stderr).toContain("another instance is running");
    expect(await readMemoryMd()).toBe(ANCHORED);

    await release();
    expect(await holder.done).toBe(0);
  });

  it("mixed PATH: a perl-only holder excludes a flock(1) run", async () => {
    await writeMemoryMd(ANCHORED);
    const holder = startHolder(await gatedBin("perl-only", false));
    await waitForFile(join(testDir, "gate", "started"));

    const flockBin = await makeBin("flock-bin", { flock: true, perl: false });
    const { stderr } = await runIn(flockBin);
    expect(stderr).toContain("another instance is running");
    expect(await readMemoryMd()).toBe(ANCHORED);

    await release();
    expect(await holder.done).toBe(0);
  });

  it("with neither flock nor perl it still rebuilds, and says it has no lock", async () => {
    await writeMemoryMd(ANCHORED);
    const bareBin = await makeBin("bare-bin", { flock: false, perl: false });
    const { stderr } = await runIn(bareBin);
    expect(stderr).toContain("no usable file lock");
    expect(stderr).not.toContain("another instance is running");
    expect(await readMemoryMd()).not.toContain("stale live block");
  });

  it("concurrent runs over mixed PATHs yield exactly one holder", async () => {
    await writeMemoryMd(ANCHORED);
    const flockBin = await gatedBin("g-flock", true);
    const perlBin = await gatedBin("g-perl", false);

    // Every run uses a bin whose first jq call is gated; only the winner gets
    // that far. Start six runs, alternating the two lock tools.
    const children = Array.from({ length: 6 }, (_, i) => {
      const out: string[] = [];
      const child = spawn("/bin/bash", [join(toolsDir, "build-context.sh")], {
        env: { ...process.env, PATH: i % 2 ? flockBin : perlBin },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr!.on("data", (d) => out.push(String(d)));
      const done = new Promise<{ code: number | null; err: string }>((resolve) =>
        child.on("exit", (code) => resolve({ code, err: out.join("") })),
      );
      return done;
    });

    await waitForFile(join(testDir, "gate", "started"));
    await new Promise((r) => setTimeout(r, 500)); // let the five losers skip
    await release();
    const results = await Promise.all(children);

    expect(results.every((r) => r.code === 0)).toBe(true);
    const skipped = results.filter((r) => r.err.includes("another instance is running"));
    expect(skipped).toHaveLength(5);
    expect(await readMemoryMd()).not.toContain("stale live block");
  });

  it("an unreadable mtime defaults to 0 instead of aborting the rebuild", async () => {
    await writeMemoryMd(ANCHORED);
    await addReflection("2026-06-20", "A reflection about macOS");
    await addObservation("2026-06-21-09-00", "A fresh observation about macOS");
    // A stat that supports neither flavour: file_mtime fails with no output.
    await writeFile(join(macBin, "stat"), "#!/bin/sh\nexit 1\n");

    const { stderr } = await runMac();
    expect(stderr).not.toContain("integer expression expected");
    expect(stderr).not.toContain("unbound variable");
    const result = await readMemoryMd();
    expect(result).not.toContain("stale live block");
    expect(result).toContain("A reflection about macOS");
  });

  it("uses no negative array subscripts (bash 3.2 rejects ${arr[-1]})", async () => {
    const src = await readFile(BUILD_CONTEXT_SH, "utf8");
    expect(src).not.toMatch(/\[-\d+\]/);
  });
});
