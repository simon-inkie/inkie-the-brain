import "../core/env.js";
import { resolve, join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "../core/config.js";
import { indexAll, indexFile } from "../core/indexer/files.js";
import { embedText } from "../core/embedder/text.js";
import { search, ensureCollections, client } from "../core/qdrant/client.js";
import { crossLinkFile, crossLinkAll } from "../core/cross-linker/index.js";
import { indexAllMessages, getMessageContext } from "../core/indexer/messages.js";
import { indexAllAssets, indexAssetFile, listAssets } from "../core/indexer/assets.js";

const args = process.argv.slice(2);
const command = args[0];

async function runIndex() {
  const fileFlag = args.indexOf("--file");
  if (fileFlag !== -1 && args[fileFlag + 1]) {
    const filePath = resolve(args[fileFlag + 1]);
    await indexFile(filePath);
  } else {
    await indexAll();
  }
}

async function runSearch() {
  const tokens = args.slice(1);
  const consumed = new Set<number>();
  function flagValue(name: string): string | undefined {
    const i = tokens.indexOf(name);
    if (i === -1) return undefined;
    consumed.add(i);
    consumed.add(i + 1);
    return tokens[i + 1];
  }
  const collectionFlag = flagValue("--collection");
  const agentsFlag = flagValue("--agents");
  const query = tokens
    .filter((_, i) => !consumed.has(i) && !tokens[i].startsWith("--"))
    .join(" ");
  if (!query) {
    console.error(
      'Usage: tsx cli/index.ts search "your query" [--collection name] [--agents name1,name2,__own__]',
    );
    process.exit(1);
  }

  const allCollections = Object.values(config.collections);
  const collections = collectionFlag ? [collectionFlag] : allCollections;

  const agents = agentsFlag
    ? agentsFlag
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .flatMap((a) =>
          a === "__own__"
            ? process.env.AGENT_NAME
              ? [process.env.AGENT_NAME]
              : []
            : [a],
        )
    : undefined;

  await ensureCollections();
  const queryVector = await embedText(query, "RETRIEVAL_QUERY");
  const results = await search(
    collections,
    queryVector,
    config.searchDefaults.limit,
    config.searchDefaults.scoreThreshold,
    agents && agents.length > 0 ? { agentNames: agents } : undefined,
  );

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  for (const r of results) {
    console.log(`\n--- [${r.score.toFixed(3)}] ${r.title} ---`);
    console.log(`Source: ${r.source}`);
    console.log(`Collection: ${r.collection}`);
    if (r.tags.length > 0) console.log(`Tags: ${r.tags.join(", ")}`);
    if (r.date) console.log(`Date: ${r.date}`);
    // Show first 300 chars of content
    const preview = r.content.length > 300
      ? r.content.slice(0, 300) + "..."
      : r.content;
    console.log(preview);
  }

  console.log(`\n${results.length} results found.`);
}

async function runStats() {
  await ensureCollections();
  const allCollections = Object.values(config.collections);

  console.log("the-brain collection stats:\n");
  for (const name of allCollections) {
    try {
      const info = await client.getCollection(name);
      console.log(`  ${name}: ${info.points_count ?? 0} points`);
    } catch {
      console.log(`  ${name}: (not found)`);
    }
  }

  // Show last index time from state
  try {
    const { readFile } = await import("fs/promises");
    const state = JSON.parse(await readFile(config.indexStatePath, "utf-8"));
    if (state.lastFullIndex) {
      console.log(`\nLast full index: ${state.lastFullIndex}`);
    }
    console.log(`Tracked files: ${Object.keys(state.files).length}`);
  } catch {
    console.log("\nNo index state found. Run 'pnpm index' first.");
  }
}

async function runCrossLink() {
  await ensureCollections();

  const fileArg = args[1];
  if (fileArg && fileArg !== "--all") {
    const filePath = resolve(fileArg);
    const count = await crossLinkFile(filePath);
    if (count > 0) {
      console.error(`Cross-linked ${count} brain files to ${filePath}`);
    } else {
      console.error(`No related brain files found (or already linked)`);
    }
  } else {
    const result = await crossLinkAll();
    console.error(
      `\nDone: ${result.linked} observations cross-linked, ${result.skipped} skipped`
    );
  }
}

async function runIndexMessages() {
  const sessionFlag = args.indexOf("--session");
  const singleSession =
    sessionFlag !== -1 && args[sessionFlag + 1]
      ? args[sessionFlag + 1]
      : undefined;

  const agentFlag = args.indexOf("--agent");
  const agentFilter =
    agentFlag !== -1 && args[agentFlag + 1]
      ? args[agentFlag + 1]
      : undefined;

  const result = await indexAllMessages(singleSession, agentFilter);

  console.error(
    `\nDone: ${result.sessionsProcessed} sessions processed, ${result.indexed} messages indexed, ${result.skipped} unchanged`
  );
}

async function runContext() {
  const timestamp = args[1];
  if (!timestamp) {
    console.error("Usage: tsx src/cli.ts context <timestamp>");
    console.error("  timestamp: ISO string or epoch ms");
    process.exit(1);
  }

  const windowFlag = args.indexOf("--window");
  const windowMinutes =
    windowFlag !== -1 && args[windowFlag + 1]
      ? parseInt(args[windowFlag + 1])
      : 15;

  const limitFlag = args.indexOf("--limit");
  const limit =
    limitFlag !== -1 && args[limitFlag + 1]
      ? parseInt(args[limitFlag + 1])
      : 30;

  const messages = await getMessageContext(timestamp, windowMinutes, limit);

  if (messages.length === 0) {
    console.log("No messages found in that time window.");
    return;
  }

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const sender = msg.role === "user" ? "Simon" : "Io";
    const preview =
      msg.content.length > 200
        ? msg.content.slice(0, 200) + "..."
        : msg.content;
    console.log(`[${time}] ${sender}: ${preview}`);
  }

  console.log(`\n${messages.length} messages found.`);
}

