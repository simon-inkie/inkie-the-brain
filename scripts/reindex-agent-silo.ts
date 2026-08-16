// One-off: reindex a single agent silo (observations + reflections + MEMORY.md).
// Usage: tsx scripts/reindex-agent-silo.ts <agent-name>
// Skips drift check + full reindex; state is loaded, per-file hash dedup applies.
//
// Also seeds the runtime scaffolding (MEMORY.md, OBSERVATION-PROMPT.md,
// live-state.json) from the-brain's templates/ if absent — so a post-
// migration silo is immediately usable by the context-injection hook.
// `the-brain agent init` refuses on existing silos; this helper fills the
// gap for silos that predate or were merged into by a migration.

import "../core/env.js";
import { readdir, stat, copyFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { indexFile } from "../core/indexer/files.js";
import { ensureCollections } from "../core/qdrant/client.js";

const agentName = process.argv[2];
if (!agentName) {
  console.error("Usage: tsx scripts/reindex-agent-silo.ts <agent-name>");
  process.exit(1);
}

const agentRoot = join(homedir(), ".the-brain", "agents", agentName);
if (!existsSync(agentRoot)) {
  console.error(`No silo at ${agentRoot}`);
  process.exit(1);
}

// Seed runtime scaffolding from the-brain's templates if missing. Safe to
// re-run — never overwrites existing files. Matches what
// `the-brain agent init` creates for a fresh silo.
async function seedScaffolding(agentRoot: string): Promise<void> {
  // repoRoot = one level up from scripts/, same resolution the CLI's
  // `agent init` uses, so the seed works from any checkout location.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const templatesDir = join(repoRoot, "templates");
  if (!existsSync(templatesDir)) {
    console.error(
      `[seed] templates dir missing at ${templatesDir} — skipping scaffolding seed`,
    );
    return;
  }
  const memoryDir = join(agentRoot, "memory");
  await mkdir(join(memoryDir, "observations"), { recursive: true });
  await mkdir(join(memoryDir, "observer-pointers"), { recursive: true });
  await mkdir(join(memoryDir, "reflections"), { recursive: true });
  await mkdir(join(memoryDir, "prompts"), { recursive: true });

  const pairs: [string, string][] = [
    [join(templatesDir, "MEMORY.md"), join(agentRoot, "MEMORY.md")],
    [
      join(templatesDir, "OBSERVATION-PROMPT.md"),
      join(memoryDir, "OBSERVATION-PROMPT.md"),
    ],
    [
      join(templatesDir, "live-state.json"),
      join(memoryDir, "live-state.json"),
    ],
    [
      join(templatesDir, "prompts", "compress-era-level-0.md"),
      join(memoryDir, "prompts", "compress-era-level-0.md"),
    ],
    [
      join(templatesDir, "prompts", "compress-era-level-1.md"),
      join(memoryDir, "prompts", "compress-era-level-1.md"),
    ],
    [
      join(templatesDir, "prompts", "compress-era-level-2.md"),
      join(memoryDir, "prompts", "compress-era-level-2.md"),
    ],
    [
      join(templatesDir, "prompts", "compress-era-level-3.md"),
      join(memoryDir, "prompts", "compress-era-level-3.md"),
    ],
    [
      join(templatesDir, "prompts", "compress-era-cap.md"),
      join(memoryDir, "prompts", "compress-era-cap.md"),
    ],
  ];
  for (const [src, dst] of pairs) {
    if (existsSync(dst)) {
      console.error(`[seed] exists: ${dst.replace(homedir(), "~")}`);
      continue;
    }
    if (!existsSync(src)) {
      console.error(`[seed] template missing: ${src}`);
      continue;
    }
    await copyFile(src, dst);
    console.error(`[seed] wrote: ${dst.replace(homedir(), "~")}`);
  }
}

await seedScaffolding(agentRoot);

async function collect(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    const full = join(dir, e);
    const st = await stat(full);
    if (st.isFile()) out.push(full);
  }
  return out;
}

const targets: string[] = [];
targets.push(...(await collect(join(agentRoot, "memory", "observations"))));
targets.push(...(await collect(join(agentRoot, "memory", "reflections"))));
const memoryMd = join(agentRoot, "MEMORY.md");
if (existsSync(memoryMd)) targets.push(memoryMd);

console.error(`Reindexing ${targets.length} files from ${agentName} silo...`);
await ensureCollections();

let ok = 0,
  fail = 0,
  skipped = 0;
for (const [i, f] of targets.entries()) {
  try {
    const rel = f.replace(homedir(), "~");
    process.stderr.write(`[${i + 1}/${targets.length}] ${rel}... `);
    await indexFile(f);
    ok++;
    process.stderr.write("ok\n");
  } catch (e) {
    fail++;
    process.stderr.write(`FAIL: ${(e as Error).message}\n`);
    // Pause on rate-limit — likely a 429; small wait then continue
    if (String(e).includes("429") || String(e).includes("RESOURCE_EXHAUSTED")) {
      console.error("[sleep 30s for rate limit]");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}
console.error(`\nDone: ${ok} ok, ${fail} failed, ${skipped} skipped`);
