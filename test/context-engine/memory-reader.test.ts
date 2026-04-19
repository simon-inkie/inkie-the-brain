import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readInjectedMemoryBlock } from "../../core/context-engine/memory-reader.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `the-brain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function cfg(overrides: Partial<Parameters<typeof readInjectedMemoryBlock>[0]> = {}) {
  return {
    memoryBlockSource: "file" as const,
    memoryFile: join(testDir, "MEMORY.md"),
    maxInjectedChars: 40000,
    debug: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readInjectedMemoryBlock", () => {
  it("returns empty string when memoryBlockSource=memory-core", async () => {
    const result = await readInjectedMemoryBlock(cfg({ memoryBlockSource: "memory-core" }));
    expect(result).toBe("");
  });

  it("returns empty string when memoryBlockSource=none", async () => {
    const result = await readInjectedMemoryBlock(cfg({ memoryBlockSource: "none" }));
    expect(result).toBe("");
  });

  it("extracts text between IO_LIVE anchors when memoryBlockSource=file", async () => {
    const content = [
      "# MEMORY.md",
      "Some stuff above",
      "<!-- IO_LIVE_START -->",
      "## Live context here",
      "Important memory content",
      "<!-- IO_LIVE_END -->",
      "Some stuff below",
    ].join("\n");
    await writeFile(cfg().memoryFile, content);

    const result = await readInjectedMemoryBlock(cfg());
    expect(result).toContain("Live context here");
    expect(result).toContain("Important memory content");
    expect(result).not.toContain("Some stuff above");
    expect(result).not.toContain("Some stuff below");
    expect(result).not.toContain("IO_LIVE_START");
    expect(result).not.toContain("IO_LIVE_END");
  });

  it("returns full content when anchors are missing (fallback)", async () => {
    const content = "# MEMORY.md\nNo anchors here\nJust plain text";
    await writeFile(cfg().memoryFile, content);

    const result = await readInjectedMemoryBlock(cfg());
    expect(result).toContain("No anchors here");
  });

  it("returns empty string when file does not exist", async () => {
    const result = await readInjectedMemoryBlock(cfg({ memoryFile: join(testDir, "nonexistent.md") }));
    expect(result).toBe("");
  });

  it("truncates from the top when block exceeds maxInjectedChars", async () => {
    const longContent = "x".repeat(50000);
    const content = [
      "<!-- IO_LIVE_START -->",
      longContent,
      "<!-- IO_LIVE_END -->",
    ].join("\n");
    await writeFile(cfg().memoryFile, content);

    const result = await readInjectedMemoryBlock(cfg({ maxInjectedChars: 1000 }));
    expect(result.length).toBeLessThanOrEqual(1100); // allow for marker text
    expect(result).toContain("[...truncated");
    // Should keep the END of the content (newest)
    expect(result).toContain("x".repeat(100));
  });

  it("does not truncate when block is within maxInjectedChars", async () => {
    const content = [
      "<!-- IO_LIVE_START -->",
      "Short content",
      "<!-- IO_LIVE_END -->",
    ].join("\n");
    await writeFile(cfg().memoryFile, content);

    const result = await readInjectedMemoryBlock(cfg());
    expect(result).not.toContain("[...truncated");
    expect(result).toContain("Short content");
  });

  it("never throws — returns empty string on I/O errors", async () => {
    // Point at a directory instead of a file
    const result = await readInjectedMemoryBlock(cfg({ memoryFile: testDir }));
    expect(result).toBe("");
  });
});
