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
const brainRoot = join(home, "brain");
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
    messages: "io-messages",
    assets: "io-assets",
  },

  sources: {
    brain: brainSubdirs.map((sub) => join(effectiveBrainRoot, sub)),
    observations: agentObservationDirs,
    reflections: agentReflectionDirs,
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

  indexStatePath: join(home, "io-data", "io-memory-index-state.json"),

  messageIndexing: {
    minContentLength: 20,
    roles: ["user", "assistant"] as string[],
    skipPatterns: [
      /^HEARTBEAT_OK$/,
      /^NO_REPLY$/,
      /^\[cron:/,
      /^Read HEARTBEAT\.md/,
      /^System: \[/,
    ],
    skipToolOnlyMessages: true,
    stateFile: join(home, "io-data", "io-message-index-state.json"),
  },

  assetIndexing: {
    imageExtensions: [".png", ".jpg", ".jpeg", ".gif", ".webp"],
    pdfExtensions: [".pdf"],
    audioExtensions: [".mp3", ".wav", ".m4a", ".ogg", ".webm"],
    maxFileSizeMb: 50,
    maxPdfPages: 50,
    stateFile: join(home, "io-data", "io-asset-index-state.json"),
    descriptionModel: "gemini-2.5-flash",
  },

  workspaceRoot,

  agents,
};
