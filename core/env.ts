import { readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// Best-effort env-file load. Always attempt (fills gaps for any var not
// already in process.env). Hook handlers running under a gateway only get the
// env entries explicitly configured per-hook, so e.g. QDRANT_API_KEY might be
// present for one hook but missing for another — this fallback catches those
// gaps from the single source of truth.
//
// Candidates, in precedence order. Anything already in process.env always
// wins, and among the files the FIRST to define a var wins:
//   1. BRAIN_ENV_FILE   — explicit override, for an unusual layout
//   2. ~/.the-brain/.env — the documented location (see QUICKSTART)
//   3. ~/io-data/.env    — legacy location, kept so an existing install that
//                          predates the ~/.the-brain/ layout keeps working
//                          without a migration. Same treatment as the indexer
//                          state dir in core/config.ts.
for (const envPath of [
  process.env.BRAIN_ENV_FILE,
  resolve(homedir(), ".the-brain", ".env"),
  resolve(homedir(), "io-data", ".env"),
]) {
  if (!envPath) continue;
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#]\w*)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    // Not present — try the next candidate.
  }
}
