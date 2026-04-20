import { existsSync, readFileSync, statSync } from "fs";
import { resolve, join, basename } from "path";
import { homedir } from "os";
import { log } from "../../../core/log.js";

/**
 * Resolve the memory directory for a given Claude Code project.
 *
 * Resolution order (first match wins):
 *   1. `<projectDir>/memory/`                           — project-local (directory-as-agent)
 *   2. `<projectDir>/.the-brain/memory_root`            — override file pointing elsewhere
 *   3. `BRAIN_MEMORY_DIR` env var                       — user-global escape hatch
 *   4. `~/.the-brain/memory/`                           — user-global default (if present)
 *   5. `~/.the-brain/agents/<basename(projectDir)>/memory/` — auto-silo per project
 *
 * Tier 5 auto-silos by project-dir basename so every CC session gets its
 * own memory dir keyed off the repo name — never mixing with another
 * project or with the OpenClaw main-Io workspace. Previously this tier
 * fell back to `~/.openclaw/workspace/memory/`, which caused CC sessions
 * (e.g. inkie-app-v2-feature3) to pollute Io agent memory.
 *
 * The returned path is absolute but is NOT required to exist — callers
 * that need to write should `mkdirSync(..., { recursive: true })` first.
 */
export function resolveMemoryDir(projectDir: string): string {
  const project = resolve(projectDir);
  const result = resolveMemoryDirInner(project);
  log("debug", "memory-root", "resolved", {
    cwd: project,
    memoryDir: result.memoryDir,
    data: { tier: result.tier },
  });
  if (result.tier === 5) {
    // Auto-silo means no explicit pointer — flag as warn so it's grep-able
    // when an agent's expected silo isn't being hit.
    log("warn", "memory-root", "auto-silo-fallback", {
      cwd: project,
      memoryDir: result.memoryDir,
      data: { tier: 5, basename: basename(project) },
    });
  }
  return result.memoryDir;
}

function resolveMemoryDirInner(project: string): { memoryDir: string; tier: number } {
  // 1. cwd/memory/
  const localMemory = join(project, "memory");
  if (isDirectory(localMemory)) return { memoryDir: localMemory, tier: 1 };

  // 2. cwd/.the-brain/memory_root (file containing a path)
  const override = readOverride(join(project, ".the-brain", "memory_root"));
  if (override) return { memoryDir: override, tier: 2 };

  // 3. env var
  const env = process.env.BRAIN_MEMORY_DIR?.trim();
  if (env) return { memoryDir: expandTilde(env), tier: 3 };

  // 4. ~/.the-brain/memory/
  const userGlobal = join(homedir(), ".the-brain", "memory");
  if (isDirectory(userGlobal)) return { memoryDir: userGlobal, tier: 4 };

  // 5. Auto-silo per project under ~/.the-brain/agents/<basename>/memory/
  return {
    memoryDir: join(homedir(), ".the-brain", "agents", basename(project), "memory"),
    tier: 5,
  };
}

/**
 * The MEMORY.md live block lives one level above the memory dir:
 *   <memoryDir>/../MEMORY.md
 * e.g. ~/.openclaw/workspace/memory/ → ~/.openclaw/workspace/MEMORY.md
 */
export function memoryFilePath(memoryDir: string): string {
  return join(memoryDir, "..", "MEMORY.md");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readOverride(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    return expandTilde(raw);
  } catch {
    return null;
  }
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}
