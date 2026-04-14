import { homedir } from "os";
import { join } from "path";

const home = homedir();
const workspace = join(home, ".openclaw", "workspace");

export const config = {
  // Qdrant
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",

  // Gemini Embedding
  embeddingModel: "gemini-embedding-2-preview",
  embeddingDimensions: 768,

  // Collections
  collections: {
    brain: "brain-vault",
    observations: "io-observations",
    reflections: "io-reflections",
    messages: "io-messages",
    assets: "io-assets",
  },

  // Source directories to index
  sources: {
    brain: [
      join(workspace, "brain", "ideas"),
      join(workspace, "brain", "decisions"),
      join(workspace, "brain", "work"),
      join(workspace, "brain", "projects"),
      join(workspace, "brain", "learnings"),
    ],
    observations: [join(workspace, "memory", "observations")],
    reflections: [join(workspace, "memory", "reflections")],
    messages: join(home, ".openclaw", "agents", "main", "sessions"),
    assets: [join(workspace, "brain", "assets")],
  },

  // MEMORY.md path (indexed into reflections collection, chunked by section)
  memoryMdPath: join(workspace, "MEMORY.md"),

  // Indexing
  chunkMaxTokens: 2000,

  // Search defaults
  searchDefaults: {
    limit: 10,
    scoreThreshold: 0.3,
  },

  // State file for incremental indexing
  indexStatePath: join(home, "io-data", "io-memory-index-state.json"),

  // Message indexing
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

  // Asset indexing
  assetIndexing: {
    imageExtensions: [".png", ".jpg", ".jpeg", ".gif", ".webp"],
    pdfExtensions: [".pdf"],
    audioExtensions: [".mp3", ".wav", ".m4a", ".ogg", ".webm"],
    maxFileSizeMb: 50,
    maxPdfPages: 50,
    stateFile: join(home, "io-data", "io-asset-index-state.json"),
    descriptionModel: "gemini-2.5-flash",
  },

  // Workspace root (for computing relative paths)
  workspaceRoot: workspace,
};
