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
  const response = await getClient().models.embedContent({
    model: config.embeddingModel,
    contents: texts,
    config: {
      outputDimensionality: config.embeddingDimensions,
      taskType,
    },
  });

  if (!response.embeddings) {
    throw new Error("No embeddings returned from Gemini API");
  }

  return response.embeddings.map((e) => {
    if (!e.values) throw new Error("Embedding has no values");
    return e.values;
  });
}

export async function embedText(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[]> {
  const results = await embedTexts([text], taskType);
  return results[0];
}
