import "../core/env.js";
import { readFile } from "fs/promises";
import { watch } from "chokidar";
import { extname } from "path";
import { config } from "../core/config.js";
import { indexFile } from "../core/indexer/files.js";
import { indexAssetFile, deleteAsset } from "../core/indexer/assets.js";
import { deleteBySource } from "../core/qdrant/client.js";
import { ensureCollections, getCollectionPointCount } from "../core/qdrant/client.js";
import { relative } from "path";
import { startMediaFilerWatcher } from "../core/media-filer/index.js";
import { crossLinkFile } from "../core/cross-linker/index.js";
import { detectCollection } from "../core/indexer/collection-router.js";

const DEBOUNCE_MS = 2000;
const ASSET_DEBOUNCE_MS = 5000;

const ASSET_EXTENSIONS = new Set([
  ...config.assetIndexing.imageExtensions,
  ...config.assetIndexing.pdfExtensions,
  ...config.assetIndexing.audioExtensions,
]);

function isAssetFile(filePath: string): boolean {
  return ASSET_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// Per-file debounce timers
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`);
}

function relativePath(filePath: string): string {
  return relative(config.workspaceRoot, filePath);
}

// Collection routing moved to collection-router.ts so watcher + indexer
// share the same absolute-path logic.

function handleFileChange(filePath: string): void {
  // Clear existing timer for this file
  const existing = timers.get(filePath);
  if (existing) clearTimeout(existing);

  const asset = isAssetFile(filePath);
  const debounce = asset ? ASSET_DEBOUNCE_MS : DEBOUNCE_MS;

  // Set new debounced timer
  timers.set(
    filePath,
    setTimeout(async () => {
      timers.delete(filePath);

      if (asset) {
        try {
          await indexAssetFile(filePath);
          log(`Indexed asset: ${relativePath(filePath)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Error indexing asset ${relativePath(filePath)}: ${msg}`);
        }
        return;
      }

      const collection = detectCollection(filePath);
      if (!collection) {
        log(`Skipping (unknown collection): ${relativePath(filePath)}`);
        return;
      }
      try {
        await indexFile(filePath);
        log(`Indexed: ${relativePath(filePath)}`);

        // Auto-cross-link brain vault files after indexing
        if (collection === config.collections.brain) {
          try {
            const linked = await crossLinkFile(filePath);
            if (linked > 0) {
              log(`Cross-linked: ${relativePath(filePath)} (${linked} links)`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Cross-link error ${relativePath(filePath)}: ${msg}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error indexing ${relativePath(filePath)}: ${msg}`);
      }
    }, debounce)
  );
}

async function handleFileRemove(filePath: string): Promise<void> {
  // Cancel any pending index for this file
  const existing = timers.get(filePath);
  if (existing) {
    clearTimeout(existing);
    timers.delete(filePath);
  }

  const collection = detectCollection(filePath);
  if (!collection) return;

  const rel = relativePath(filePath);
  try {
    await deleteBySource(collection, rel);
    log(`Deleted vectors: ${rel}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error deleting ${rel}: ${msg}`);
  }
}

/**
 * Startup health check: compare local state files against Qdrant point
 * counts and log loud warnings if there's drift > 20%. Does NOT auto-fix
 * (the indexer's reconcileState runs before any actual re-indexing and
 * handles correction). This is a visibility layer so a background watcher
 * daemon surfaces problems instead of silently running on a broken Qdrant.
 *
 * Never throws — if Qdrant is unreachable or state files are missing,
 * logs a warning and returns. The watcher still starts.
 *
 * See: brain/decisions/2026-04-11-qdrant-tmpfs-rescue.md
 */
