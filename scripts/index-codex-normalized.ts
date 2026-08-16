/**
 * One-off backfill indexer — embeds normalized Codex transcripts into the
 * messages collection.
 *
 * SAFETY: This script is EMBED_DRY_RUN-gated. In dry-run mode (the default
 * validation path) embedTexts() returns zero-vectors and no Qdrant upsert
 * ever fires. The same gate mechanism as indexCCSession in messages.ts.
 *
 * Usage:
 *   EMBED_DRY_RUN=true npx tsx scripts/index-codex-normalized.ts [--dir <path>] [--limit N]
 *   # Live run (spends real embed budget — check the dry-run summary first):
 *   BRAIN_MESSAGES_COLLECTION=io-messages-v2 npx tsx scripts/index-codex-normalized.ts
 *
 * Input format (one JSON object per line):
 *   { sessionId, agentName, seq, role, content, timestamp, timestampMs }
 */

import "../core/env.js";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { config } from "../core/config.js";
import { embedTexts } from "../core/embedder/text.js";
import { isDryRun, estimateCostUsd } from "../core/embedder/gate.js";
import { ensureCollections, client } from "../core/qdrant/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NormalizedMessage {
  sessionId: string;
  agentName: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  timestampMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHUNK_MAX_CHARS = config.chunkMaxTokens * 4;

// The logical/public collection identity written into every payload — mirrors
// what indexCCSession writes regardless of the BRAIN_MESSAGES_COLLECTION
// override. The actual target collection is config.collections.messages which
// may be overridden to io-messages-v2 for the blue-green rebuild; the payload
// field stays "io-messages" so cross-collection queries remain coherent.
const LOGICAL_COLLECTION_NAME = "io-messages";

// Default input location. Override with --dir for a transcript dump held
// anywhere else.
const DEFAULT_CODEX_DIR = join(
  homedir(),
  ".the-brain",
  "codex-normalized"
);

// ---------------------------------------------------------------------------
// Point ID — deterministic, UUID-shaped, mirrors ccPointId in messages.ts
// Key: codex:<agentName>/<sessionId>:msg-<seq>:chunk-<chunkIndex>
// ---------------------------------------------------------------------------

