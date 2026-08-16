# io-observer Hook — Spec

## Overview

Event-driven observation + reflection hook. Replaces the memory-observer cron job and heartbeat reflection checks with real-time, fire-and-forget processing.

**Trigger:** `message:preprocessed` (inbound) + `message:sent` (outbound)

**Pipeline:**
1. Accumulate messages in memory (ring buffer)
2. When thresholds hit → fire Gemini Flash to write observation
3. When observation count hits reflection threshold → fire Gemini Flash to write reflection
4. Run `build-context.sh` after each to update MEMORY.md live section

## Architecture

### Message Accumulation

The hook maintains an in-memory message buffer (array of `{role, content, timestamp}`).

On every event:
1. Extract content from event context (same pattern as `io-message-indexer`)
2. Skip noise (heartbeats, NO_REPLY, short messages) using same `shouldSkipMessage()` filter
3. Push to ring buffer
4. Check thresholds:
   - `messageCount >= observationMessageThreshold` (default: 6) AND
   - `totalChars >= observationCharThreshold` (default: 500)
5. If both met AND `lastObservationAt` was > 25 min ago → trigger observation
6. After observation, check reflection thresholds from updated `observer-state.json`

### Observation (Gemini Flash)

When thresholds hit:

1. Format accumulated messages into conversation transcript:
   ```
   [HH:MM] {USER_NAME}: message text
   [HH:MM] {AGENT_NAME}: response text
   ```
2. Write transcript to `/tmp/obs-input-{timestamp}.txt`
3. Call Gemini Flash (`gemini-2.0-flash`) with the observation prompt from `memory/OBSERVATION-PROMPT.md`
4. Write output to `memory/observations/YYYY-MM-DD-HH-MM.md`
5. Update `observer-state.json` (increment count + chars)
6. Run `build-context.sh` to update MEMORY.md
7. Clear the message buffer
8. Check if reflection is due

**Alternative approach (simpler):** Just run `observe.sh` via `child_process.exec()`. This reuses all existing logic (prompt loading, state updates, build-context, Qdrant indexing, cross-linking). The hook's job is just accumulation + threshold checking + firing the shell script. **This is the recommended approach.**

### Reflection

When `observer-state.json` shows:
- `unprocessedObservationCount >= reflectionTriggerThreshold` (default: 8) OR
- `unprocessedObservationChars >= reflectionCharThreshold` (default: 25000)

Then run `reflect.sh` via `child_process.exec()`.

### State