async function checkQdrantHealth(): Promise<void> {
  interface CheckSpec {
    label: string;
    collection: string;
    stateFile: string;
    extractExpected: (state: unknown) => number;
  }

  const checks: CheckSpec[] = [
    {
      label: "brain/obs/refl",
      collection: config.collections.brain,
      stateFile: config.indexStatePath,
      extractExpected: (state: unknown) => {
        const s = state as { files?: Record<string, { collection: string; chunks: number }> };
        if (!s?.files) return 0;
        return Object.values(s.files)
          .filter((f) => f.collection === config.collections.brain)
          .reduce((sum, f) => sum + f.chunks, 0);
      },
    },
    {
      label: "observations",
      collection: config.collections.observations,
      stateFile: config.indexStatePath,
      extractExpected: (state: unknown) => {
        const s = state as { files?: Record<string, { collection: string; chunks: number }> };
        if (!s?.files) return 0;
        return Object.values(s.files)
          .filter((f) => f.collection === config.collections.observations)
          .reduce((sum, f) => sum + f.chunks, 0);
      },
    },
    {
      label: "reflections",
      collection: config.collections.reflections,
      stateFile: config.indexStatePath,
      extractExpected: (state: unknown) => {
        const s = state as { files?: Record<string, { collection: string; chunks: number }> };
        if (!s?.files) return 0;
        return Object.values(s.files)
          .filter((f) => f.collection === config.collections.reflections)
          .reduce((sum, f) => sum + f.chunks, 0);
      },
    },
    {
      label: "messages",
      collection: config.collections.messages,
      stateFile: config.messageIndexing.stateFile,
      extractExpected: (state: unknown) => {
        const s = state as { sessions?: Record<string, { messagesIndexed: number }> };
        if (!s?.sessions) return 0;
        return Object.values(s.sessions).reduce((sum, session) => sum + session.messagesIndexed, 0);
      },
    },
    {
      label: "assets",
      collection: config.collections.assets,
      stateFile: config.assetIndexing.stateFile,
      extractExpected: (state: unknown) => {
        const s = state as { assets?: Record<string, { chunks: number }> };
        if (!s?.assets) return 0;
        return Object.values(s.assets).reduce((sum, a) => sum + a.chunks, 0);
      },
    },
  ];

  // Also verify the bind mount isn't a tmpfs (the 2026-04-11 failure mode)
  // This is a belt-and-braces check — if indexer state says 0 points, drift
  // detection won't fire, but a tmpfs mount is still catastrophic.
  // We can't run docker from inside this process, so we can only infer from
  // behaviour. Instead, check the points_count matches what we expect.

  log("Running Qdrant health check...");
  let anyDrift = false;

  for (const check of checks) {
    let expected = 0;
    try {
      const raw = await readFile(check.stateFile, "utf-8");
      expected = check.extractExpected(JSON.parse(raw));
    } catch {
      // State file missing or unparseable — skip this check
      continue;
    }

    if (expected === 0) continue; // nothing to verify

    let actual: number;
    try {
      actual = await getCollectionPointCount(check.collection);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`⚠️  health check: failed to query ${check.collection}: ${msg}`);
      continue;
    }

    const threshold = Math.floor(expected * 0.8);
    if (actual < threshold) {
      anyDrift = true;
      log(
        `🚨 DRIFT: ${check.label} (${check.collection}) — state expects ${expected} points, Qdrant has ${actual} (< 80% threshold of ${threshold})`,
      );
      log(
        `   This indicates silent data loss. The next incremental index run will auto-wipe state and reindex via drift detection, but you may want to force a full index now: npx tsx src/cli.ts index / index-messages / index-assets`,
      );
    } else {
      log(`  ✓ ${check.label} (${check.collection}): ${actual} points (state expects ${expected})`);
    }
  }

  if (anyDrift) {
    log(`⚠️  Health check found drift. See above.`);
  } else {
    log(`  ✓ Qdrant health check passed`);
  }
}

async function main(): Promise<void> {
  log("Ensuring Qdrant collections exist...");
  await ensureCollections();

  // Startup health check — surface any drift before we start watching
  await checkQdrantHealth();

  // All paths to watch
  const watchPaths = [
    ...config.sources.brain,
    ...config.sources.observations,
    ...config.sources.reflections,
    ...config.sources.assets,
    ...config.memoryMdPaths,
    ...config.personaWatchPaths,
  ];

  log("Starting file watcher...");
  log(
    `Discovered ${config.agents.length} agent(s): ${
      config.agents.map((a) => a.name).join(", ") || "(none)"
    }`,
  );
  log(`Watching ${watchPaths.length} paths:`);
  for (const p of watchPaths) log(`  - ${p}`);

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 },
    usePolling: true,
    interval: 3000,
  });

  watcher.on("add", (path) => {
    log(`File added: ${relativePath(path)}`);
    handleFileChange(path);
  });

  watcher.on("change", (path) => {
    log(`File changed: ${relativePath(path)}`);
    handleFileChange(path);
  });

  watcher.on("unlink", (path) => {
    log(`File removed: ${relativePath(path)}`);
    if (isAssetFile(path)) {
      deleteAsset(path).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error deleting asset ${relativePath(path)}: ${msg}`);
      });
    } else {
      handleFileRemove(path);
    }
  });

  watcher.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Watcher error: ${msg}`);
  });

  // Start media filer — watches ~/.openclaw/media/inbound/ and copies to brain/assets/
  startMediaFilerWatcher(log);

  log("Watcher running. Press Ctrl+C to stop.");

  // Graceful shutdown
  const shutdown = () => {
    log("Shutting down watcher...");
    watcher.close().then(() => {
      // Clear all pending timers
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      log("Watcher stopped.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
