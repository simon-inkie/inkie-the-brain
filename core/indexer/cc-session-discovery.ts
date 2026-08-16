import { homedir } from "os";
import { basename, join } from "path";
import { readdir, readFile, stat } from "fs/promises";

const CC_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface DiscoveredSession {
  projectDir: string;
  agentName: string;
  filePath: string;
  sessionId: string;
}

/**
 * Discover Claude Code session JSONL files for indexing.
 *
 * Attribution is derived from the session itself. There is deliberately no
 * name table here: a hardcoded directory-to-agent map has to be edited every
 * time an agent is added or a project moves, and it silently stops indexing
 * whatever it has not been told about. Convention beats configuration.
 *
 * Per-session agent attribution falls through this chain:
 *   1. Read the JSONL's first line for `cwd`. If found, take the *basename*
 *      of that path — for a session that ran in `~/agents/researcher/`, that's
 *      `researcher`. For `~/git-repos/web-api/`, that's `web-api`.
 *      One agent per working directory: simple, conventional, no config.
 *   2. Fall back to the indexer's own `process.env.AGENT_NAME`.
 *   3. Fall back to the literal string `"default"`.
 *
 * Multi-agent users who keep each agent in its own dir get correct
 * attribution automatically (no config needed). Single-dir users get a
 * single bucket per dir, or set `AGENT_NAME` globally to override.
 *
 * Subagent files are skipped — parent sessions reference them in their
 * summaries; indexing both would double-count.
 *
 * `skippedDirs` and `unmappedDirs` are part of the return shape because the
 * indexer logs them, but nothing is skipped or left unmapped under this
 * attribution scheme, so both are always empty. They are the extension point
 * for a future filter, not dead weight to be pruned.
 */
export async function discoverCCSessions(): Promise<{
  sessions: DiscoveredSession[];
  skippedDirs: string[];
  unmappedDirs: string[];
}> {
  const fallbackAgentName = process.env.AGENT_NAME ?? "default";
  const sessions: DiscoveredSession[] = [];
  const skippedDirs: string[] = [];
  const unmappedDirs: string[] = [];

  // Cache project-dir → resolved agent name. All sessions in the same CC
  // project dir share the same `cwd`, so we only need to resolve once.
  const dirAgentCache = new Map<string, string>();

  let dirs: string[];
  try {
    dirs = await readdir(CC_PROJECTS_DIR);
  } catch {
    return { sessions, skippedDirs, unmappedDirs };
  }

  for (const dirName of dirs) {
    const dirPath = join(CC_PROJECTS_DIR, dirName);
    let dirStat;
    try {
      dirStat = await stat(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue;
    }

    const jsonlFiles = entries.filter(
      (f) => f.endsWith(".jsonl") && !f.includes("subagent")
    );

    for (const file of jsonlFiles) {
      const filePath = join(dirPath, file);
      const sessionId = file.replace(".jsonl", "");

      let agentName = dirAgentCache.get(dirName);
      if (agentName === undefined) {
        agentName = await resolveAgentForProjectDir(filePath, fallbackAgentName);
        dirAgentCache.set(dirName, agentName);
      }

      sessions.push({
        projectDir: dirName,
        agentName,
        filePath,
        sessionId,
      });
    }
  }

  return { sessions, skippedDirs, unmappedDirs };
}

/**
 * Read the first JSONL line, extract `cwd`, return its basename. This is
 * the agent name. Falls back if anything is missing.
 */
async function resolveAgentForProjectDir(
  jsonlPath: string,
  fallback: string,
): Promise<string> {
  try {
    const content = await readFile(jsonlPath, "utf-8");
    const firstLine = content.split("\n", 1)[0];
    if (firstLine) {
      const parsed = JSON.parse(firstLine);
      if (typeof parsed?.cwd === "string" && parsed.cwd.length > 0) {
        const name = basename(parsed.cwd);
        if (name && name !== "/" && name !== ".") return name;
      }
    }
  } catch {
    // Fall through
  }
  return fallback;
}
