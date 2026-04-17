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

// templates/ — seed files copied into new MEMORY_DIRs at init time
// (OBSERVATION-PROMPT.md etc.). Ship them with every adapter so anyone
// spinning up a fresh memory dir can reach them.
const templatesSrc = join(ROOT, "templates");
if (existsSync(templatesSrc)) {
  cpSync(templatesSrc, join(hooksDist, "templates"), { recursive: true });
  log("templates copied");
}

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

// ===========================================================================
// CLAUDE CODE ADAPTER
// ===========================================================================

const ccDist = join(DIST, "claude-code");
mkdirSync(join(ccDist, "bin"), { recursive: true });

const CC_HANDLERS = ["user-prompt-submit", "on-stop", "on-pre-compact"];

for (const handler of CC_HANDLERS) {
  await build({
    entryPoints: [
      join(ROOT, "adapters/claude-code/src", `${handler}.ts`),
    ],
    outfile: join(ccDist, `${handler}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNALS,
    sourcemap: "inline",
    logLevel: "warning",
  });
  log(`claude-code handler bundled: ${handler}`);
}

// Copy shell wrappers + keep them executable.
for (const handler of CC_HANDLERS) {
  const srcBin = join(ROOT, "adapters/claude-code/bin", `${handler}.sh`);
  const dstBin = join(ccDist, "bin", `${handler}.sh`);
  cpSync(srcBin, dstBin);
  chmodSync(dstBin, 0o755);
}
log("claude-code bin scripts copied");

// memory-tools travels with the adapter so the hook resolves observe.sh
// via CLAUDE_PLUGIN_ROOT/memory-tools without any env-var gymnastics.
cpSync(
  join(ROOT, "adapters/openclaw/hooks/memory-tools"),
  join(ccDist, "memory-tools"),
  { recursive: true },
);
for (const f of ["observe.sh", "reflect.sh", "build-context.sh", "compress-era.sh"]) {
  const p = join(ccDist, "memory-tools", f);
  if (existsSync(p)) chmodSync(p, 0o755);
}
log("claude-code memory-tools copied");

if (existsSync(templatesSrc)) {
  cpSync(templatesSrc, join(ccDist, "templates"), { recursive: true });
  log("claude-code templates copied");
}

// Copy Claude Code plugin manifest + hook manifest if present (Phase 6).
const ccPluginSrc = join(ROOT, "adapters/claude-code/.claude-plugin");
if (existsSync(ccPluginSrc)) {
  cpSync(ccPluginSrc, join(ccDist, ".claude-plugin"), { recursive: true });
  log("claude-code .claude-plugin copied");
}
const ccHooksSrc = join(ROOT, "adapters/claude-code/hooks");
if (existsSync(ccHooksSrc)) {
  cpSync(ccHooksSrc, join(ccDist, "hooks"), { recursive: true });
  log("claude-code hooks manifest copied");
}

// Adapter package.json — runtime deps mirror what the bundled handlers
// actually call at runtime (@google/genai for observe.sh's Node helpers,
// qdrant/image/pdf bits for indexer/media-filer when they run under CC).
const ccPkg = {
  name: "greymatter-claude-code",
  version: rootPkg.version,
  description:
    "greymatter Claude Code adapter — UserPromptSubmit/Stop/PreCompact hooks. Prebuilt, self-contained.",
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
};
writeFileSync(
  join(ccDist, "package.json"),
  JSON.stringify(ccPkg, null, 2) + "\n",
);
log(`wrote ${ccDist}/package.json`);

log("build complete");
log(`  install plugin:       openclaw plugins install ${pluginDist}`);
log(`  install hooks:        openclaw plugins install ${hooksDist}`);
log(`  claude-code adapter:  ${ccDist}`);

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
