---
name: io-message-indexer
description: "Indexes inbound and outbound messages into Qdrant in real-time using Gemini Embedding 2"
metadata:
  openclaw:
    emoji: "🧠"
    events: ["message:preprocessed", "message:sent"]
    requires:
      env: ["GEMINI_API_KEY", "QDRANT_URL"]
---

# io-message-indexer

Replaces the hourly "Io Message Indexer" cron with real-time, event-driven indexing.

On every inbound (`message:preprocessed`) and outbound (`message:sent`) message:

1. Extracts text content from event context
2. Filters noise (heartbeats, NO_REPLY, short messages) using existing skip patterns
3. Embeds via Gemini Embedding 2 (`RETRIEVAL_DOCUMENT` task type)
4. Upserts single point to Qdrant `io-messages` collection

All work is fire-and-forget — never blocks message processing.
Deduplication is handled by Qdrant upsert with deterministic point IDs.
