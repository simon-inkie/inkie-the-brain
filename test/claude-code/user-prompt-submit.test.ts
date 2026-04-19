import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  run,
  wrapForInjection,
} from "../../adapters/claude-code/src/user-prompt-submit.js";

const LIVE_START = "<!-- IO_LIVE_START -->";
const LIVE_END = "<!-- IO_LIVE_END -->";

describe("user-prompt-submit — run()", () => {
  let testDir: string;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tb-ups-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testDir, "memory"), { recursive: true });
    // Force resolution to this project's memory dir
    delete process.env.BRAIN_MEMORY_DIR;
    delete process.env.BRAIN_MAX_INJECTED_CHARS;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    process.env = { ...prevEnv };
  });

  function writeMemoryFile(body: string): void {
    writeFileSync(join(testDir, "MEMORY.md"), body);
  }

  it("returns empty string when MEMORY.md is missing", async () => {
    const out = await run(JSON.stringify({ cwd: testDir }));
    expect(out).toBe("");
  });

  it("returns empty string when IO_LIVE block is empty", async () => {
    writeMemoryFile(`# MEMORY\n\n${LIVE_START}\n${LIVE_END}\n`);
    const out = await run(JSON.stringify({ cwd: testDir }));
    expect(out).toBe("");
  });

  it("extracts the IO_LIVE block and wraps it", async () => {
    writeMemoryFile(
      `# MEMORY\n\n${LIVE_START}\nSimon is building the-brain\n${LIVE_END}\n`,
    );
    const out = await run(JSON.stringify({ cwd: testDir }));
    expect(out).toContain("<the-brain>");
    expect(out).toContain("Simon is building the-brain");
    expect(out).toContain("</the-brain>");
  });

  it("returns empty string on malformed stdin JSON", async () => {
    const out = await run("not-json{{{");
    expect(out).toBe("");
  });

  it("falls back to process.cwd() when cwd missing from input", async () => {
    // Without cwd, resolver uses process.cwd(); memory likely doesn't exist
    // in that location during the test — expect empty string rather than throw.
    const out = await run(JSON.stringify({}));
    expect(typeof out).toBe("string");
  });

  it("honours BRAIN_MAX_INJECTED_CHARS when content exceeds limit", async () => {
    const large = "x".repeat(5000);
    writeMemoryFile(`${LIVE_START}\n${large}\n${LIVE_END}\n`);
    process.env.BRAIN_MAX_INJECTED_CHARS = "100";

    const out = await run(JSON.stringify({ cwd: testDir }));
    expect(out).toContain("truncated");
    // Kept section should be ~100 chars, not 5000
    expect(out.length).toBeLessThan(1000);
  });
});

describe("wrapForInjection", () => {
  it("wraps with the-brain tags", () => {
    expect(wrapForInjection("hello")).toBe(
      "<the-brain>\nhello\n</the-brain>",
    );
  });
});
