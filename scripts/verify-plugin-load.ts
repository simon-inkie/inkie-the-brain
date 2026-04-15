/**
 * Dry-run verification: import plugin entry + hook handlers, confirm shapes.
 * Does not register with OpenClaw — purely checks imports resolve + exports are valid.
 *
 * Run: tsx scripts/verify-plugin-load.ts
 */

import pluginEntry from "../adapters/openclaw/plugin/src/index.js";
import observerHandler, {
  evaluateShouldObserve,
  readTranscriptFromOffset,
  MIN_OBSERVATION_GAP_MS,
} from "../adapters/openclaw/hooks/hooks/io-observer/handler.js";
import messageIndexerHandler from "../adapters/openclaw/hooks/hooks/io-message-indexer/handler.js";
import mediaFilerHandler from "../adapters/openclaw/hooks/hooks/io-media-filer/handler.js";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

record(
  "plugin entry shape",
  pluginEntry.id === "greymatter" && typeof pluginEntry.register === "function",
  `id=${pluginEntry.id}, name=${pluginEntry.name}, register=${typeof pluginEntry.register}`,
);

record(
  "io-observer handler shape",
  typeof observerHandler === "function" &&
    typeof evaluateShouldObserve === "function" &&
    typeof readTranscriptFromOffset === "function" &&
    MIN_OBSERVATION_GAP_MS > 0,
  `default=${typeof observerHandler}, evaluate=${typeof evaluateShouldObserve}, MIN_GAP=${MIN_OBSERVATION_GAP_MS}ms`,
);

record(
  "io-message-indexer handler shape",
  typeof messageIndexerHandler === "function",
  `default=${typeof messageIndexerHandler}`,
);

record(
  "io-media-filer handler shape",
  typeof mediaFilerHandler === "function",
  `default=${typeof mediaFilerHandler}`,
);

const passed = checks.filter(c => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
