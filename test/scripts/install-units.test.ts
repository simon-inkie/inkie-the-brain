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
    expect(readFileSync(svc, "utf-8")).toContain(`ExecStart="${repoRoot}/scripts/snapshot-qdrant.sh"`);
    expect(readFileSync(join(units, "snapshot-qdrant.timer"), "utf-8")).not.toMatch(/@\w+@/);
  });

  it("quotes and encodes a checkout path containing a space", () => {
    const spaced = join(dir, "my brain");
    mkdirSync(join(spaced, "scripts"), { recursive: true });
    mkdirSync(join(spaced, "daemon"), { recursive: true });
    writeFileSync(join(spaced, "scripts", "snapshot-qdrant.sh"), "#!/bin/bash\n");
    writeFileSync(join(spaced, "daemon", "watcher.ts"), "");
    for (const f of ["snapshot-qdrant.service", "snapshot-qdrant.timer", "the-brain-watcher.service"]) {
      writeFileSync(join(spaced, "scripts", f), readFileSync(join(repoRoot, "scripts", f)));
    }
    mkdirSync(join(spaced, "scripts", "lib"), { recursive: true });
    writeFileSync(join(spaced, "scripts", "lib", "render-unit.sh"), readFileSync(join(repoRoot, "scripts", "lib", "render-unit.sh")));
    for (const f of ["install-timer.sh", "install-watcher.sh"]) {
      writeFileSync(join(spaced, "scripts", f), readFileSync(join(repoRoot, "scripts", f)));
    }
    const timer = spawnSync("bash", [join(spaced, "scripts", "install-timer.sh"), "--unit-dir", units, "--no-enable"], { encoding: "utf-8" });
    expect(timer.status).toBe(0);
    const svc = readFileSync(join(units, "snapshot-qdrant.service"), "utf-8");
    expect(svc).toContain(`ExecStart="${spaced}/scripts/snapshot-qdrant.sh"`);
    expect(svc).toContain(`Documentation=file://${spaced.replace(/ /g, "%%20")}/README.md`);
    const watcher = spawnSync("bash", [join(spaced, "scripts", "install-watcher.sh"), "--unit-dir", units, "--no-enable"], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    expect(watcher.status).toBe(0);
    expect(readFileSync(join(units, "the-brain-watcher.service"), "utf-8")).toContain(`WorkingDirectory=${spaced}`);
  });

  it("refuses a path with a double quote", () => {
    const bad = join(dir, 'a"b');
    mkdirSync(join(bad, "scripts"), { recursive: true });
    mkdirSync(join(bad, "daemon"), { recursive: true });
    writeFileSync(join(bad, "daemon", "watcher.ts"), "");
    const r = sh("install-watcher.sh", "--root", bad, "--unit-dir", units, "--no-enable");
    expect(r.status).toBe(1);
  });
});
