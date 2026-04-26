import { homedir } from "os";
import { join } from "path";
import { readdir, stat, readFile } from "fs/promises";

const CC_PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface AgentRule {
  pattern: string;
  agent: string;
  birthDate?: string;
}

// Ordered longest-first so more specific patterns match before shorter ones.
const AGENT_RULES: AgentRule[] = [
  // Agent-home dirs — new launch points (~/agents/<name>/)
  { pattern: "-agents-io", agent: "io" },
  { pattern: "-agents-aldus", agent: "aldus" },
  { pattern: "-agents-andor", agent: "andor" },
  { pattern: "-agents-doctor2", agent: "doctor2" },
  { pattern: "-agents-hopkins", agent: "hopkins" },

  // Agent-home dirs — legacy launch points (~/.the-brain/agents/<name>/)
  { pattern: "-the-brain-agents-inkie-app-v2-feature3", agent: "aldus" },
  { pattern: "-the-brain-agents-inkie-bugfix-2", agent: "aldus" },
  { pattern: "-the-brain-agents-inkie-analytics", agent: "hopkins" },
  { pattern: "-the-brain-agents-inkie-worker", agent: "andor" },
  { pattern: "-the-brain-agents-inkie-gtm", agent: "hopkins" },
  { pattern: "-the-brain-agents-inkie-io", agent: "io" },
  { pattern: "-the-brain-agents-greymatter-dev", agent: "doctor2" },
  { pattern: "-the-brain-agents-brain-surgeon", agent: "doctor2" },
  { pattern: "-the-brain-agents-the-brain-dev", agent: "doctor2" },
  { pattern: "-the-brain-agents-doctor-two", agent: "doctor2" },
  { pattern: "-the-brain-agents-doctor2", agent: "doctor2" },
  { pattern: "-the-brain-agents-io", agent: "io" },
  { pattern: "-the-brain-agents-aldus", agent: "aldus" },
  { pattern: "-the-brain-agents-andor", agent: "andor" },
  { pattern: "-the-brain-agents-hopkins", agent: "hopkins" },

  // OpenClaw workspace — all sessions are Io
  { pattern: "-openclaw-workspace", agent: "io" },

  // Legacy Io launch points
  { pattern: "-inkie-io", agent: "io" },

  // Repo dirs — need birth-date cutoffs (verified via settings.json)
  { pattern: "-git-repos-inkie-app-v2", agent: "aldus", birthDate: "2026-04-22" },
  { pattern: "-git-repos-inkie-worker", agent: "andor", birthDate: "2026-04-21" },
  { pattern: "-git-repos-inkie-gtm", agent: "hopkins", birthDate: "2026-04-24" },
  { pattern: "-io-projects-the-brain", agent: "doctor2", birthDate: "2026-04-19" },
];

const SKIP_PATTERNS: RegExp[] = [
  /-the-brain-agents-harness-/,
  /-tmp-/,
  /filechanged-lab$/,
  /-home-simon-agents$/,
  /-home-simon-git-repos$/,
  /-home-simon$/,
  /inkie-app-v2-feature2$/,
  /inkie-app-v2-feature3$/,
  /inkie-bugfix$/,
  /inkie-bugfix-2$/,
  /inkie-analytics$/,
  /inkie-image-gen$/,
  /inkie-creator-backend$/,
  /io-auto-mode$/,
  /io-memory-engine$/,
  /inkie-ink-304/,
];

function shouldSkipDir(dirName: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(dirName));
}

function resolveAgent(dirName: string): AgentRule | null {
  for (const rule of AGENT_RULES) {
    if (dirName.endsWith(rule.pattern)) return rule;
  }
  return null;
}

async function getFirstUserTimestamp(filePath: string): Promise<string | null> {
  const raw = await readFile(filePath, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "user" && parsed.timestamp) {
        return parsed.timestamp;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export interface DiscoveredSession {
  projectDir: string;
  agentName: string;
  filePath: string;
  sessionId: string;
}

export async function discoverCCSessions(): Promise<{
  sessions: DiscoveredSession[];
  skippedDirs: string[];
  unmappedDirs: string[];
}> {
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
    if (shouldSkipDir(dirName)) {
      skippedDirs.push(dirName);
      continue;
    }

    const rule = resolveAgent(dirName);
    if (!rule) {
      unmappedDirs.push(dirName);
      continue;
    }

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

      if (rule.birthDate) {
        const birthMs = new Date(rule.birthDate).getTime();
        const ts = await getFirstUserTimestamp(filePath);
        if (ts && new Date(ts).getTime() < birthMs) {
          continue;
        }
      }

      sessions.push({
        projectDir: dirName,
        agentName: rule.agent,
        filePath,
        sessionId,
      });
    }
  }

  return { sessions, skippedDirs, unmappedDirs };
}
