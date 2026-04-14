import { readFile, writeFile, access, readdir, stat } from "fs/promises";
import { join, relative, basename } from "path";
import { createHash } from "crypto";
import { glob } from "glob";
import matter from "gray-matter";
import { config } from "../config.js";
import { embedTexts } from "../embedder/text.js";
import {
  ensureCollections,
  upsertPoints,
  deleteBySource,
  getCollectionPointCount,
} from "../qdrant/client.js";
import type { PointData } from "../qdrant/client.js";

interface IndexState {
  files: Record<
    string,
    {
      hash: string;
      indexedAt: string;
      collection: string;
      chunks: number;
    }
  >;
  lastFullIndex: string | null;
}

export interface ReconcileOptions {
  /**
   * Function that returns the current point count for a collection.
   * Defaults to the real Qdrant getCollectionPointCount — overridable in tests.
   */
  getCount?: (collection: string) => Promise<number>;
  /**
   * Logger function — overridable in tests to capture messages.
   */
  log?: (msg: string) => void;
  /**
   * Minimum ratio of actual/expected points required to trust the state.
   * Defaults to 0.8 (= 20% tolerance).
   */
  tolerance?: number;
  /**
   * Collections this indexer owns. Defaults to brain/observations/reflections.
   */
  ownedCollections?: string[];
}

/**
 * Drift detection: compare the state file's expected point counts against
 * the actual counts in Qdrant. If Qdrant is significantly below what the
 * state file believes, the state file is out of sync with reality (e.g.
 * Qdrant collection was wiped, container was restarted with a broken
 * mount, etc.). Wipe the state to force a full reindex.
 *
 * This is a second-line defense against silent data loss — the primary
 * failure mode being Docker Desktop's tmpfs-fallback behavior when a bind
 * mount source is inaccessible at container start time. See
 * brain/decisions/2026-04-11-qdrant-tmpfs-rescue.md for the incident.
 *
 * Returns the state, possibly wiped. Pure function modulo the injectable
 * getCount — safe to unit-test.
 */
export async function reconcileState(
  state: IndexState,
  options: ReconcileOptions = {},
): Promise<IndexState> {
  const getCount = options.getCount ?? getCollectionPointCount;
  const log = options.log ?? ((msg) => console.error(msg));
  const tolerance = options.tolerance ?? 0.8;
  const ownedCollections = options.ownedCollections ?? [
    config.collections.brain,
    config.collections.observations,
    config.collections.reflections,
  ];

  // Compute expected counts per collection from the state file
  const expected: Record<string, number> = {};
  for (const info of Object.values(state.files)) {
    expected[info.collection] = (expected[info.collection] ?? 0) + info.chunks;
  }

  for (const collection of ownedCollections) {
    const expectedCount = expected[collection] ?? 0;
    if (expectedCount === 0) continue; // nothing to verify

    let actualCount: number;
    try {
      actualCount = await getCount(collection);
    } catch (err) {
      log(
        `[indexer] reconcile: failed to query ${collection}: ${err}. Assuming state is trustworthy.`,
      );
      continue;
    }

    const threshold = Math.floor(expectedCount * tolerance);
    if (actualCount < threshold) {
      log(
        `[indexer] DRIFT DETECTED in ${collection}: state expects ${expectedCount} points, ` +
          `Qdrant has ${actualCount} (< ${Math.round(tolerance * 100)}% threshold of ${threshold}). ` +
          `Wiping state to force full reindex.`,
      );
      return { files: {}, lastFullIndex: null };
    }
  }

  return state;
}

async function loadState(): Promise<IndexState> {
  try {
    const data = await readFile(config.indexStatePath, "utf-8");
    return JSON.parse(data);
  } catch {
    return { files: {}, lastFullIndex: null };
  }
}

async function saveState(state: IndexState): Promise<void> {
  await writeFile(config.indexStatePath, JSON.stringify(state, null, 2));
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function relativePath(filePath: string): string {
  return relative(config.workspaceRoot, filePath);
}

function extractTitle(content: string, filename: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  return basename(filename, ".md");
}

function extractDate(content: string, filename: string): string | null {
  const dateMatch = basename(filename).match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];
  // Check frontmatter date is handled by caller
  return null;
}

interface Chunk {
  content: string;
  title: string;
}

