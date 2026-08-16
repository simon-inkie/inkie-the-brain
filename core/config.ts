import { homedir } from "os";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";

const home = homedir();

// ---------------------------------------------------------------------------
// Agent discovery (the-brain agents registry)
// ---------------------------------------------------------------------------
// Each agent has a memory silo at ~/.the-brain/agents/<name>/memory/. The
// agent name is the dir name. If a matching persona repo exists at ~/<name>/,
// brain-todos/dev-notes/persona files there are also watch+index targets.
//
// This generalises beyond the original OpenClaw-only assumption: adding a new
// agent is just `the-brain agent init <name>` — no config edit needed here.

interface Agent {
  name: string;
  memoryDir: string;          // ~/.the-brain/agents/<name>/memory
  agentRoot: string;          // ~/.the-brain/agents/<name>
  personaRepo: string | null; // ~/<name>/ if it exists, else null
}

function discoverAgents(): Agent[] {
  const agentsRoot = join(home, ".the-brain", "agents");
  if (!existsSync(agentsRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(agentsRoot);
  } catch {
    return [];
  }
  const out: Agent[] = [];
  for (const name of entries) {
    const agentRoot = join(agentsRoot, name);
    let isDir = false;
    try {
      isDir = statSync(agentRoot).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const memoryDir = join(agentRoot, "memory");
    if (!existsSync(memoryDir)) continue;
    const personaCandidate = join(home, name);
    const personaRepo = existsSync(personaCandidate) ? personaCandidate : null;
    out.push({ name, memoryDir, agentRoot, personaRepo });
  }
  return out;
}

const agents = discoverAgents();

// Per-agent observation/reflection paths.
const agentObservationDirs = agents
  .map((a) => join(a.memoryDir, "observations"))
  .filter((p) => existsSync(p));

const agentReflectionDirs = agents
  .map((a) => join(a.memoryDir, "reflections"))
  .filter((p) => existsSync(p));

// Per-agent references: DELIBERATE hand-written captures meant to survive
// compaction and be findable. references/ sits BESIDE memory/ (under
// agentRoot), not inside it, so it fell outside every source glob and was
// unsearchable. Indexed into the reflections collection — it is curated
// durable knowledge, the same class as a reflection.
const agentReferenceDirs = agents
  .map((a) => join(a.agentRoot, "references"))
  .filter((p) => existsSync(p));

// Per-agent MEMORY.md files (live block at <agent>/MEMORY.md, one level above memory/).
const agentMemoryMdPaths = agents
  .map((a) => join(a.agentRoot, "MEMORY.md"))
  .filter((p) => existsSync(p));

// Per-agent persona repos: brain-todos, dev-notes, top-level .md files.
// Top-level .md files are added as discovered files (not dirs) so the watcher
// catches edits to IDENTITY/SOUL/TOOLS/USER/CLAUDE without picking up node_modules.
const agentPersonaWatchPaths: string[] = [];
for (const a of agents) {
  if (!a.personaRepo) continue;
  for (const sub of ["brain-todos", "dev-notes"]) {
    const dir = join(a.personaRepo, sub);
    if (existsSync(dir)) agentPersonaWatchPaths.push(dir);
  }
  // Top-level .md files
  try {
    for (const entry of readdirSync(a.personaRepo)) {
      if (!entry.endsWith(".md")) continue;
      const full = join(a.personaRepo, entry);
      try {
        if (statSync(full).isFile()) agentPersonaWatchPaths.push(full);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

// ---------------------------------------------------------------------------
// Brain — symlink-covered, single source of truth
// ---------------------------------------------------------------------------
// BRAIN_VAULT_DIR env wins (used by install-test harness, also Path-C
// escape hatch for unusual setups). Default: ~/brain (typically a symlink to
// an Obsidian vault). Legacy fallback: ~/.openclaw/workspace/brain when the
// default doesn't exist.
const brainRoot = process.env.BRAIN_VAULT_DIR || join(home, "brain");
const brainExists = existsSync(brainRoot);

const effectiveBrainRoot = brainExists
  ? brainRoot
  : join(home, ".openclaw", "workspace", "brain");

const brainSubdirs = ["ideas", "decisions", "work", "projects", "learnings"];

// ---------------------------------------------------------------------------
// Messages — TODO: remove OpenClaw fallback after CC sessions take over
// ---------------------------------------------------------------------------
const agentSessionsDirs = agents
  .map((a) => join(a.agentRoot, "sessions"))
  .filter((p) => existsSync(p));

const messagesPath = agentSessionsDirs.length > 0
  ? agentSessionsDirs[0]
  : join(home, ".openclaw", "agents", "main", "sessions");

// ---------------------------------------------------------------------------
// Workspace root — used for relative-path computation in indexer + linker
// ---------------------------------------------------------------------------
const workspaceRoot = join(home, ".openclaw", "workspace");

// ---------------------------------------------------------------------------
// Indexer state directory — where the file/message/asset index state JSONs
// live. Default: `~/.the-brain/state/` (matches the rest of `~/.the-brain/`).
// Legacy default: `~/io-data/` — kept transparently when that directory
// exists, so an existing local setup keeps working without migration.
// Override with BRAIN_STATE_DIR (used by the install-test harness).
// ---------------------------------------------------------------------------
const stateDir = process.env.BRAIN_STATE_DIR
  || (existsSync(join(home, "io-data"))
        ? join(home, "io-data")
        : join(home, ".the-brain", "state"));

// ---------------------------------------------------------------------------
// Final config
// ---------------------------------------------------------------------------

export const config = {
  // QDRANT_URL env override — defaults to local Docker Qdrant on 6333.
  // Documented in QUICKSTART for Qdrant Cloud users (Path C escape hatch)
  // and the install-test harness, which talks to a sidecar at http://qdrant:6333.
  qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",

  embeddingModel: "gemini-embedding-2-preview",
  embeddingDimensions: 768,

  collections: {
    brain: "brain-vault",
    observations: "io-observations",
    reflections: "io-reflections",
    // Env-overridable so a blue-green re-index can build into a fresh
    // collection (BRAIN_MESSAGES_COLLECTION=io-messages-v2) and then alias
    // io-messages -> io-messages-v2 once it verifies. Default unchanged.
    messages: process.env.BRAIN_MESSAGES_COLLECTION ?? "io-messages",
    assets: "io-assets",
  },

  sources: {
    brain: brainSubdirs.map((sub) => join(effectiveBrainRoot, sub)),
    observations: agentObservationDirs,
    reflections: agentReflectionDirs,
    references: agentReferenceDirs,
    messages: messagesPath,
    assets: [join(effectiveBrainRoot, "assets")],
  },

  memoryMdPaths: agentMemoryMdPaths,

  memoryMdPath:
    agentMemoryMdPaths[0] ?? join(workspaceRoot, "MEMORY.md"),

  personaWatchPaths: agentPersonaWatchPaths,

  chunkMaxTokens: 2000,

  searchDefaults: {
    limit: 10,
    scoreThreshold: 0.3,
  },

  indexStatePath: join(stateDir, "io-memory-index-state.json"),

  messageIndexing: {
    minContentLength: 20,
    roles: ["user", "assistant"] as string[],
    skipPatterns: [
      /^HEARTBEAT_OK$/,
      /^NO_REPLY$/,
      /^\[cron:/,
      /^Read HEARTBEAT\.md/,
      /^System: \[/,
      // HARD BLOCK (defence in depth): harness-INJECTED markers that open a
      // message. These are pure system noise, never real conversation, and
      // indexing them is both useless and expensive — an unfiltered run can
      // bleed six figures of embedding calls on notification wrappers alone.
      // Blocked by content, regardless of which source dir they came from.
      //
      // All START-ANCHORED, deliberately. A marker that appears mid-prose (an
      // observation prompt quoting a "Monitor event:" line, or an agent
      // discussing <task-notification> in a design conversation) is legitimate
      // content and MUST pass. An earlier unanchored version of this filter
      // dropped thousands of genuine messages for exactly that reason.
      //
      // BOUNDARY: block only what the HARNESS injects, not what an agent
      // authors. Agent-authored relay pings between agents are coordination
      // signal, a different class, and are kept.
      /^\s*<task-notification>/,
      /^\s*<local-command-caveat>/,
      /^\s*<command-name>/,
      /^\s*<command-message>/,
      /^\s*<system-reminder>/,
    ],
    skipToolOnlyMessages: true,
    // Env-overridable so a blue-green rebuild uses a FRESH state file (a full
    // clean index, not an incremental delta against the live collection's
    // state). Default unchanged.
    stateFile:
      process.env.BRAIN_MESSAGE_INDEX_STATE ??
      join(stateDir, "io-message-index-state.json"),
  },

  assetIndexing: {
    imageExtensions: [".png", ".jpg", ".jpeg", ".gif", ".webp"],
    pdfExtensions: [".pdf"],
    audioExtensions: [".mp3", ".wav", ".m4a", ".ogg", ".webm"],
    maxFileSizeMb: 50,
    maxPdfPages: 50,
    stateFile: join(stateDir, "io-asset-index-state.json"),
    descriptionModel: "gemini-2.5-flash",
  },

  workspaceRoot,

  agents,
};
