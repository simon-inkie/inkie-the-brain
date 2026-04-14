import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "crypto";
import { config } from "../config.js";

const client = new QdrantClient({
  url: config.qdrantUrl,
  ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
});

export { client };

function pointId(collection: string, sourcePath: string, chunkIndex: number): string {
  const hash = createHash("sha256")
    .update(`${collection}:${sourcePath}:${chunkIndex}`)
    .digest("hex");
  // Qdrant accepts UUIDs or unsigned integers. We'll use a UUID-like format from the hash.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

export async function ensureCollections(): Promise<void> {
  const collections = await client.getCollections();
  const existing = new Set(collections.collections.map((c) => c.name));

  for (const name of Object.values(config.collections)) {
    if (!existing.has(name)) {
      await client.createCollection(name, {
        vectors: {
          size: config.embeddingDimensions,
          distance: "Cosine",
        },
      });
      console.error(`Created collection: ${name}`);
    }
  }
}

export interface PointData {
  [key: string]: unknown;
  source: string;
  collection: string;
  title: string;
  chunk: number;
  totalChunks: number;
  content: string;
  indexedAt: string;
  tags: string[];
  date: string | null;
}

export async function upsertPoints(
  collection: string,
  points: { vector: number[]; payload: PointData }[]
): Promise<void> {
  if (points.length === 0) return;

  await client.upsert(collection, {
    wait: true,
    points: points.map((p) => ({
      id: pointId(collection, p.payload.source, p.payload.chunk),
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

export interface SearchResult {
  score: number;
  source: string;
  collection: string;
  title: string;
  content: string;
  tags: string[];
  date: string | null;
  // Asset-specific fields
  assetType?: string;
  mimeType?: string;
  description?: string;
  transcript?: string;
}

export async function search(
  collections: string[],
  queryVector: number[],
  limit: number,
  scoreThreshold: number
): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];

  for (const collection of collections) {
    try {
      const results = await client.search(collection, {
        vector: queryVector,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
      });

      for (const r of results) {
        const p = r.payload as Record<string, unknown>;
        const result: SearchResult = {
          score: r.score,
          source: (p.source as string) ?? "",
          collection: (p.collection as string) ?? collection,
          title: (p.title as string) ?? (p.role ? `${p.role} message` : ""),
          content: (p.content as string) ?? "",
          tags: (p.tags as string[]) ?? [],
          date: (p.date as string | null) ?? (p.timestamp as string | null) ?? null,
        };
        // Include asset-specific fields if present
        if (p.assetType) result.assetType = p.assetType as string;
        if (p.mimeType) result.mimeType = p.mimeType as string;
        if (p.description) result.description = p.description as string;
        if (p.transcript) result.transcript = p.transcript as string;
        allResults.push(result);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Collection might not exist yet — skip gracefully
      if (msg.includes("not found")) continue;
      throw e;
    }
  }

  // Sort by score descending, take top `limit`
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}

export async function deleteBySource(
  collection: string,
  sourcePath: string
): Promise<void> {
  await client.delete(collection, {
    wait: true,
    filter: {
      must: [{ key: "source", match: { value: sourcePath } }],
    },
  });
}

/**
 * Return the current point count for a collection. Returns 0 if the
 * collection doesn't exist. Used by indexer drift detection.
 */
export async function getCollectionPointCount(
  collection: string
): Promise<number> {
  try {
    const info = await client.getCollection(collection);
    return info.points_count ?? 0;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found") || msg.includes("doesn't exist")) return 0;
    throw e;
  }
}
