import { readFile, stat } from "fs/promises";
import { join, relative, basename, extname, dirname } from "path";
import { createHash } from "crypto";
import { glob } from "glob";
import { imageSize } from "image-size";
import { config } from "../config.js";
import { embedText } from "../embedder/text.js";
import { agentNameFromPath } from "./collection-router.js";
import { writeFileAtomic } from "./atomic-state.js";
import {
  ensureCollections,
  upsertPoints,
  deleteBySource,
  client,
  getCollectionPointCount,
} from "../qdrant/client.js";
import type { PointData } from "../qdrant/client.js";
import {
  embedImage,
  embedImageWithContext,
  describeImage,
  extractPdfPages,
  embedPdf,
  splitPdfIntoChunks,
  transcribeAudio,
  getMimeType,
} from "../embedder/assets.js";

// --- Types ---

type AssetType = "image" | "pdf" | "audio";

interface AssetStateEntry {
  hash: string;
  indexedAt: string;
  assetType: AssetType;
  chunks: number;
  description?: string;
}

interface AssetIndexState {
  assets: Record<string, AssetStateEntry>;
  lastRun: string | null;
  totalAssetsIndexed: number;
}

// --- State management ---

async function loadState(): Promise<AssetIndexState> {
  try {
    const data = await readFile(config.assetIndexing.stateFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return { assets: {}, lastRun: null, totalAssetsIndexed: 0 };
  }
}

/**
 * Persist asset-index state crash-safely: write-then-rename, never a plain
 * overwrite. This state file is the most exposed of the three — the watcher can
 * have `indexAssetFile` (per-file debounce timer) and `deleteAsset` (a floating
 * promise off the `unlink` event) writing it concurrently.
 *
 * writeFileAtomic creates the state directory recursively as part of the write,
 * so a fresh install whose state directory does not exist yet still works.
 */
async function saveState(state: AssetIndexState): Promise<void> {
  await writeFileAtomic(
    config.assetIndexing.stateFile,
    JSON.stringify(state, null, 2)
  );
}

export interface AssetReconcileOptions {
  getCount?: (collection: string) => Promise<number>;
  log?: (msg: string) => void;
  tolerance?: number;
}

/**
 * Drift detection for asset state. Same failure mode, and the same reasoning,
 * as reconcileState in files.ts.
 * Pure function modulo injectable getCount — testable.
 */
export async function reconcileAssetState(
  state: AssetIndexState,
  options: AssetReconcileOptions = {}
): Promise<AssetIndexState> {
  const getCount = options.getCount ?? getCollectionPointCount;
  const log = options.log ?? ((msg: string) => console.error(msg));
  const tolerance = options.tolerance ?? 0.8;

  const expectedCount = Object.values(state.assets).reduce(
    (sum, a) => sum + a.chunks,
    0
  );
  if (expectedCount === 0) return state;

  let actualCount: number;
  try {
    actualCount = await getCount(config.collections.assets);
  } catch (err) {
    log(
      `[asset-indexer] reconcile: failed to query ${config.collections.assets}: ${err}. Assuming state is trustworthy.`
    );
    return state;
  }

  const threshold = Math.floor(expectedCount * tolerance);
  if (actualCount < threshold) {
    log(
      `[asset-indexer] DRIFT DETECTED: state expects ${expectedCount} points, ` +
        `Qdrant has ${actualCount} (< ${Math.round(tolerance * 100)}% threshold of ${threshold}). ` +
        `Wiping state to force full reindex.`
    );
    return { assets: {}, lastRun: null, totalAssetsIndexed: 0 };
  }
  return state;
}

function fileHash(buffer: Buffer): string {
  return "sha256:" + createHash("sha256").update(buffer).digest("hex");
}

function relativePath(filePath: string): string {
  return relative(config.workspaceRoot, filePath);
}

function titleFromFilename(filePath: string): string {
  const name = basename(filePath, extname(filePath));
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractDateFromFilename(filePath: string): string | null {
  const match = basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function tagsFromPath(filePath: string): string[] {
  const dir = dirname(relativePath(filePath));
  const parts = dir.split("/").filter((p) => p && p !== "." && p !== "brain" && p !== "assets");
  return parts;
}

function detectAssetType(filePath: string): AssetType | null {
  const ext = extname(filePath).toLowerCase();
  if (config.assetIndexing.imageExtensions.includes(ext)) return "image";
  if (config.assetIndexing.pdfExtensions.includes(ext)) return "pdf";
  if (config.assetIndexing.audioExtensions.includes(ext)) return "audio";
  return null;
}

function getAllSupportedExtensions(): string[] {
  return [
    ...config.assetIndexing.imageExtensions,
    ...config.assetIndexing.pdfExtensions,
    ...config.assetIndexing.audioExtensions,
  ];
}

// --- Image indexing ---

async function indexImage(
  filePath: string,
  state: AssetIndexState
): Promise<{ chunks: number; skipped: boolean }> {
  const buffer = await readFile(filePath);
  const hash = fileHash(buffer);
  const relPath = relativePath(filePath);

  if (state.assets[relPath]?.hash === hash) {
    return { chunks: state.assets[relPath].chunks, skipped: true };
  }

  const title = titleFromFilename(filePath);
  console.error(`  Describing image: ${relPath}`);
  const description = await describeImage(filePath);

  console.error(`  Embedding image: ${relPath}`);
  const vector = await embedImageWithContext(filePath, `${title}. ${description}`);

  // Get dimensions
  let dimensions: { width: number; height: number } | null = null;
  try {
    const size = imageSize(buffer);
    if (size.width && size.height) {
      dimensions = { width: size.width, height: size.height };
    }
  } catch {
    // dimensions not available
  }

  const payload: PointData = {
    source: relPath,
    collection: config.collections.assets,
    title,
    chunk: 0,
    totalChunks: 1,
    content: description,
    indexedAt: new Date().toISOString(),
    tags: tagsFromPath(filePath),
    date: extractDateFromFilename(filePath),
    agentName: agentNameFromPath(filePath),
    assetType: "image",
    mimeType: getMimeType(filePath),
    description,
    fileSize: buffer.length,
    dimensions,
  };

  await upsertPoints(config.collections.assets, [{ vector, payload }]);

  state.assets[relPath] = {
    hash,
    indexedAt: new Date().toISOString(),
    assetType: "image",
    chunks: 1,
    description: description.slice(0, 200),
  };

  return { chunks: 1, skipped: false };
}

// --- PDF indexing ---
// Strategy: Native Gemini multimodal embedding first (captures images, charts, layout).
// PDFs ≤ 6 pages: single native embedding.
// PDFs > 6 pages: chunk into 6-page batches for native embedding + text extraction for granular recall.
// Gemini Embedding 2 supports max 6 pages per native PDF embed request.

const GEMINI_PDF_MAX_PAGES = 6;

async function indexPdf(
  filePath: string,
  state: AssetIndexState
): Promise<{ chunks: number; skipped: boolean }> {
  const buffer = await readFile(filePath);
  const hash = fileHash(buffer);
  const relPath = relativePath(filePath);

  if (state.assets[relPath]?.hash === hash) {
    return { chunks: state.assets[relPath].chunks, skipped: true };
  }

  const title = titleFromFilename(filePath);

  // Count pages first
  let totalPages = 1;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    totalPages = doc.numPages;
    doc.destroy();
  } catch {
    // Can't count pages — treat as single-page
  }

  console.error(`  PDF: ${relPath} (${totalPages} pages)`);

  const points: { vector: number[]; payload: PointData }[] = [];

  if (totalPages <= GEMINI_PDF_MAX_PAGES) {
    // Small PDF: single native multimodal embedding (sees images, charts, layout)
    console.error(`  Native multimodal embedding (≤${GEMINI_PDF_MAX_PAGES} pages): ${relPath}`);
    try {
      const vector = await embedPdf(filePath);
      points.push({
        vector,
        payload: {
          source: relPath,
          collection: config.collections.assets,
          title,
          chunk: 0,
          totalChunks: 1,
          content: `[PDF: ${title}, ${totalPages} pages — native multimodal embedding]`,
          indexedAt: new Date().toISOString(),
          tags: tagsFromPath(filePath),
          date: extractDateFromFilename(filePath),
          agentName: agentNameFromPath(filePath),
          assetType: "pdf",
          mimeType: "application/pdf",
          description: `PDF document: ${title} (${totalPages} pages, multimodal)`,
          fileSize: buffer.length,
          dimensions: null,
          pageNumber: null,
          totalPages,
        },
      });
    } catch (err) {
      console.error(`  Native PDF embedding failed, falling back to text: ${(err as Error).message}`);
      // Fall through to text extraction below
    }
  }

  if (totalPages > GEMINI_PDF_MAX_PAGES || points.length === 0) {
    // Large PDF or native embedding failed: text extraction for granular search
    console.error(`  Text extraction + chunked native embedding: ${relPath}`);

    // Extract text per-page for keyword recall
    let pages: { pageNumber: number; text: string }[] = [];
    try {
      pages = await extractPdfPages(filePath);
    } catch {
      console.error(`  Text extraction failed: ${relPath}`);
    }

    // Text vectors for granular search
    for (const page of pages) {
      if (page.text.length < 10) continue;
      console.error(`  Embedding text page ${page.pageNumber}/${totalPages}: ${relPath}`);
      const vector = await embedText(page.text, "RETRIEVAL_DOCUMENT");
      points.push({
        vector,
        payload: {
          source: relPath,
          collection: config.collections.assets,
          title: `${title} (p${page.pageNumber})`,
          chunk: page.pageNumber - 1,
          totalChunks: totalPages,
          content: page.text.slice(0, 5000),
          indexedAt: new Date().toISOString(),
          tags: tagsFromPath(filePath),
          date: extractDateFromFilename(filePath),
          agentName: agentNameFromPath(filePath),
          assetType: "pdf",
          mimeType: "application/pdf",
          description: `PDF page ${page.pageNumber} of ${totalPages} (text)`,
          textContent: page.text.slice(0, 5000),
          fileSize: buffer.length,
          dimensions: null,
          pageNumber: page.pageNumber,
          totalPages,
        },
      });
    }

    // Chunked native multimodal embedding for large PDFs (6-page segments)
    console.error(`  Chunked native multimodal embedding (${Math.ceil(totalPages / GEMINI_PDF_MAX_PAGES)} chunks): ${relPath}`);
    try {
      const chunks = await splitPdfIntoChunks(buffer, GEMINI_PDF_MAX_PAGES);
      for (const chunk of chunks) {
        console.error(`  Native embedding pages ${chunk.startPage}-${chunk.endPage}: ${relPath}`);
        const vector = await embedPdf(chunk.buffer);
        points.push({
          vector,
          payload: {
            source: relPath,
            collection: config.collections.assets,
            title: `${title} (p${chunk.startPage}-${chunk.endPage})`,
            chunk: chunk.startPage - 1,
            totalChunks: totalPages,
            content: `[PDF: ${title}, pages ${chunk.startPage}-${chunk.endPage} — native multimodal embedding]`,
            indexedAt: new Date().toISOString(),
            tags: tagsFromPath(filePath),
            date: extractDateFromFilename(filePath),
            agentName: agentNameFromPath(filePath),
            assetType: "pdf",
            mimeType: "application/pdf",
            description: `PDF pages ${chunk.startPage}-${chunk.endPage} of ${totalPages} (multimodal)`,
            fileSize: buffer.length,
            dimensions: null,
            pageNumber: chunk.startPage,
            totalPages,
          },
        });
      }
    } catch (err) {
      console.error(`  Chunked native embedding failed: ${(err as Error).message}`);
    }
  }

  if (points.length > 0) {
    await upsertPoints(config.collections.assets, points);
  }

  state.assets[relPath] = {
    hash,
    indexedAt: new Date().toISOString(),
    assetType: "pdf",
    chunks: points.length,
    description: `${totalPages} pages`,
  };

  return { chunks: points.length, skipped: false };
}

// --- Audio indexing ---

async function indexAudio(
  filePath: string,
  state: AssetIndexState
): Promise<{ chunks: number; skipped: boolean }> {
  const buffer = await readFile(filePath);
  const hash = fileHash(buffer);
  const relPath = relativePath(filePath);

  if (state.assets[relPath]?.hash === hash) {
    return { chunks: state.assets[relPath].chunks, skipped: true };
  }

  const title = titleFromFilename(filePath);
  console.error(`  Transcribing audio: ${relPath}`);
  const transcript = await transcribeAudio(filePath);

  console.error(`  Embedding transcript: ${relPath}`);
  const vector = await embedText(transcript, "RETRIEVAL_DOCUMENT");

  const payload: PointData = {
    source: relPath,
    collection: config.collections.assets,
    title,
    chunk: 0,
    totalChunks: 1,
    content: transcript,
    indexedAt: new Date().toISOString(),
    tags: tagsFromPath(filePath),
    date: extractDateFromFilename(filePath),
    agentName: agentNameFromPath(filePath),
    assetType: "audio",
    mimeType: getMimeType(filePath),
    description: `Audio transcription: ${transcript.slice(0, 200)}`,
    transcript,
    fileSize: buffer.length,
    dimensions: null,
  };

  await upsertPoints(config.collections.assets, [{ vector, payload }]);

  state.assets[relPath] = {
    hash,
    indexedAt: new Date().toISOString(),
    assetType: "audio",
    chunks: 1,
    description: transcript.slice(0, 200),
  };

  return { chunks: 1, skipped: false };
}

// --- Public API ---

export async function indexAllAssets(): Promise<{
  images: number;
  pdfs: number;
  audio: number;
  skipped: number;
  chunks: number;
}> {
  console.error("Ensuring collections exist...");
  await ensureCollections();

  let state = await loadState();
  state = await reconcileAssetState(state);
  const stats = { images: 0, pdfs: 0, audio: 0, skipped: 0, chunks: 0 };
  const extensions = getAllSupportedExtensions();
  const maxSize = config.assetIndexing.maxFileSizeMb * 1024 * 1024;

  for (const dir of config.sources.assets) {
    console.error(`Scanning: ${dir}`);

    const pattern = join(dir, "**/*");
    let files: string[];
    try {
      files = await glob(pattern);
    } catch {
      console.error(`Directory not found: ${dir}`);
      continue;
    }

    // Filter to supported extensions
    files = files.filter((f) => extensions.includes(extname(f).toLowerCase()));
    // Skip Zone.Identifier files (Windows metadata)
    files = files.filter((f) => !f.includes(":Zone.Identifier"));

    for (const filePath of files) {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.size > maxSize) {
        console.error(`  Skipping (too large): ${relativePath(filePath)}`);
        continue;
      }

      const assetType = detectAssetType(filePath);
      if (!assetType) continue;

      try {
        let result: { chunks: number; skipped: boolean };
        switch (assetType) {
          case "image":
            result = await indexImage(filePath, state);
            if (!result.skipped) stats.images++;
            break;
          case "pdf":
            result = await indexPdf(filePath, state);
            if (!result.skipped) stats.pdfs++;
            break;
          case "audio":
            result = await indexAudio(filePath, state);
            if (!result.skipped) stats.audio++;
            break;
        }
        if (result!.skipped) {
          stats.skipped++;
        } else {
          stats.chunks += result!.chunks;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error indexing ${relativePath(filePath)}: ${msg}`);
      }
    }
  }

  // Update totals and save
  state.lastRun = new Date().toISOString();
  state.totalAssetsIndexed = Object.keys(state.assets).length;
  await saveState(state);

  return stats;
}

export async function indexAssetFile(filePath: string): Promise<void> {
  await ensureCollections();
  const state = await loadState();
  const relPath = relativePath(filePath);
  const assetType = detectAssetType(filePath);

  if (!assetType) {
    console.error(`Unsupported asset type: ${relPath}`);
    return;
  }

  let result: { chunks: number; skipped: boolean };
  switch (assetType) {
    case "image":
      result = await indexImage(filePath, state);
      break;
    case "pdf":
      result = await indexPdf(filePath, state);
      break;
    case "audio":
      result = await indexAudio(filePath, state);
      break;
  }

  state.lastRun = new Date().toISOString();
  state.totalAssetsIndexed = Object.keys(state.assets).length;
  await saveState(state);

  if (result.skipped) {
    console.error(`Skipped (unchanged): ${relPath}`);
  } else {
    console.error(`Indexed: ${relPath} (${result.chunks} chunks)`);
  }
}

export async function deleteAsset(filePath: string): Promise<void> {
  const relPath = relativePath(filePath);
  await deleteBySource(config.collections.assets, relPath);

  const state = await loadState();
  delete state.assets[relPath];
  state.totalAssetsIndexed = Object.keys(state.assets).length;
  await saveState(state);

  console.error(`Deleted asset vectors: ${relPath}`);
}

export async function listAssets(): Promise<
  { source: string; assetType: string; description?: string; indexedAt: string }[]
> {
  const state = await loadState();
  return Object.entries(state.assets).map(([source, entry]) => ({
    source,
    assetType: entry.assetType,
    description: entry.description,
    indexedAt: entry.indexedAt,
  }));
}
