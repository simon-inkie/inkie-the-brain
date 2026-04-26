import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

let ai: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

export async function embedTexts(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[][]> {
  const client = getClient();
  const vectors: number[][] = [];
  const concurrency = 5;

  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((text) =>
        client.models.embedContent({
          model: config.embeddingModel,
          contents: text,
          config: {
            outputDimensionality: config.embeddingDimensions,
            taskType,
          },
        })
      )
    );

    for (const [j, response] of results.entries()) {
      if (!response.embeddings || response.embeddings.length === 0) {
        throw new Error(`No embedding returned for text ${i + j}`);
      }
      const values = response.embeddings[0].values;
      if (!values) throw new Error(`Embedding ${i + j} has no values`);
      vectors.push(values);
    }
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
