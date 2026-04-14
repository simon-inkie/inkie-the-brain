import { createHash, randomUUID } from "crypto";

// Side-effect import: loads ~/io-data/.env into process.env
import "../../../../../core/env.js";

import { embedText } from "../../../../../core/embedder/text.js";
import { client, ensureCollections } from "../../../../../core/qdrant/client.js";
import { config } from "../../../../../core/config.js";
import { extractTextContent } from "../../../../../core/indexer/messages.js";

// --- Singleton initialisation at module load ---

const collectionReady = ensureCollections().catch((err) => {
  console.error("[io-message-indexer] Failed to ensure collections:", err);
});

const COLLECTION = config.collections.messages;

// --- Noise filtering (mirrors private shouldSkipMessage from message-indexer) ---

function shouldSkipMessage(role: string, content: string): boolean {
  if (!config.messageIndexing.roles.includes(role)) return true;
  if (content.length < config.messageIndexing.minContentLength) return true;
  for (const pattern of config.messageIndexing.skipPatterns) {
    if (pattern.test(content)) return true;
  }
  return false;
}

// --- Point ID generation (mirrors private messagePointId from message-indexer) ---

function messagePointId(sessionId: string, messageId: string): string {
  const hash = createHash("sha256")
    .update(`io-messages:${sessionId}:${messageId}`)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

// --- Core indexing ---

async function indexMessage(
  role: string,
  content: string,
  event: Record<string, unknown>
): Promise<void> {
  try {
    await collectionReady;

    const text = typeof content === "string" ? content : extractTextContent(content);
    if (!text.trim() || shouldSkipMessage(role, text)) return;

    const ctx = (event.context ?? event) as Record<string, unknown>;
    const channelId = (ctx.channelId ?? ctx.channel ?? "unknown") as string;
    const conversationId = (ctx.conversationId ?? ctx.threadId ?? "main") as string;
    const messageId = (ctx.messageId ?? randomUUID()) as string;
    const sessionId = `${channelId}:${conversationId}`;

    const vector = await embedText(text, "RETRIEVAL_DOCUMENT");

    const pointId = messagePointId(sessionId, messageId);
    const now = new Date();

    await client.upsert(COLLECTION, {
      wait: false,
      points: [
        {
          id: pointId,
          vector,
          payload: {
            source: channelId,
            sessionId,
            messageId,
            role,
            content: text,
            timestamp: now.toISOString(),
            timestampMs: now.getTime(),
            indexedAt: now.toISOString(),
          },
        },
      ],
    });

    console.error(
      `[io-message-indexer] Indexed ${role} message (${text.length} chars) from ${channelId}`
    );
  } catch (err) {
    console.error("[io-message-indexer] Error indexing message:", err);
  }
}

// --- Hook handler (default export) ---

export default function handler(event: Record<string, unknown>): void {
  try {
    const type = event.type as string | undefined;
    const action = event.action as string | undefined;
    const ctx = (event.context ?? {}) as Record<string, unknown>;

    // Inbound message
    if (type === "message" && action === "preprocessed") {
      const content = (ctx.bodyForAgent ?? ctx.body ?? ctx.content) as
        | string
        | undefined;
      if (!content?.trim()) return;
      void indexMessage("user", content, event);
      return;
    }

    // Outbound message
    if (type === "message" && action === "sent") {
      const content = ctx.content as string | undefined;
      if (!content?.trim() || !ctx.success) return;
      void indexMessage("assistant", content, event);
      return;
    }
  } catch (err) {
    console.error("[io-message-indexer] Handler error:", err);
  }
}
