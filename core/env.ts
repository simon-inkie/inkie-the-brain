import { readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// Best-effort load from ~/io-data/.env. Always attempt (fills gaps for any
// var not already in process.env). Hook handlers running under the OpenClaw
// gateway only get the env entries explicitly configured per-hook, so e.g.
// QDRANT_API_KEY might be present for one hook but missing for another —
// this fallback catches those gaps from the single source of truth.
try {
  const envPath = resolve(homedir(), "io-data", ".env");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#]\w*)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch {
  // .env not found — vars must already be in process.env
}
