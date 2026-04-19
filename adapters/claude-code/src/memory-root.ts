import { existsSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

/**
 * Resolve the memory directory for a given Claude Code project.
 *
 * Resolution order (first match wins):
 *   1. `<projectDir>/memory/`                    — project-local (directory-as-agent)
 *   2. `<projectDir>/.the-brain/memory_root`     — override file pointing elsewhere
 *   3. `BRAIN_MEMORY_DIR` env var                — user-global escape hatch
 *   4. `~/.the-brain/memory/`                    — user-global default
 *   5. `~/.openclaw/workspace/memory/`           — legacy fallback (main Io agent)
 *
 * The returned path is absolute but is NOT required to exist — callers
 * that need to write should `mkdirSync(..., { recursive: true })` first.
 */
export function resolveMemoryDir(projectDir: string): string {
  const project = resolve(projectDir);

  // 1. cwd/memory/
  const localMemory = join(project, "memory");
  if (isDirectory(localMemory)) return localMemory;

  // 2. cwd/.the-brain/memory_root (file containing a path)
  const override = readOverride(join(project, ".the-brain", "memory_root"));
  if (override) return override;

  // 3. env var
  const env = process.env.BRAIN_MEMORY_DIR?.trim();
  if (env) return expandTilde(env);

  // 4. ~/.the-brain/memory/
  const userGlobal = join(homedir(), ".the-brain", "memory");
  if (isDirectory(userGlobal)) return userGlobal;

  // 5. Legacy main-Io fallback
  return join(homedir(), ".openclaw", "workspace", "memory");
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