function chunkContent(content: string, title: string): Chunk[] {
  // Rough token estimate: ~4 chars per token
  const maxChars = config.chunkMaxTokens * 4;

  if (content.length <= maxChars) {
    return [{ content, title }];
  }

  // Split on ## headings
  const sections = content.split(/(?=^## )/m);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxChars) {
      const sectionTitle = trimmed.match(/^##\s+(.+)$/m);
      chunks.push({
        content: trimmed,
        title: sectionTitle ? `${title} > ${sectionTitle[1]}` : title,
      });
    } else {
      // Section itself is too long — split by paragraphs
      const paragraphs = trimmed.split(/\n\n+/);
      let current = "";
      for (const para of paragraphs) {
        if (current.length + para.length > maxChars && current.length > 0) {
          chunks.push({ content: current.trim(), title });
          current = "";
        }
        current += para + "\n\n";
      }
      if (current.trim()) {
        chunks.push({ content: current.trim(), title });
      }
    }
  }

  return chunks.length > 0 ? chunks : [{ content, title }];
}

async function indexFileInternal(
  filePath: string,
  collection: string,
  state: IndexState
): Promise<{ chunks: number; skipped: boolean }> {
  const content = await readFile(filePath, "utf-8");
  const relPath = relativePath(filePath);
  const hash = contentHash(content);

  // Check if unchanged
  if (state.files[relPath]?.hash === hash) {
    return { chunks: state.files[relPath].chunks, skipped: true };
  }

  // Parse frontmatter
  const { data: frontmatter, content: body } = matter(content);
  const title = (frontmatter.title as string) || extractTitle(body, filePath);
  const date =
    (frontmatter.date as string) || extractDate(body, basename(filePath));
  const tags: string[] = Array.isArray(frontmatter.tags)
    ? frontmatter.tags
    : [];

  // Chunk
  const chunks = chunkContent(body, title);

  // Embed all chunks in one batch
  const texts = chunks.map((c) => c.content);
  const vectors = await embedTexts(texts, "RETRIEVAL_DOCUMENT");

  // Extract origin metadata if present
  const origin = frontmatter.origin ?? null;

  // Build points
  const points: { vector: number[]; payload: PointData }[] = chunks.map(
    (chunk, i) => ({
      vector: vectors[i],
      payload: {
        source: relPath,
        collection,
        title: chunk.title,
        chunk: i,
        totalChunks: chunks.length,
        content: chunk.content,
        indexedAt: new Date().toISOString(),
        tags,
        date,
        ...(origin ? { origin } : {}),
      },
    })
  );

  // Upsert
  await upsertPoints(collection, points);

  // Update state
  state.files[relPath] = {
    hash,
    indexedAt: new Date().toISOString(),
    collection,
    chunks: chunks.length,
  };

  return { chunks: chunks.length, skipped: false };
}

async function indexDirectory(
  dirPath: string,
  collection: string,
  state: IndexState
): Promise<{ indexed: number; skipped: number; chunks: number }> {
  let files: string[];
  try {
    files = await glob(join(dirPath, "**/*.md"));
  } catch {
    console.error(`Directory not found: ${dirPath}`);
    return { indexed: 0, skipped: 0, chunks: 0 };
  }

  let indexed = 0;
  let skipped = 0;
  let totalChunks = 0;

  for (const file of files) {
    const result = await indexFileInternal(file, collection, state);
    totalChunks += result.chunks;
    if (result.skipped) {
      skipped++;
    } else {
      indexed++;
    }
  }

  return { indexed, skipped, chunks: totalChunks };
}

async function indexMemoryMd(
  state: IndexState
): Promise<{ chunks: number; skipped: boolean }> {
  const collection = config.collections.reflections;

  try {
    await access(config.memoryMdPath);
  } catch {
    return { chunks: 0, skipped: true };
  }

  return indexFileInternal(config.memoryMdPath, collection, state);
}

async function cleanRemovedFiles(state: IndexState): Promise<number> {
  let removed = 0;
  const toRemove: string[] = [];

  for (const [relPath, info] of Object.entries(state.files)) {
    const fullPath = join(config.workspaceRoot, relPath);
    try {
      await access(fullPath);
    } catch {
      // File no longer exists
      await deleteBySource(info.collection, relPath);
      toRemove.push(relPath);
      removed++;
    }
  }

  for (const p of toRemove) {
    delete state.files[p];
  }

  return removed;
}

export async function indexAll(): Promise<void> {
  console.error("Ensuring collections exist...");
  await ensureCollections();

  let state = await loadState();
  // Drift check: verify state file matches Qdrant reality before trusting it
  state = await reconcileState(state);

  let totalIndexed = 0;
  let totalSkipped = 0;
  let totalChunks = 0;

  // Index brain directories
  for (const dir of config.sources.brain) {
    console.error(`Indexing brain: ${dir}`);
    const r = await indexDirectory(dir, config.collections.brain, state);
    totalIndexed += r.indexed;
    totalSkipped += r.skipped;
    totalChunks += r.chunks;
  }

  // Index observations
  for (const dir of config.sources.observations) {
    console.error(`Indexing observations: ${dir}`);
    const r = await indexDirectory(dir, config.collections.observations, state);
    totalIndexed += r.indexed;
    totalSkipped += r.skipped;
    totalChunks += r.chunks;
  }

  // Index reflections
  for (const dir of config.sources.reflections) {
    console.error(`Indexing reflections: ${dir}`);
    const r = await indexDirectory(dir, config.collections.reflections, state);
    totalIndexed += r.indexed;
    totalSkipped += r.skipped;
    totalChunks += r.chunks;
  }

  // Index MEMORY.md
  console.error(`Indexing MEMORY.md`);
  const memResult = await indexMemoryMd(state);
  if (memResult.skipped) {
    totalSkipped++;
  } else {
    totalIndexed++;
    totalChunks += memResult.chunks;
  }

  // Clean removed files
  console.error("Cleaning removed files...");
  const removed = await cleanRemovedFiles(state);

  // Save state
  state.lastFullIndex = new Date().toISOString();
  await saveState(state);

  console.error(
    `\nDone: ${totalIndexed} files indexed (${totalChunks} chunks), ${totalSkipped} unchanged, ${removed} removed`
  );
}

export async function indexFile(filePath: string): Promise<void> {
  await ensureCollections();
  const state = await loadState();

  // Determine collection from path
  const relPath = relativePath(filePath);
  let collection: string;
  if (relPath.startsWith("brain/")) {
    collection = config.collections.brain;
  } else if (relPath.startsWith("memory/observations")) {
    collection = config.collections.observations;
  } else if (relPath.startsWith("memory/reflections") || relPath === "MEMORY.md") {
    collection = config.collections.reflections;
  } else {
    // Default to brain
    collection = config.collections.brain;
  }

  const result = await indexFileInternal(filePath, collection, state);
  await saveState(state);

  if (result.skipped) {
    console.error(`Skipped (unchanged): ${relPath}`);
  } else {
    console.error(`Indexed: ${relPath} (${result.chunks} chunks)`);
  }
}
