import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
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