export function codexPointId(
  agentName: string,
  sessionId: string,
  seq: number,
  chunkIndex: number
): string {
  const hash = createHash("sha256")
    .update(`codex:${agentName}/${sessionId}:msg-${seq}:chunk-${chunkIndex}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Message → embedding text
// ---------------------------------------------------------------------------

export function messageToText(msg: Pick<NormalizedMessage, "role" | "content">): string {
  return `[${msg.role}] ${msg.content}`;
}

// ---------------------------------------------------------------------------
// Chunking — same char budget as messages.ts
// ---------------------------------------------------------------------------

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_MAX_CHARS) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_MAX_CHARS) {
    chunks.push(text.slice(i, i + CHUNK_MAX_CHARS));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Parse a JSONL file into NormalizedMessage[]
// Silently skips blank lines and unparseable lines.
// ---------------------------------------------------------------------------

export function parseCodexJSONL(raw: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = parsed as Record<string, unknown>;
    if (
      typeof msg.sessionId !== "string" ||
      typeof msg.agentName !== "string" ||
      typeof msg.seq !== "number" ||
      (msg.role !== "user" && msg.role !== "assistant") ||
      typeof msg.content !== "string" ||
      typeof msg.timestamp !== "string" ||
      typeof msg.timestampMs !== "number"
    ) {
      continue;
    }
    messages.push({
      sessionId: msg.sessionId,
      agentName: msg.agentName,
      seq: msg.seq,
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: msg.timestamp,
      timestampMs: msg.timestampMs,
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dir: string; limit: number | null } {
  let dir = DEFAULT_CODEX_DIR;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = argv[i + 1];
      i++;
    } else if (argv[i] === "--limit" && argv[i + 1]) {
      limit = parseInt(argv[i + 1], 10);
      i++;
    }
  }
  return { dir, limit };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dir, limit } = parseArgs(process.argv.slice(2));

  // Ensure the target collection exists (no-op if already present)
  await ensureCollections();

  const targetCollection = config.collections.messages;

  // Discover *.jsonl files
  let files: string[];
  try {
    const entries = await readdir(dir);
    files = entries
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f))
      .sort();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[codex-indexer] Cannot read dir ${dir}: ${msg}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`[codex-indexer] No .jsonl files found in ${dir}`);
    process.exit(1);
  }

  const batchSize = 100;
  const indexedAt = new Date().toISOString();
  const dryRun = isDryRun();

  // Accumulators for the summary
  let totalFiles = 0;
  let totalMessages = 0;
  let totalChunks = 0;
  let totalChars = 0;
  let totalEmbedCalls = 0;
  let chunkedMessages = 0; // messages that required >1 chunk

  for (const filePath of files) {
    const filename = filePath.split("/").pop() ?? filePath;
    // Derive agentName + sessionId from filename: <agent>-<sessionId>.jsonl
    // The session UUID contains hyphens; the agent name is everything before
    // the first UUID segment boundary. We parse from the messages themselves.

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[codex-indexer] Skipping ${filename}: ${msg}`);
      continue;
    }

    let messages = parseCodexJSONL(raw);
    if (messages.length === 0) {
      console.error(`[codex-indexer] ${filename}: 0 messages, skipping`);
      continue;
    }

    if (limit !== null && totalMessages + messages.length > limit) {
      messages = messages.slice(0, Math.max(0, limit - totalMessages));
    }

    totalFiles++;
    totalMessages += messages.length;

    // The agentName and sessionId come from the messages themselves (all
    // messages in a file share the same sessionId + agentName)
    const agentName = messages[0].agentName;
    const sessionId = messages[0].sessionId;
    const sourceValue = `codex:${agentName}/${sessionId}`;

    // Build all chunks
    const allChunks: {
      msg: NormalizedMessage;
      chunkIndex: number;
      totalChunks: number;
      text: string;
    }[] = [];

    for (const msg of messages) {
      const baseText = messageToText(msg);
      const chunks = chunkText(baseText);
      if (chunks.length > 1) chunkedMessages++;
      for (let i = 0; i < chunks.length; i++) {
        allChunks.push({
          msg,
          chunkIndex: i,
          totalChunks: chunks.length,
          text: chunks[i],
        });
      }
    }

    totalChunks += allChunks.length;
    const fileChars = allChunks.reduce((s, c) => s + c.text.length, 0);
    totalChars += fileChars;

    // Batch-embed (batch size 100, 100ms inter-batch sleep — mirrors indexCCSession)
    const allVectors: number[][] = [];
    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize).map((c) => c.text);
      const vectors = await embedTexts(batch, "RETRIEVAL_DOCUMENT");
      allVectors.push(...vectors);
      totalEmbedCalls++;
      if (i + batchSize < allChunks.length) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Build points
    const points = allChunks.map((c, i) => ({
      id: codexPointId(agentName, sessionId, c.msg.seq, c.chunkIndex),
      vector: allVectors[i],
      payload: {
        source: sourceValue,
        sessionId: c.msg.sessionId,
        content: c.text,
        timestamp: c.msg.timestamp,
        timestampMs: c.msg.timestampMs,
        agentName: c.msg.agentName,
        // codex has no real projectDir; namespaced to keep the field present
        // and allow filtering without colliding with CC paths
        projectDir: `codex:${agentName}`,
        collection: LOGICAL_COLLECTION_NAME,
        chunk: c.chunkIndex,
        totalChunks: c.totalChunks,
        indexedAt,
        // CC-parity fields: pairIndex maps to seq (closest equivalent),
        // userMessageId/assistantMessageId are not available in the codex format
        pairIndex: c.msg.seq,
        userMessageId: null,
        assistantMessageId: null,
      },
    }));

    // Upsert in batches of 100 — ONLY if not dry-run, exactly like indexCCSession
    if (process.env.EMBED_DRY_RUN !== "true") {
      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        await client.upsert(targetCollection, { wait: true, points: batch });
      }
    }

    console.error(
      `[codex-indexer] ${filename}: ${messages.length} msgs → ${allChunks.length} chunks, ${fileChars} chars`
    );

    if (limit !== null && totalMessages >= limit) break;
  }

  // Summary
  const estCostUsd = estimateCostUsd(totalChars);
  console.log("");
  console.log("=== Codex Normalized Indexer Summary ===");
  console.log(`Files read:          ${totalFiles}`);
  console.log(`Messages:            ${totalMessages}`);
  console.log(`Total chunks:        ${totalChunks}`);
  console.log(`Messages chunked:    ${chunkedMessages} (needed >1 chunk)`);
  console.log(`Total chars:         ${totalChars.toLocaleString()}`);
  console.log(`Embed batches:       ${totalEmbedCalls}`);
  console.log(`Est. cost USD:       $${estCostUsd.toFixed(6)}`);
  console.log(`Dry-run:             ${dryRun}`);
  console.log(`Target collection:   ${targetCollection}`);
  console.log(`Logical collection:  ${LOGICAL_COLLECTION_NAME}`);
  if (dryRun) {
    console.log("");
    console.log("NOTE: EMBED_DRY_RUN=true — zero real embeds, zero Qdrant upserts.");
  }
}

// Guard the main() call so this module can be imported in tests without
// auto-executing. Standard ESM "is main module" pattern.
// process.argv[1] is set by Node when this file is the entry point; when
// imported as a module (e.g. by vitest), this block is skipped.
if (
  process.argv[1] &&
  (process.argv[1].endsWith("index-codex-normalized.ts") ||
    process.argv[1].endsWith("index-codex-normalized.js"))
) {
  main().catch((e) => {
    console.error("[codex-indexer] Fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
