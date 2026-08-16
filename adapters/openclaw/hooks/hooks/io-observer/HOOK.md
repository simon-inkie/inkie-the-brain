---
name: io-observer
description: "Event-driven observation and reflection pipeline — replaces cron-based observer"
metadata:
  openclaw:
    emoji: "👁️"
    events: ["message:preprocessed", "message:sent"]
    requires:
      env: ["GEMINI_API_KEY"]
---

# io-observer

Replaces the memory-observer cron with event-driven observation and reflection.

On every inbound (`message:preprocessed`) and outbound (`message:sent`) message:

1. Extracts text content from event context
2. Filters noise (heartbeats, NO_REPLY, short messages)
3. Pushes to in-memory ring buffer
4. Checks observation thresholds (message count + char count + 25-min gap)
5. When thresholds met, fires `observe.sh` with formatted transcript
6. After observation, checks reflection thresholds and fires `reflect.sh` if due

All work is fire-and-forget — never blocks message processing.
Shell scripts handle prompt loading, state updates, build-context, and Qdrant indexing.
