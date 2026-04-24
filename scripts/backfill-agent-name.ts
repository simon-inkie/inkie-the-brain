// One-off: backfill `agentName` payload field on existing Qdrant points.
// Derives name from each point's `source` field via collection-router's
// `agentNameFromPath`. Points with no agent match (brain-vault, legacy orphan
// sources) get agentName: null — scope-filtered queries skip them.
//
// Usage: tsx scripts/backfill-agent-name.ts
// Safe to re-run: setPayload is idempotent; agentName gets the same value.

import "../core/env.js";
import { config } from "../core/config.js";
import { client, ensureCollections } from "../core/qdrant/client.js";
import { agentNameFromPath } from "../core/indexer/collection-router.js";

const TARGET_COLLECTIONS = [
  config.collections.observations,
  config.collections.reflections,
  config.collections.assets,
  // brain-vault and messages deliberately excluded — no agentName scoping in v1
];

interface PointInfo {
  id: string | number;
  source: string;
  agentName: string | null;
}

async function scrollAll(collection: string): Promise<PointInfo[]> {
  const out: PointInfo[] = [];
  let offset: string | number | null | undefined = undefined;

  while (true) {
    const res = await client.scroll(collection, {
      limit: 256,
      with_payload: { include: ["source", "agentName"] },
      with_vector: false,
      offset,
    });

    for (const p of res.points) {
      const payload = (p.payload as Record<string, unknown>) ?? {};
      const source = (payload.source as string) ?? "";
      out.push({
        id: p.id as string | number,
        source,
        agentName: agentNameFromPath(source),
      });
    }

    offset = res.next_page_offset;
    if (!offset) break;
  }

  return out;
}

async function main() {
  console.error("Ensuring collections + payload indexes...");
  await ensureCollections();

  for (const collection of TARGET_COLLECTIONS) {
    console.error(`\n=== ${collection} ===`);
    const points = await scrollAll(collection);
    console.error(`  scrolled: ${points.length} points`);

    // Group point IDs by the agentName value we'll set.
    const byAgent = new Map<string | null, (string | number)[]>();
    for (const p of points) {
      const key = p.agentName;
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key)!.push(p.id);
    }

    for (const [agentName, ids] of byAgent) {
      // Batch setPayload in chunks of 500 to keep request sizes sane.
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        await client.setPayload(collection, {
          wait: true,
          points: batch,
          payload: { agentName },
        });
      }
      const label = agentName === null ? "(null — unscoped)" : agentName;
      console.error(`  setPayload agentName=${label}: ${ids.length} points`);
    }
  }

  console.error("\nBackfill complete.");
}

await main();
