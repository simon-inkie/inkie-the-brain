import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Embedding provider seam (text embeddings).
//
// EMBED_PROVIDER selects the backend; everything else is environment config,
// so a new backend needs no code edit:
//
//   gemini  (default)  GEMINI_API_KEY, optional EMBED_MODEL
//   openai             Any OpenAI-compatible POST {EMBED_BASE_URL}/embeddings
//                      endpoint: Ollama, llama.cpp server, LM Studio, vLLM,
//                      or a hosted service. A local server needs no key and
//                      works offline.
//
// Shared: EMBED_MODEL, EMBED_DIMENSIONS (read in core/config.ts and sizes the
// Qdrant collections). openai only: EMBED_BASE_URL (default the Ollama
// address), EMBED_API_KEY (optional), EMBED_QUERY_PREFIX and
// EMBED_DOCUMENT_PREFIX (some local models want a task prefix),
// EMBED_SEND_DIMENSIONS=true (send `dimensions` to servers that truncate).
//
// Image, PDF and audio embedding (core/embedder/assets.ts) is Gemini-only and
// is not routed through this seam.
// ---------------------------------------------------------------------------

export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbeddingProvider {
  readonly name: string;
  /** True when calls cost money, so the spend gate should price them. */
  readonly metered: boolean;
  embed(text: string, taskType: EmbedTaskType): Promise<number[]>;
}

export const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";

export function providerName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.EMBED_PROVIDER || "gemini").trim().toLowerCase();
}

function geminiProvider(env: NodeJS.ProcessEnv): EmbeddingProvider {
  let ai: GoogleGenAI | null = null;
  return {
    name: "gemini",
    metered: true,
    async embed(text, taskType) {
      if (!ai) {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY not set");
        ai = new GoogleGenAI({ apiKey });
      }
      const response = await ai.models.embedContent({
        model: env.EMBED_MODEL || config.embeddingModel,
        contents: text,
        config: { outputDimensionality: config.embeddingDimensions, taskType },
      });
      const values = response.embeddings?.[0]?.values;
      if (!values) throw new Error("Embedding has no values");
      return values;
    },
  };
}

function openaiProvider(env: NodeJS.ProcessEnv): EmbeddingProvider {
  const baseUrl = (env.EMBED_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  return {
    name: "openai",
    // A key means a hosted service; no key means a local server. Only the
    // hosted case is priced, and the Gemini rate would be the wrong one, so
    // neither is metered here. The tick kill switch still applies.
    metered: false,
    async embed(text, taskType) {
      const model = env.EMBED_MODEL;
      if (!model) throw new Error("EMBED_MODEL not set (required when EMBED_PROVIDER=openai)");
      const prefix =
        (taskType === "RETRIEVAL_QUERY" ? env.EMBED_QUERY_PREFIX : env.EMBED_DOCUMENT_PREFIX) ?? "";
      const body: Record<string, unknown> = { model, input: prefix + text };
      if (env.EMBED_SEND_DIMENSIONS === "true") body.dimensions = config.embeddingDimensions;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (env.EMBED_API_KEY) headers.authorization = `Bearer ${env.EMBED_API_KEY}`;

      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Status code stays in the message: the retry classifier matches on it.
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`embedding request failed: HTTP ${res.status} ${detail}`);
      }
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const values = json.data?.[0]?.embedding;
      if (!values) throw new Error("Embedding has no values");
      if (values.length !== config.embeddingDimensions) {
        throw new Error(
          `embedding has ${values.length} dimensions but EMBED_DIMENSIONS is ${config.embeddingDimensions}; set EMBED_DIMENSIONS to the model's size and index into a fresh collection`,
        );
      }
      return values;
    },
  };
}

export function createProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const name = providerName(env);
  switch (name) {
    case "gemini":
      return geminiProvider(env);
    case "openai":
      return openaiProvider(env);
    default:
      throw new Error(`unknown EMBED_PROVIDER "${name}" (expected gemini or openai)`);
  }
}

let cached: EmbeddingProvider | null = null;

export function getProvider(): EmbeddingProvider {
  if (!cached) cached = createProvider();
  return cached;
}

/** Test seam: drop the cached provider so the next call re-reads the environment. */
export function resetProvider(): void {
  cached = null;
}