async function runIndexAssets() {
  const fileFlag = args.indexOf("--file");
  if (fileFlag !== -1 && args[fileFlag + 1]) {
    const filePath = resolve(args[fileFlag + 1]);
    await indexAssetFile(filePath);
  } else {
    const stats = await indexAllAssets();
    console.error(
      `\nDone: ${stats.images} images, ${stats.pdfs} PDFs, ${stats.audio} audio files indexed (${stats.chunks} chunks), ${stats.skipped} unchanged`
    );
  }
}

async function runAssets() {
  const assets = await listAssets();

  if (assets.length === 0) {
    console.log("No indexed assets. Run 'pnpm index-assets' first.");
    return;
  }

  console.log("Indexed assets:\n");
  for (const a of assets) {
    const typeIcon =
      a.assetType === "image" ? "[IMG]" :
      a.assetType === "pdf" ? "[PDF]" :
      a.assetType === "audio" ? "[AUD]" : "[???]";
    const desc = a.description ? ` — ${a.description}` : "";
    console.log(`  ${typeIcon} ${a.source}${desc}`);
  }

  console.log(`\n${assets.length} assets indexed.`);
}

function runAgentInit() {
  const sub = args[1];
  if (sub !== "init") {
    console.error('Usage: tsx cli/index.ts agent init <name> [--link <dir>]');
    process.exit(1);
  }

  const name = args[2];
  if (!name || name.startsWith("--")) {
    console.error("agent init: missing <name> (e.g. voice-polish-bot)");
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    console.error(
      `agent init: invalid name "${name}" — use alphanumeric + hyphens only`,
    );
    process.exit(1);
  }

  const linkFlag = args.indexOf("--link");
  const linkDir =
    linkFlag !== -1 && args[linkFlag + 1]
      ? resolve(args[linkFlag + 1])
      : undefined;

  // repoRoot = two levels up from cli/index.ts
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(here), "..");
  const templatesDir = join(repoRoot, "templates");
  for (const f of ["OBSERVATION-PROMPT.md", "live-state.json", "MEMORY.md"]) {
    if (!existsSync(join(templatesDir, f))) {
      console.error(`agent init: template missing at ${join(templatesDir, f)}`);
      process.exit(1);
    }
  }

  const agentDir = join(homedir(), ".the-brain", "agents", name);
  const memoryDir = join(agentDir, "memory");
  if (existsSync(memoryDir)) {
    console.error(
      `agent init: ${memoryDir} already exists — refusing to overwrite`,
    );
    process.exit(1);
  }

  mkdirSync(join(memoryDir, "observations"), { recursive: true });
  mkdirSync(join(memoryDir, "observer-pointers"), { recursive: true });
  copyFileSync(
    join(templatesDir, "OBSERVATION-PROMPT.md"),
    join(memoryDir, "OBSERVATION-PROMPT.md"),
  );
  copyFileSync(
    join(templatesDir, "live-state.json"),
    join(memoryDir, "live-state.json"),
  );
  copyFileSync(join(templatesDir, "MEMORY.md"), join(agentDir, "MEMORY.md"));
  writeFileSync(join(memoryDir, "observer-state.json"), "{}\n");

  console.log(`✅ Created agent dir: ${agentDir}`);
  console.log(`   memory/OBSERVATION-PROMPT.md  (observation contract)`);
  console.log(`   memory/live-state.json        (era-compression state)`);
  console.log(`   memory/observer-state.json    (bootstrap state)`);
  console.log(`   memory/observations/          (empty)`);
  console.log(`   memory/observer-pointers/     (empty)`);
  console.log(`   MEMORY.md                     (live-block template)`);

  if (linkDir) {
    if (!existsSync(linkDir)) {
      console.error(`--link: dir ${linkDir} does not exist`);
      process.exit(1);
    }
    const pointerDir = join(linkDir, ".the-brain");
    mkdirSync(pointerDir, { recursive: true });
    writeFileSync(join(pointerDir, "memory_root"), memoryDir + "\n");
    console.log(
      `✅ Linked ${linkDir}/.the-brain/memory_root → ${memoryDir}`,
    );
    console.log(`   Add ".the-brain/" to ${linkDir}/.gitignore to keep the pointer local.`);
  } else {
    console.log();
    console.log(`Next: link a worktree by running in it:`);
    console.log(
      `   tsx ${repoRoot}/cli/index.ts agent init ${name} --link .`,
    );
    console.log(
      `(safe to re-run; already-created dirs are refused, but --link can be added.)`,
    );
  }
}

async function main() {
  switch (command) {
    case "index":
      await runIndex();
      break;
    case "search":
      await runSearch();
      break;
    case "stats":
      await runStats();
      break;
    case "cross-link":
      await runCrossLink();
      break;
    case "index-messages":
      await runIndexMessages();
      break;
    case "context":
      await runContext();
      break;
    case "index-assets":
      await runIndexAssets();
      break;
    case "assets":
      await runAssets();
      break;
    case "agent":
      runAgentInit();
      break;
    default:
      console.error("Usage: tsx cli/index.ts <command>");
      console.error("  index [--file <path>]       Index all files or a single file");
      console.error('  search "query" [--agents a,b,__own__]  Semantic search');
      console.error("  stats                       Show collection statistics");
      console.error("  cross-link <file>           Cross-link observation to brain files");
      console.error("  cross-link --all            Cross-link all observations");
      console.error("  index-messages [--session]  Index conversation messages");
      console.error("  context <timestamp>         Show messages around a timestamp");
      console.error("  index-assets [--file <path>] Index images, PDFs, and audio");
      console.error("  assets                      List all indexed assets");
      console.error("  agent init <name> [--link <dir>]  Create a new agent memory silo");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
