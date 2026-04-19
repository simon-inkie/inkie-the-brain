import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// The CLI reads the agent target from its own repo layout and writes to
// $HOME. We override HOME per test so ~/.the-brain/... in the CLI
// resolves to a disposable tmpdir and never touches the real user.
const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(here), "..", "..");
const cliPath = join(repoRoot, "cli", "index.ts");

function runCli(
  args: string[],
  envHome: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("npx", ["tsx", cliPath, ...args], {
    env: { ...process.env, HOME: envHome },
    encoding: "utf-8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("agent init", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = join(
      tmpdir(),
      `tb-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("creates the agent dir with the expected 4-file seed kit", () => {
    const r = runCli(["agent", "init", "test-agent"], fakeHome);
    expect(r.status).toBe(0);

    const memory = join(fakeHome, ".the-brain", "agents", "test-agent", "memory");
    expect(existsSync(memory)).toBe(true);
    expect(existsSync(join(memory, "OBSERVATION-PROMPT.md"))).toBe(true);
    expect(existsSync(join(memory, "live-state.json"))).toBe(true);
    expect(existsSync(join(memory, "observer-state.json"))).toBe(true);
    expect(existsSync(join(memory, "observations"))).toBe(true);
    expect(existsSync(join(memory, "observer-pointers"))).toBe(true);
    expect(
      existsSync(
        join(fakeHome, ".the-brain", "agents", "test-agent", "MEMORY.md"),
      ),
    ).toBe(true);

    // observer-state.json bootstraps to empty JSON object so observe.sh's
    // jq update pattern succeeds on first run.
    expect(readFileSync(join(memory, "observer-state.json"), "utf-8").trim())
      .toBe("{}");

    // live-state.json should be valid JSON (copied from templates/)
    const live = JSON.parse(readFileSync(join(memory, "live-state.json"), "utf-8"));
    expect(typeof live).toBe("object");
  });

  it("refuses to overwrite an existing agent dir", () => {
    const first = runCli(["agent", "init", "dup-agent"], fakeHome);
    expect(first.status).toBe(0);

    const second = runCli(["agent", "init", "dup-agent"], fakeHome);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already exists/i);
  });

  it("refuses an invalid name", () => {
    const r = runCli(["agent", "init", "has spaces"], fakeHome);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid name/i);
  });

  it("refuses a missing name", () => {
    const r = runCli(["agent", "init"], fakeHome);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing <name>/i);
  });

  it("writes a tier-2 pointer when --link is given", () => {
    const linkDir = join(fakeHome, "fake-worktree");
    mkdirSync(linkDir, { recursive: true });

    const r = runCli(
      ["agent", "init", "linked-agent", "--link", linkDir],
      fakeHome,
    );
    expect(r.status).toBe(0);

    const pointer = join(linkDir, ".the-brain", "memory_root");
    expect(existsSync(pointer)).toBe(true);

    const contents = readFileSync(pointer, "utf-8").trim();
    const expectedMemory = join(
      fakeHome,
      ".the-brain",
      "agents",
      "linked-agent",
      "memory",
    );
    expect(contents).toBe(expectedMemory);
  });

  it("refuses --link to a non-existent directory", () => {
    const r = runCli(
      [
        "agent",
        "init",
        "nolink-agent",
        "--link",
        join(fakeHome, "does-not-exist"),
      ],
      fakeHome,
    );
    // The agent dir IS created before --link is validated (acceptable
    // behaviour — the silo is useful on its own). The CLI then exits 1
    // because the link target is missing.
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not exist/i);
  });
});
