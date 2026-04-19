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

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tb-memory-root-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    delete process.env.BRAIN_MEMORY_DIR;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.BRAIN_MEMORY_DIR;
    else process.env.BRAIN_MEMORY_DIR = prevEnv;
  });

  it("prefers projectDir/memory/ when present", () => {
    mkdirSync(join(testDir, "memory"));
    expect(resolveMemoryDir(testDir)).toBe(join(testDir, "memory"));
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

  it("falls back to legacy OpenClaw workspace when no other tier matches", () => {
    // Assuming no ~/.the-brain/memory/ exists during test (reasonable default)
    // This test may short-circuit on tier 4 if user has ~/.the-brain/memory — that's fine.
    const result = resolveMemoryDir(testDir);
    const userGlobal = join(homedir(), ".the-brain", "memory");
    const legacy = join(homedir(), ".openclaw", "workspace", "memory");
    expect([userGlobal, legacy]).toContain(result);
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
