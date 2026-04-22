import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import {
  resolveMemoryDir,
  memoryFilePath,
} from "../../adapters/claude-code/src/memory-root.js";

describe("resolveMemoryDir", () => {
  let testDir: string;
  const prevEnv = process.env.BRAIN_MEMORY_DIR;
  const prevAgent = process.env.AGENT_NAME;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tb-memory-root-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    delete process.env.BRAIN_MEMORY_DIR;
    delete process.env.AGENT_NAME;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.BRAIN_MEMORY_DIR;
    else process.env.BRAIN_MEMORY_DIR = prevEnv;
    if (prevAgent === undefined) delete process.env.AGENT_NAME;
    else process.env.AGENT_NAME = prevAgent;
  });

  it("prefers projectDir/memory/ when present", () => {
    mkdirSync(join(testDir, "memory"));
    expect(resolveMemoryDir(testDir)).toBe(join(testDir, "memory"));
  });

  describe("AGENT_NAME override (tier 0)", () => {
    it("wins over every lower tier", () => {
      // Set up conditions for tiers 1, 2, 3 to all exist
      mkdirSync(join(testDir, "memory"));
      mkdirSync(join(testDir, ".the-brain"), { recursive: true });
      writeFileSync(
        join(testDir, ".the-brain", "memory_root"),
        "/tmp/wrong-tier2",
      );
      process.env.BRAIN_MEMORY_DIR = "/tmp/wrong-tier3";
      process.env.AGENT_NAME = "brain-surgeon";
      expect(resolveMemoryDir(testDir)).toBe(
        join(homedir(), ".the-brain", "agents", "brain-surgeon", "memory"),
      );
    });

    it("accepts hyphenated names", () => {
      process.env.AGENT_NAME = "brain-surgeon";
      expect(resolveMemoryDir(testDir)).toBe(
        join(homedir(), ".the-brain", "agents", "brain-surgeon", "memory"),
      );
    });

    it("accepts names with digits", () => {
      process.env.AGENT_NAME = "agent42";
      expect(resolveMemoryDir(testDir)).toBe(
        join(homedir(), ".the-brain", "agents", "agent42", "memory"),
      );
    });

    it("falls through on empty/whitespace AGENT_NAME", () => {
      process.env.AGENT_NAME = "   ";
      // Falls through to tier 5 (auto-silo by basename)
      const result = resolveMemoryDir(testDir);
      expect(result).toContain("/agents/");
      expect(result).not.toContain("/agents//");
    });

    it("falls through on invalid AGENT_NAME (path traversal)", () => {
      // Security: don't let "../evil" become a directory escape
      process.env.AGENT_NAME = "../evil";
      const result = resolveMemoryDir(testDir);
      expect(result).not.toContain("evil");
    });

    it("falls through on invalid AGENT_NAME (slashes)", () => {
      process.env.AGENT_NAME = "foo/bar";
      const result = resolveMemoryDir(testDir);
      expect(result).not.toContain("foo/bar");
    });

    it("falls through on invalid AGENT_NAME (spaces)", () => {
      process.env.AGENT_NAME = "has spaces";
      const result = resolveMemoryDir(testDir);
      expect(result).not.toContain("has spaces");
    });
  });

  it("falls through to override file when no local memory/", () => {
    const target = join(testDir, "elsewhere", "mem");
    mkdirSync(join(testDir, ".the-brain"), { recursive: true });
    writeFileSync(join(testDir, ".the-brain", "memory_root"), target);
    expect(resolveMemoryDir(testDir)).toBe(target);
  });

  it("expands ~ in override file", () => {
    mkdirSync(join(testDir, ".the-brain"), { recursive: true });
    writeFileSync(join(testDir, ".the-brain", "memory_root"), "~/custom-mem");
    expect(resolveMemoryDir(testDir)).toBe(join(homedir(), "custom-mem"));
  });

  it("trims whitespace in override file", () => {
    const target = join(testDir, "target");
    mkdirSync(join(testDir, ".the-brain"), { recursive: true });
    writeFileSync(
      join(testDir, ".the-brain", "memory_root"),
      `  ${target}\n`,
    );
    expect(resolveMemoryDir(testDir)).toBe(target);
  });

  it("falls through to BRAIN_MEMORY_DIR env", () => {
    process.env.BRAIN_MEMORY_DIR = "/tmp/tb-env-mem";
    expect(resolveMemoryDir(testDir)).toBe("/tmp/tb-env-mem");
  });

  it("expands ~ in env var", () => {
    process.env.BRAIN_MEMORY_DIR = "~/env-mem";
    expect(resolveMemoryDir(testDir)).toBe(join(homedir(), "env-mem"));
  });

  it("falls back to an auto-silo under ~/.the-brain/agents/<basename>/memory/", () => {
    // If the user has ~/.the-brain/memory/ (tier 4) it short-circuits there,
    // otherwise tier 5 derives a per-project silo from the projectDir basename.
    const result = resolveMemoryDir(testDir);
    const userGlobal = join(homedir(), ".the-brain", "memory");
    const expectedSilo = join(
      homedir(),
      ".the-brain",
      "agents",
      testDir.split("/").filter(Boolean).pop()!,
      "memory",
    );
    expect([userGlobal, expectedSilo]).toContain(result);
  });

  it("never falls back to the legacy OpenClaw workspace", () => {
    const result = resolveMemoryDir(testDir);
    const legacy = join(homedir(), ".openclaw", "workspace", "memory");
    expect(result).not.toBe(legacy);
  });

  it("ignores empty override file (falls through)", () => {
    mkdirSync(join(testDir, ".the-brain"), { recursive: true });
    writeFileSync(join(testDir, ".the-brain", "memory_root"), "   \n");
    process.env.BRAIN_MEMORY_DIR = "/tmp/fallback-wins";
    expect(resolveMemoryDir(testDir)).toBe("/tmp/fallback-wins");
  });

  it("absolute-resolves a relative projectDir argument", () => {
    // Resolution of the projectDir itself normalises to absolute
    mkdirSync(join(testDir, "memory"));
    const resolved = resolveMemoryDir(testDir);
    expect(resolved.startsWith("/")).toBe(true);
  });
});

describe("memoryFilePath", () => {
  it("points at MEMORY.md one level above the memory dir", () => {
    expect(memoryFilePath("/foo/bar/memory")).toBe("/foo/bar/MEMORY.md");
  });
});
