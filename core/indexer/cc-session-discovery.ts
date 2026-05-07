import { homedir } from "os";
import { join } from "path";
import { readdir, stat } from "fs/promises";

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
 * Single-agent v0: every session is attributed to `process.env.AGENT_NAME`
 * (defaulting to `"default"` if unset). Multi-agent auto-mapping by project
 * dir is deferred to v1.
 *
 * Subagent files are skipped — parent sessions reference them in their
 * summaries; indexing both would double-count.
 */
export async function discoverCCSessions(): Promise<{
  sessions: DiscoveredSession[];
  skippedDirs: string[];
  unmappedDirs: string[];
}> {
  const agentName = process.env.AGENT_NAME ?? "default";
  const sessions: DiscoveredSession[] = [];
  const skippedDirs: string[] = [];
  const unmappedDirs: string[] = [];

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
