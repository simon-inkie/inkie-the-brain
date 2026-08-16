import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import {
  isDryRun,
  dryRunVector,
  chargeTick,
  estimateCostUsd,
} from "./gate.js";

// Re-export gate symbols so callers importing them from here keep working.
export {
  EmbedQuotaExceededError,
  resetTickCounter,
  flushTelemetry,
} from "./gate.js";

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

let ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

// ---------------------------------------------------------------------------
// 429 backoff/retry
// ---------------------------------------------------------------------------
//
// New GCP projects start with low Generative Language API rate limits (RPM/TPM).
// A burst of parallel embed calls trips 429 RESOURCE_EXHAUSTED. Without retry the
// indexer just fails the whole session and moves on (silent gap) — and the
// watcher would 429-loop forever. Retry with exponential backoff + jitter so the
// pipeline self-throttles through the quota. Non-429 errors throw immediately.

const EMBED_MAX_RETRIES = parseInt(process.env.EMBED_MAX_RETRIES ?? "6", 10);

// Retry both rate-limits (429) AND transient server errors (500/503). All are
// recoverable on retry; a non-retryable error (bad request, auth) throws
// immediately. Without this a single transient blip fails the whole session.
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("503") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("500") ||
    msg.includes("INTERNAL")
  );
}

async function embedContentWithRetry(
  client: GoogleGenAI,
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[]> {
  let delayMs = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await client.models.embedContent({
        model: config.embeddingModel,
        contents: text,
        config: {
          outputDimensionality: config.embeddingDimensions,
          taskType,
        },
      });
      const values = response.embeddings?.[0]?.values;
      if (!values) throw new Error("Embedding has no values");
      return values;
    } catch (e) {
      if (isRetryableError(e) && attempt <= EMBED_MAX_RETRIES) {
        // jitter avoids a thundering-herd retry when a whole batch fails together
        const jitter = Math.floor((attempt * 137) % 500);
        const wait = delayMs + jitter;
        const reason = e instanceof Error ? e.message.slice(0, 60) : "transient";
        console.error(
          `[embedder] retryable error (attempt ${attempt}/${EMBED_MAX_RETRIES}) — backing off ${wait}ms — ${reason}`
        );
        await new Promise((r) => setTimeout(r, wait));
        delayMs = Math.min(delayMs * 2, 60000);
        continue;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// embedTexts — main export
// ---------------------------------------------------------------------------

export async function embedTexts(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Kill-switch + telemetry: chargeTick throws if quota exceeded
  const totalChars = texts.reduce((s, t) => s + t.length, 0);
  const estCostUsd = estimateCostUsd(totalChars);
  chargeTick(texts.length, totalChars, estCostUsd);

  // Dry-run: return zero-vectors of correct dimension, no Gemini call
  if (isDryRun()) {
    return texts.map(() => dryRunVector());
  }

  const client = getClient();
  const vectors: number[][] = [];
  // Concurrency 3 (was 5): gentler burst against new-project rate limits; the
  // 429 backoff/retry below is the real resilience, this just reduces how often
  // we hit it.
  const concurrency = 3;

  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency);
    const batchVectors = await Promise.all(
      batch.map((text) => embedContentWithRetry(client, text, taskType))
    );
    vectors.push(...batchVectors);
  }

  return vectors;
}

export async function embedText(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[]> {
  const results = await embedTexts([text], taskType);
  return results[0];
}
