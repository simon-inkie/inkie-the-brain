import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, lstatSync, statSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mergeHooks, SettingsShapeError } from "../../scripts/lib/merge-hooks.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = "/opt/checkout-a/dist/claude-code/bin";

describe("mergeHooks", () => {
  it("adds all four entries to an empty settings object", () => {
    const s: any = {};
    const r = mergeHooks(s, BIN);
    expect(r.map((x) => x.status)).toEqual(["added", "added", "added", "added"]);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`'${BIN}/user-prompt-submit.sh'`);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`'${BIN}/on-stop.sh'`);
    expect(s.hooks.PreCompact.map((g: any) => g.matcher)).toEqual(["auto", "manual"]);
  });

  it("is idempotent", () => {
    const s: any = {};
    mergeHooks(s, BIN);
    const snapshot = JSON.stringify(s);
    const r = mergeHooks(s, BIN);
    expect(r.every((x) => x.status === "unchanged")).toBe(true);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("keeps other settings and other hooks, including on the same event", () => {
    const s: any = {
      model: "x",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "/a/b.sh" }] }],
      },
    };
    mergeHooks(s, BIN);
    expect(s.model).toBe("x");
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe("/usr/local/bin/mine.sh");
  });

  it("rewrites a stale path from another checkout instead of duplicating", () => {
    const s: any = {};
    mergeHooks(s, "/opt/old-clone/dist/claude-code/bin");
    const r = mergeHooks(s, "/srv/deck/vendor/brain-copy/dist/claude-code/bin");
    expect(r.every((x) => x.status === "updated")).toBe(true);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(
      "'/srv/deck/vendor/brain-copy/dist/claude-code/bin/on-stop.sh'",
    );
    expect(s.hooks.PreCompact).toHaveLength(2);
  });

  it("writes shell-safe commands for paths with spaces, quotes and $(...)", () => {
    const nasty = "/tmp/sp ace/b$(touch PWNED);x/it's/claude-code/bin";
    const s: any = {};
    mergeHooks(s, nasty);
    const cmd = s.hooks.Stop[0].hooks[0].command as string;
    // Run it through a shell as Claude Code does: it must name the file, nothing else.
    const out = spawnSync("bash", ["-c", `printf '%s' ${cmd}`], { encoding: "utf-8", cwd: tmpdir() });
    expect(out.stdout).toBe(`${nasty}/on-stop.sh`);
    // and a rerun recognises its own quoted entry
    expect(mergeHooks(s, nasty).every((x) => x.status === "unchanged")).toBe(true);
  });

  it("upgrades a legacy unquoted entry in place", () => {
    const s: any = { hooks: { Stop: [{ hooks: [{ type: "command", command: `${BIN}/on-stop.sh` }] }] } };
    mergeHooks(s, BIN);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`'${BIN}/on-stop.sh'`);
  });

  it("treats a catch-all matcher on Stop as the same group", () => {
    const s: any = { hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: `/old/claude-code/bin/on-stop.sh` }] }] } };
    mergeHooks(s, BIN);
    expect(s.hooks.Stop).toHaveLength(1);
  });

  it("rejects shapes it cannot merge safely", () => {
    expect(() => mergeHooks([], BIN)).toThrow(SettingsShapeError);
    expect(() => mergeHooks({ hooks: [] }, BIN)).toThrow(SettingsShapeError);
    expect(() => mergeHooks({ hooks: { Stop: {} } }, BIN)).toThrow(SettingsShapeError);
  });
});

describe("install-hooks.mjs", () => {
  let dir: string;
  let dist: string;
  let settings: string;

  beforeEach(() => {
    dir = join(tmpdir(), `tb-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dist = join(dir, "odd-clone-name", "dist", "claude-code");
    settings = join(dir, "home", ".claude", "settings.json");
    mkdirSync(join(dist, "bin"), { recursive: true });
    for (const f of ["user-prompt-submit.sh", "on-stop.sh", "on-pre-compact.sh"]) {
      writeFileSync(join(dist, "bin", f), "#!/bin/bash\n");
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...extra: string[]) =>
    spawnSync(
      "node",
      [join(repoRoot, "scripts", "install-hooks.mjs"), "--settings", settings, "--dist", dist, ...extra],
      { encoding: "utf-8" },
    );

  it("creates the file, then a second run changes nothing", () => {
    expect(run().status).toBe(0);
    const first = readFileSync(settings, "utf-8");
    const again = run();
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already current/);
    expect(readFileSync(settings, "utf-8")).toBe(first);
  });

  it("backs up an existing file once and preserves its content", () => {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ theme: "dark" }));
    expect(run().status).toBe(0);
    expect(JSON.parse(readFileSync(`${settings}.the-brain.bak`, "utf-8"))).toEqual({ theme: "dark" });
    expect(JSON.parse(readFileSync(settings, "utf-8")).theme).toBe("dark");
  });

  it("writes through a symlinked settings.json and keeps its mode", () => {
    const real = join(dir, "dotfiles", "real.json");
    mkdirSync(dirname(real), { recursive: true });
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(real, JSON.stringify({ theme: "dark" }));
    chmodSync(real, 0o600);
    symlinkSync(real, settings);
    expect(run().status).toBe(0);
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(real, "utf-8")).hooks.Stop).toHaveLength(1);
    expect(JSON.parse(readFileSync(real, "utf-8")).theme).toBe("dark");
  });

  it("exits 3 on invalid JSON and leaves the file byte-identical", () => {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, "{ not json");
    const r = run();
    expect(r.status).toBe(3);
    expect(readFileSync(settings, "utf-8")).toBe("{ not json");
  });

  it("exits 2 when the build output is missing", () => {
    rmSync(join(dist, "bin", "on-stop.sh"));
    expect(run().status).toBe(2);
    expect(existsSync(settings)).toBe(false);
  });

  it("--dry-run writes nothing", () => {
    expect(run("--dry-run").status).toBe(0);
    expect(existsSync(settings)).toBe(false);
  });

  it("exits 1 on an unknown argument", () => {
    expect(run("--nope").status).toBe(1);
  });
});
