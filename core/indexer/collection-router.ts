/**
 * Map a file path to the Qdrant collection it belongs to.
 *
 * Matches on **absolute-path substrings**, not workspace-relative prefixes —
 * files under per-agent silos at `~/.the-brain/agents/<name>/memory/` don't
 * share a common workspace-relative prefix with the legacy OpenClaw paths, and
 * the old prefix logic silently dropped them (returning null → watcher logged
 * "Skipping (unknown collection)").
 *
 * Returns null for files that don't match any known collection — caller decides
 * whether that's a skip or a default-to-brain fallback.
 */
import { config } from "../config.js";

export function detectCollection(filePath: string): string | null {
  if (filePath.includes("/memory/observations/")) {
    return config.collections.observations;
  }
  if (filePath.includes("/memory/reflections/")) {
    return config.collections.reflections;
  }
  if (filePath.endsWith("/MEMORY.md")) {
    return config.collections.reflections;
  }
  // Hand-written references (agents/<name>/references/*.md) - curated durable
  // captures, routed to the reflections collection. Require BOTH /agents/ AND
  // /references/ so a brain-vault path that happens to contain a "references"
  // segment (e.g. ~/brain/projects/.../references/) is NOT mis-routed to a
  // per-agent reflections collection - it falls through to the brain check below.
  if (filePath.includes("/agents/") && filePath.includes("/references/")) {
    return config.collections.reflections;
  }
  if (filePath.includes("/brain/") && !filePath.includes("/memory/")) {
    return config.collections.brain;
  }
  return null;
}

/**
 * Extract the agent name from a file path. Used to tag Qdrant points with
 * `agentName` so scope-filtered queries (`remembering(q, { agents: [...] })`)
 * can narrow recall to specific silos without falling back to fragile source-
 * string substring matching.
 *
 * Works on absolute paths (runtime, indexer) AND workspace-relative source
 * strings (backfill pass reading `payload.source` from Qdrant) — the
 * `agents/<name>/` substring is stable across both forms.
 *
 * Returns null for paths with no agent context (brain vault, legacy OpenClaw,
 * pre-silo-era orphan sources with no `agents/` segment). Null means "unscoped"
 * — scope-filtered queries must NOT match these.
 */
const AGENT_PATH_RE = /(?:^|\/)agents\/([a-z0-9][a-z0-9-]*)(?:\/|$)/;

export function agentNameFromPath(path: string): string | null {
  const m = path.match(AGENT_PATH_RE);
  return m ? m[1] : null;
}
