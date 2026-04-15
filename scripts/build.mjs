#!/usr/bin/env node
/**
 * Build adapters/openclaw/{plugin,hooks} into self-contained `dist/` packages
 * that `openclaw plugins install` can handle without any cross-dir resolution.
 *
 * Strategy:
 *   - esbuild bundles each entry (plugin + each hook handler) into a single
 *     `.js` file with core/ code inlined
 *   - Runtime npm deps (@google/genai, @qdrant/js-client-rest, openclaw, etc.)
 *     stay external — openclaw runs `npm install` inside the pack at install
 *     time, using the pack's package.json dependencies list
 *   - Static assets (openclaw.plugin.json, HOOK.md files, memory-tools/*.sh)
 *     are copied verbatim
 *
 * Output:
 *   dist/plugin/          ← openclaw plugins install ./dist/plugin
 *   dist/hooks/           ← openclaw plugins install ./dist/hooks
 */

import { build } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

// Read root package.json to enumerate runtime deps (stay external).
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const RUNTIME_DEPS = Object.keys(rootPkg.dependencies ?? {});

// Node built-ins are always external.
const NODE_BUILTINS = [
  "fs", "fs/promises", "path", "os", "crypto", "url", "util", "child_process",
  "stream", "events", "buffer", "process", "http", "https", "net", "tls",
  "querystring", "zlib", "readline", "assert",
];
const EXTERNALS = [
  ...NODE_BUILTINS,
  ...NODE_BUILTINS.map((n) => `node:${n}`),
  ...RUNTIME_DEPS,
];

const log = (msg) => console.log(`[build] ${msg}`);

// --- Clean dist ---
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });
log(`cleaned ${DIST}`);

// ===========================================================================
// PLUGIN
// ===========================================================================

const pluginDist = join(DIST, "plugin");
mkdirSync(join(pluginDist, "src"), { recursive: true });

await build({
  entryPoints: [join(ROOT, "adapters/openclaw/plugin/src/index.ts")],
  outfile: join(pluginDist, "src/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
});
log("plugin bundled");

// Plugin manifest (unchanged)
cpSync(
  join(ROOT, "adapters/openclaw/plugin/openclaw.plugin.json"),
  join(pluginDist, "openclaw.plugin.json"),
);

// Plugin package.json — enumerate runtime deps only (no dev, no scripts)
const pluginPkg = {
  name: "greymatter-openclaw-plugin",
  version: rootPkg.version,
  description:
    "OpenClaw context-engine plugin — greymatter. Prebuilt, self-contained.",
  type: "module",
  main: "src/index.js",
  dependencies: pickDeps(rootPkg.dependencies, ["openclaw"]),
  openclaw: { extensions: ["./src/index.js"] },
};
writeFileSync(
  join(pluginDist, "package.json"),
  JSON.stringify(pluginPkg, null, 2) + "\n",
);
log(`wrote ${pluginDist}/package.json`);

// ===========================================================================
// HOOKS
// ===========================================================================

const hooksDist = join(DIST, "hooks");
mkdirSync(hooksDist, { recursive: true });

const HOOKS = ["io-observer", "io-message-indexer", "io-media-filer"];

for (const hook of HOOKS) {
  const srcHookDir = join(ROOT, "adapters/openclaw/hooks/hooks", hook);
  const distHookDir = join(hooksDist, "hooks", hook);
  mkdirSync(distHookDir, { recursive: true });

  await build({
    entryPoints: [join(srcHookDir, "handler.ts")],
    outfile: join(distHookDir, "handler.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNALS,
    sourcemap: "inline",
    logLevel: "warning",
  });

  cpSync(join(srcHookDir, "HOOK.md"), join(distHookDir, "HOOK.md"));
  // Copy SPEC.md if present (io-observer has one)
  const specPath = join(srcHookDir, "SPEC.md");
  if (existsSync(specPath)) {
    cpSync(specPath, join(distHookDir, "SPEC.md"));
  }
  log(`hook bundled: ${hook}`);
}

// memory-tools — shell scripts travel verbatim
cpSync(
  join(ROOT, "adapters/openclaw/hooks/memory-tools"),
  join(hooksDist, "memory-tools"),
  { recursive: true },
);
// Ensure scripts stay executable
for (const f of ["observe.sh", "reflect.sh", "build-context.sh", "compress-era.sh"]) {
  const p = join(hooksDist, "memory-tools", f);
  if (existsSync(p)) chmodSync(p, 0o755);
}
log("memory-tools copied");

// Hook pack package.json
const hooksPkg = {
  name: "greymatter-openclaw-hooks",
  version: rootPkg.version,
  description:
    "OpenClaw hook pack — observer, message-indexer, media-filer. Prebuilt, self-contained.",
  type: "module",
  dependencies: pickDeps(rootPkg.dependencies, [
    "@google/genai",
    "@qdrant/js-client-rest",
    "gray-matter",
    "image-size",
    "pdf-lib",
    "pdfjs-dist",
    "glob",
  ]),
  openclaw: {
    hooks: HOOKS.map((h) => `./hooks/${h}`),
  },
};
writeFileSync(
  join(hooksDist, "package.json"),
  JSON.stringify(hooksPkg, null, 2) + "\n",
);
log(`wrote ${hooksDist}/package.json`);

log("build complete");
log(`  install plugin:  openclaw plugins install ${pluginDist}`);
log(`  install hooks:   openclaw plugins install ${hooksDist}`);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pickDeps(all, names) {
  const out = {};
  for (const n of names) {
    if (all?.[n]) out[n] = all[n];
  }
  return out;
}
