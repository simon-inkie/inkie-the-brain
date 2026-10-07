#!/usr/bin/env node
/**
 * install-hooks: merge the-brain's four Claude Code hook entries into a
 * settings.json, idempotently, without clobbering anything else.
 *
 *   node scripts/install-hooks.mjs [--settings FILE] [--dist DIR] [--dry-run]
 *
 *   --settings FILE  target (default ~/.claude/settings.json); created if absent
 *   --dist DIR       built adapter (default <checkout>/dist/claude-code)
 *   --dry-run        report what would change, write nothing
 *
 * Exit codes: 0 ok (changed or already current), 1 bad arguments,
 *             2 the build output is missing, 3 settings.json is not usable
 *             (invalid JSON or an unexpected shape). Nothing is written on 3.
 *
 * The first time an existing file is changed, the original is kept beside it
 * as <file>.the-brain.bak. An existing backup is never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mergeHooks, HOOK_SPECS, SettingsShapeError } from "./lib/merge-hooks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(code, msg) {
  console.error(`install-hooks: ${msg}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
let settingsPath = join(homedir(), ".claude", "settings.json");
let dist = join(root, "dist", "claude-code");
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--settings" || a === "--dist") {
    if (!argv[i + 1]) fail(1, `${a} needs a value`);
    if (a === "--settings") settingsPath = resolve(argv[++i]);
    else dist = resolve(argv[++i]);
  } else if (a === "--dry-run") dryRun = true;
  else fail(1, `unknown argument ${a}`);
}

const binDir = join(dist, "bin");
for (const spec of HOOK_SPECS) {
  if (!existsSync(join(binDir, spec.script))) {
    fail(2, `${join(binDir, spec.script)} not found; run pnpm build first`);
  }
}

let settings = {};
let existed = false;
let original = "";
if (existsSync(settingsPath)) {
  existed = true;
  original = readFileSync(settingsPath, "utf8");
  if (original.trim() !== "") {
    try {
      settings = JSON.parse(original);
    } catch (e) {
      fail(3, `${settingsPath} is not valid JSON (${e.message}); left untouched`);
    }
  }
}

let results;
try {
  results = mergeHooks(settings, binDir);
} catch (e) {
  if (e instanceof SettingsShapeError) fail(3, `${settingsPath}: ${e.message}; left untouched`);
  throw e;
}

for (const r of results) {
  console.log(`  ${r.event}${r.matcher ? ` (${r.matcher})` : ""}: ${r.status}`);
}

const changed = results.some((r) => r.status !== "unchanged");
if (!changed) {
  console.log(`install-hooks: ${settingsPath} already current`);
} else if (dryRun) {
  console.log(`install-hooks: dry run, ${settingsPath} not written`);
} else {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const backup = `${settingsPath}.the-brain.bak`;
  if (existed && original.trim() !== "" && !existsSync(backup)) copyFileSync(settingsPath, backup);
  const tmp = `${settingsPath}.the-brain.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);
  console.log(`install-hooks: wrote ${settingsPath}`);
}
