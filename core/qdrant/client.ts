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

  for (const coll of [
    config.collections.observations,
    config.collections.reflections,
    config.collections.messages,
  ]) {
    await ensurePayloadIndex(coll, "agentName", "keyword");
  }
}

export async function ensurePayloadIndex(
  collection: string,
  field: string,
  schema: "keyword" | "integer" | "float" | "geo" | "text" | "bool",
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, {
      field_name: field,
      field_schema: schema,
      wait: true,
    });
    console.error(`Created payload index: ${collection}.${field} (${schema})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("already exists") ||
      msg.includes("not found") ||
      msg.toLowerCase().includes("index for field")
    ) {
      return;
    }
    throw e;
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
  agentName: string | null;
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
  assetType?: string;
  mimeType?: string;
  description?: string;
  transcript?: string;
}

export interface SearchFilter {
  agentNames?: string[];
  /** ISO date or datetime string. Inclusive lower bound. */
  from?: string;
  /** ISO date or datetime string. Inclusive upper bound. */
  to?: string;
}

function buildDateClauses(
  collection: string,
  from?: string,
  to?: string,
): Record<string, unknown>[] {
  if (!from && !to) return [];

  // io-messages stores numeric `timestampMs`; everything else stores `date` as YYYY-MM-DD string.
  if (collection === "io-messages") {
    const range: Record<string, number> = {};
    if (from) range.gte = new Date(from).getTime();
    if (to) range.lte = new Date(to).getTime();
    return [{ key: "timestampMs", range }];
  }

  const range: Record<string, string> = {};
  if (from) range.gte = from.slice(0, 10);
  if (to) range.lte = to.slice(0, 10);
  return [{ key: "date", range }];
}

export async function search(
  collections: string[],
  queryVector: number[],
  limit: number,
  scoreThreshold: number,
  filter?: SearchFilter,
): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];

  for (const collection of collections) {
    const must: Record<string, unknown>[] = [];
    if (filter?.agentNames && filter.agentNames.length > 0) {
      must.push({ key: "agentName", match: { any: filter.agentNames } });
    }
    must.push(...buildDateClauses(collection, filter?.from, filter?.to));
    const qdrantFilter = must.length > 0 ? { must } : undefined;

    try {
      const results = await client.search(collection, {
        vector: queryVector,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
        ...(qdrantFilter ? { filter: qdrantFilter } : {}),
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
        if (p.assetType) result.assetType = p.assetType as string;
        if (p.mimeType) result.mimeType = p.mimeType as string;
        if (p.description) result.description = p.description as string;
        if (p.transcript) result.transcript = p.transcript as string;
        allResults.push(result);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not found")) continue;
      throw e;
    }
  }

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
