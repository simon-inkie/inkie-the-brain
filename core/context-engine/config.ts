import type { TheBrainConfig } from "./types.js";

export const DEFAULT_CONFIG: TheBrainConfig = {
  recentTurnCount: 20,
  preserveFirstUserMessage: true,
  minRawFloor: 4,
  maxInjectedChars: 40000,
  memoryBlockSource: "memory-core",
  memoryRoot: "",
  memoryFile: "",
  debug: false,
};

/**
 * Merge raw plugin config (from openclaw.json) with defaults.
 * Validates types and clamps numeric fields to sane ranges.
 */
export function parseConfig(
  raw?: Record<string, unknown>,
  workspace?: string,
): TheBrainConfig {
  const r = raw ?? {};
  const ws = workspace ?? process.env.HOME ?? "";

  const recentTurnCount = Math.max(1, Number(r.recentTurnCount) || DEFAULT_CONFIG.recentTurnCount);
  const minRawFloor = Math.max(1, Number(r.minRawFloor) || DEFAULT_CONFIG.minRawFloor);
  const maxInjectedChars = Math.max(0, Number(r.maxInjectedChars) || DEFAULT_CONFIG.maxInjectedChars);

  const memoryBlockSource = (
    r.memoryBlockSource === "file" || r.memoryBlockSource === "none"
      ? r.memoryBlockSource
      : "memory-core"
  ) as TheBrainConfig["memoryBlockSource"];

  return {
    recentTurnCount,
    preserveFirstUserMessage: r.preserveFirstUserMessage !== false,
    minRawFloor,
    maxInjectedChars,
    memoryBlockSource,
    memoryRoot: String(r.memoryRoot || `${ws}/.openclaw/workspace/memory`),
    memoryFile: String(r.memoryFile || `${ws}/.openclaw/workspace/MEMORY.md`),
    debug: r.debug === true,
  };
}
