import { readFile } from "fs/promises";
import { extname } from "path";
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

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
};

export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Embed an image directly via Gemini Embedding 2's multimodal support.
 */
export async function embedImage(imagePath: string): Promise<number[]> {
  const data = await readFile(imagePath);
  const base64 = data.toString("base64");
  const mimeType = getMimeType(imagePath);

  const response = await getClient().models.embedContent({
    model: config.embeddingModel,
    contents: [
      {
        parts: [{ inlineData: { data: base64, mimeType } }],
      },
    ],
    config: {
      outputDimensionality: config.embeddingDimensions,
      taskType: "RETRIEVAL_DOCUMENT",
    },
  });

  if (!response.embeddings?.[0]?.values) {
    throw new Error("No embedding returned for image");
  }
  return response.embeddings[0].values;
}

/**
 * Embed an image together with contextual text for better retrieval.
 */
export async function embedImageWithContext(
  imagePath: string,
  contextText: string
): Promise<number[]> {
  const data = await readFile(imagePath);
  const base64 = data.toString("base64");
  const mimeType = getMimeType(imagePath);

  const response = await getClient().models.embedContent({
    model: config.embeddingModel,
    contents: [
      {
        parts: [
          { text: contextText },
          { inlineData: { data: base64, mimeType } },
        ],
      },
    ],
    config: {
      outputDimensionality: config.embeddingDimensions,
      taskType: "RETRIEVAL_DOCUMENT",
    },
  });

  if (!response.embeddings?.[0]?.values) {
    throw new Error("No embedding returned for image+context");
  }
  return response.embeddings[0].values;
}

/**
 * Generate a text description of an image using Gemini generative model.
 */
export async function describeImage(imagePath: string): Promise<string> {
  const data = await readFile(imagePath);
  const base64 = data.toString("base64");
  const mimeType = getMimeType(imagePath);

  const response = await getClient().models.generateContent({
    model: config.assetIndexing.descriptionModel,
    contents: [
      {
        parts: [
          {
            text: "Describe this image in detail. Include any text visible in the image, diagrams, UI elements, charts, or notable visual elements. Be concise but thorough.",
          },
          { inlineData: { data: base64, mimeType } },
        ],
      },
    ],
  });

  const text = response.text;
  if (!text) throw new Error("No description generated for image");
  return text;
}

/**
 * Extract text from a PDF per-page using pdfjs-dist.
 */
export async function extractPdfPages(
  pdfPath: string
): Promise<{ pageNumber: number; text: string }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buffer = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pages: { pageNumber: number; text: string }[] = [];
  const maxPages = Math.min(doc.numPages, config.assetIndexing.maxPdfPages);

  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    if (text.length > 0) {
      pages.push({ pageNumber: i, text });
    }
  }

  doc.destroy();
  return pages;
}

/**
 * Embed a PDF directly via Gemini Embedding 2's native PDF support.
 * Accepts a file path or a raw Buffer.
 */
export async function embedPdf(pathOrBuffer: string | Buffer): Promise<number[]> {
  const data = typeof pathOrBuffer === "string" 
    ? await readFile(pathOrBuffer) 
    : pathOrBuffer;
  const base64 = data.toString("base64");

  const response = await getClient().models.embedContent({
    model: config.embeddingModel,
    contents: [
      {
        parts: [
          {
            inlineData: {
              data: base64,
              mimeType: "application/pdf",
            },
          },
        ],
      },
    ],
    config: {
      outputDimensionality: config.embeddingDimensions,
      taskType: "RETRIEVAL_DOCUMENT",
    },
  });

  if (!response.embeddings?.[0]?.values) {
    throw new Error("No embedding returned for PDF");
  }
  return response.embeddings[0].values;
}

/**
 * Split a PDF buffer into chunks of up to `chunkSize` pages.
 * Returns an array of { buffer, startPage, endPage } for each chunk.
 */
export async function splitPdfIntoChunks(
  pdfBuffer: Buffer,
  chunkSize = 6
): Promise<{ buffer: Buffer; startPage: number; endPage: number }[]> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBuffer);
  const totalPages = doc.getPageCount();
  const chunks: { buffer: Buffer; startPage: number; endPage: number }[] = [];

  for (let start = 0; start < totalPages; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalPages);
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const subDoc = await PDFDocument.create();
    const copiedPages = await subDoc.copyPages(doc, pageIndices);
    copiedPages.forEach((p) => subDoc.addPage(p));
    const bytes = await subDoc.save();
    chunks.push({
      buffer: Buffer.from(bytes),
      startPage: start + 1, // 1-indexed
      endPage: end,
    });
  }

  return chunks;
}

/**
 * Transcribe audio using Gemini generative model.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  const data = await readFile(audioPath);
  const base64 = data.toString("base64");
  const mimeType = getMimeType(audioPath);

  const response = await getClient().models.generateContent({
    model: config.assetIndexing.descriptionModel,
    contents: [
      {
        parts: [
          { text: "Transcribe this audio completely and accurately." },
          { inlineData: { data: base64, mimeType } },
        ],
      },
    ],
  });

  const text = response.text;
  if (!text) throw new Error("No transcription generated for audio");
  return text;
}
