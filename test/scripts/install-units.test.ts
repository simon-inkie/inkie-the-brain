import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("systemd unit installers", () => {
  let dir: string;
  let units: string;
  let fakeBin: string;

  beforeEach(() => {
    dir = join(tmpdir(), `tb-units-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    units = join(dir, "units");
    fakeBin = join(dir, "bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "pnpm"), "#!/bin/bash\n");
    chmodSync(join(fakeBin, "pnpm"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sh = (script: string, ...args: string[]) =>
    spawnSync("bash", [join(repoRoot, "scripts", script), ...args], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });

  it("watcher unit carries the checkout path given, and no extras by default", () => {
    const r = sh("install-watcher.sh", "--root", repoRoot, "--unit-dir", units, "--no-enable");
    expect(r.status).toBe(0);
    const unit = readFileSync(join(units, "the-brain-watcher.service"), "utf-8");
    expect(unit).toContain(`WorkingDirectory=${repoRoot}`);
    expect(unit).toContain(`ExecStart="${join(fakeBin, "pnpm")}" watch`);
    expect(unit).toContain("Environment=BRAIN_WATCH_EXTRAS=\n");
    expect(unit).not.toMatch(/@\w+@/);
    expect(unit).not.toContain("%h/the-brain");
  });

  it("--extras opts a watcher in, and a rerun reports the unit as current", () => {
    const args = ["--root", repoRoot, "--unit-dir", units, "--no-enable", "--extras", "poke-agy"];
    expect(sh("install-watcher.sh", ...args).status).toBe(0);
    expect(readFileSync(join(units, "the-brain-watcher.service"), "utf-8")).toContain(
      "BRAIN_WATCH_EXTRAS=poke-agy",
    );
    expect(sh("install-watcher.sh", ...args).stdout).toMatch(/already current/);
  });

  it("rejects an unknown extra and a non-checkout root", () => {
    expect(sh("install-watcher.sh", "--extras", "nope", "--unit-dir", units, "--no-enable").status).toBe(1);
    expect(sh("install-watcher.sh", "--root", dir, "--unit-dir", units, "--no-enable").status).toBe(2);
  });

  it("timer installer renders real files (not symlinks) with the path filled in", () => {
    const r = sh("install-timer.sh", "--root", repoRoot, "--unit-dir", units, "--no-enable");
    expect(r.status).toBe(0);
    const svc = join(units, "snapshot-qdrant.service");
    expect(lstatSync(svc).isSymbolicLink()).toBe(false);
    expect(readFileSync(svc, "utf-8")).toContain(`ExecStart=${repoRoot}/scripts/snapshot-qdrant.sh`);
    expect(readFileSync(join(units, "snapshot-qdrant.timer"), "utf-8")).not.toMatch(/@\w+@/);
  });
});