- **In-memory:** message buffer (lost on restart — that's fine, accumulates fresh)
- **On disk:** `observer-state.json` (read for thresholds + lastObservationAt, written by observe.sh/reflect.sh)

No separate state file for the hook. The existing `observer-state.json` is the single source of truth.

## Implementation

### HOOK.md

```yaml
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
```

### handler.ts

```typescript
import { readFileSync } from "fs";
import { exec } from "child_process";
import { join } from "path";
import { homedir } from "os";

// --- Config ---

const WORKSPACE = join(homedir(), ".openclaw", "workspace");
const STATE_FILE = join(WORKSPACE, "memory", "observer-state.json");
const OBSERVE_SH = join(WORKSPACE, "memory", "tools", "observe.sh");
const REFLECT_SH = join(WORKSPACE, "memory", "tools", "reflect.sh");

const MIN_OBSERVATION_GAP_MS = 25 * 60 * 1000; // 25 minutes

// --- Noise filtering (same as io-message-indexer) ---
// Import or duplicate shouldSkipMessage logic

// --- Message buffer ---

interface BufferedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const buffer: BufferedMessage[] = [];
let observationInFlight = false;

// --- State reading ---

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      lastObservationAt: null,
      observationMessageThreshold: 6,
      observationCharThreshold: 500,
      reflectionTriggerThreshold: 8,
      reflectionCharThreshold: 25000,
    };
  }
}

// --- Threshold checking ---

function shouldObserve(): boolean {
  if (observationInFlight) return false;

  const state = readState();
  const msgThreshold = state.observationMessageThreshold ?? 6;
  const charThreshold = state.observationCharThreshold ?? 500;
  const lastAt = state.lastObservationAt ? new Date(state.lastObservationAt).getTime() : 0;
  const gap = Date.now() - lastAt;

  if (gap < MIN_OBSERVATION_GAP_MS) return false;
  if (buffer.length < msgThreshold) return false;

  const totalChars = buffer.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars < charThreshold) return false;

  return true;
}

// --- Observation trigger ---

function triggerObservation(): void {
  observationInFlight = true;

  // Format transcript
  const transcript = buffer
    .map((m) => {
      const t = new Date(m.timestamp).toISOString().slice(11, 16);
      const speaker = m.role === "user" ? (process.env.USER_NAME || "User") : (process.env.AGENT_NAME || "Agent");
      return `[${t}] ${speaker}: ${m.content}`;
    })
    .join("\n\n");

  // Write temp file and run observe.sh
  const tmpFile = `/tmp/obs-input-${Date.now()}.txt`;
  require("fs").writeFileSync(tmpFile, transcript);

  exec(
    `cd ${WORKSPACE} && bash ${OBSERVE_SH} --file ${tmpFile}`,
    { timeout: 60000, env: { ...process.env, PATH: process.env.PATH + ":" + join(homedir(), ".local", "bin") } },
    (err, stdout, stderr) => {
      observationInFlight = false;
      buffer.length = 0; // Clear buffer after observation

      if (err) {
        console.error("[io-observer] observe.sh error:", err.message);
        return;
      }
      console.error(`[io-observer] ${stdout.trim()}`);

      // Check if reflection is due
      checkReflection();
    }
  );
}

function checkReflection(): void {
  const state = readState();
  const countThreshold = state.reflectionTriggerThreshold ?? 8;
  const charThreshold = state.reflectionCharThreshold ?? 25000;
  const count = state.unprocessedObservationCount ?? 0;
  const chars = state.unprocessedObservationChars ?? 0;

  if (count >= countThreshold || chars >= charThreshold) {
    exec(
      `cd ${WORKSPACE} && bash ${REFLECT_SH}`,
      { timeout: 120000, env: { ...process.env, PATH: process.env.PATH + ":" + join(homedir(), ".local", "bin") } },
      (err, stdout) => {
        if (err) {
          console.error("[io-observer] reflect.sh error:", err.message);
          return;
        }
        console.error(`[io-observer] ${stdout.trim()}`);
      }
    );
  }
}

// --- Hook handler ---

export default function handler(event: Record<string, unknown>): void {
  try {
    const type = event.type as string | undefined;
    const action = event.action as string | undefined;
    const ctx = (event.context ?? {}) as Record<string, unknown>;

    let role: "user" | "assistant";
    let content: string;

    if (type === "message" && action === "preprocessed") {
      role = "user";
      content = ((ctx.bodyForAgent ?? ctx.body ?? ctx.content) as string) ?? "";
    } else if (type === "message" && action === "sent") {
      if (!ctx.success) return;
      role = "assistant";
      content = (ctx.content as string) ?? "";
    } else {
      return;
    }

    if (!content.trim()) return;
    // Apply noise filter here (shouldSkipMessage)

    buffer.push({ role, content, timestamp: Date.now() });

    if (shouldObserve()) {
      triggerObservation();
    }
  } catch (err) {
    console.error("[io-observer] Handler error:", err);
  }
}
```

## Cleanup After Deployment

1. **Disable cron:** the memory-observer cron, if you were running one
2. **Disable cron:** the message-indexer cron — already replaced by the `io-message-indexer` hook
3. **Update HEARTBEAT.md:** Remove reflection check section entirely
4. **Test:** Send several messages, verify observation fires after thresholds, verify reflection fires after observation count

## Key Design Decisions

- **Shell out to observe.sh/reflect.sh** rather than reimplementing in TypeScript — reuses prompt loading, state management, build-context.sh, Qdrant indexing, cross-linking. One place to update.
- **In-memory buffer** — simple, no persistence needed. On restart, buffer is empty and accumulates fresh. The 25-min gap check prevents rapid-fire observations.
- **Fire-and-forget** — observation/reflection run async, never block message processing.
- **observationInFlight guard** — prevents concurrent observations if messages arrive while observe.sh is running.

## Success Criteria

- [ ] Send 6+ messages → observation file appears in `memory/observations/`
- [ ] `observer-state.json` updated with new counts
- [ ] MEMORY.md live section updated via `build-context.sh`
- [ ] After 8+ observations, reflection auto-fires
- [ ] No message processing latency (fire-and-forget confirmed)
- [ ] Cron observer disabled, heartbeat reflection removed
