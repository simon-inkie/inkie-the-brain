import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm, chmod, symlink } from "node:fs/promises";
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

  // Copy build-context.sh into our test layout
  const buildContextSrc = await readFile(BUILD_CONTEXT_SH, "utf8");
  await writeFile(join(toolsDir, "build-context.sh"), buildContextSrc);
  await chmod(join(toolsDir, "build-context.sh"), 0o755);

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
    const headerContent = "# Simon's Memory\n\nThis is important non-live content.\n\n## Projects\n- Inkie\n- The Brain\n";
    const footerContent = "\n## Notes\nSome trailing notes.\n";
    await writeMemoryMd(
      `${headerContent}<!-- IO_LIVE_START -->\nold live block\n<!-- IO_LIVE_END -->${footerContent}`,
    );

    await runBuildContext();
    const result = await readMemoryMd();

    expect(result).toContain("Simon's Memory");
    expect(result).toContain("This is important non-live content.");
    expect(result).toContain("Projects");
    expect(result).toContain("Inkie");
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
