# Logging & tracing spec

Make the-brain's runtime observable. Today most components fail silently (the `CLAUDE_PLUGIN_ROOT` non-export bug cost ~half a day to find — it would have been seconds with logging). This spec defines a single shared log everything writes to, a minimal helper in both bash and TS, and conventions for what to record.

## 1. Goals

1. **Diagnose silent failures fast.** Any unexpected hook return — "no observation written", "memory_root resolved wrong", "claude --print errored" — should leave a trace.
2. **Cross-component correlation.** A single hook fire spans `on-stop.sh` (wrapper) → `on-stop.js` (handler) → `observe-trigger.ts` → `observe.sh` (bash) → optionally `reflect.sh` (bash). All five should share a `traceId` so I can `grep <traceId>` and see the chain.
3. **Cheap by default.** Logging must never block the agent and must add <5ms per hook. Errors in logging are swallowed.
4. **Off-switchable.** A `BRAIN_LOG_LEVEL` env knob. Default = `info`; can be set to `warn` once stable to drop noise.

## 2. Out of scope

- Log shipping / rotation (revisit if file grows past 100MB)
- Structured tracing tools (OTel, etc.) — JSONL is plenty for a single-machine personal agent
- Per-agent log directories — one shared file is easier to grep and correlate
- The MCP server (`io-memory`) — separate concern, separate spec

## 3. Storage

**Single file:** `~/.the-brain/logs/hook-activity.jsonl`

JSON-lines format. One line per event. Append-only. Already exists today — `observe-trigger.ts` writes to it. We extend it, no rename.

**Rotation:** none for now. If file passes ~100MB (months of activity), revisit with `logrotate` or in-process rotation. Daily files (`hook-activity-YYYY-MM-DD.jsonl`) is the obvious next step.

## 4. Entry shape

Every line is a JSON object with these fields. Optional fields are omitted when N/A.

| Field | Required | Type | Notes |
|---|---|---|---|
| `ts` | ✅ | ISO 8601 string | Wall-clock UTC, ms precision |
| `level` | ✅ | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | Default `info` |
| `traceId` | ✅ | string | `<sessionId>:<hookFireTs>` — same for the whole chain. If no sessionId available, use `none:<ts>`. |
| `component` | ✅ | string | `"observe-trigger"`, `"observe.sh"`, `"reflect.sh"`, `"build-context.sh"`, `"compress-era.sh"`, `"user-prompt-submit"`, `"memory-root"` |
| `event` | ✅ | string | Short verb-phrase: `"hook-fired"`, `"observation-written"`, `"threshold-crossed"`, `"jq-bootstrap"`, `"claude-call-failed"`, `"resolved-memory-root"`, etc. |
| `msg` | optional | string | Human-readable one-liner |
| `cwd` | optional | string | Project dir at time of log |
| `sessionId` | optional | string | CC session UUID |
| `memoryDir` | optional | string | Resolved memory dir for context |
| `data` | optional | object | Free-form structured payload (counts, paths, decisions) |

Example:
```json
{"ts":"2026-04-20T16:55:22.468Z","level":"info","traceId":"573568c1:1745175322468","component":"observe-trigger","event":"hook-fired","cwd":"/home/<user>/<your-project>","sessionId":"573568c1-d4f4-43fc-9e00-f82967509b28","data":{"force":true,"label":"precompact","fired":false,"reason":"observe.sh not found at ..."}}
```

## 5. Log levels — when to use which

- **debug** — verbose state info useful only when diagnosing. Default off via env.
- **info** — every successful state transition: hook fired, observation written, reflection triggered, era compressed, memory-root resolved. Default on.
- **warn** — recoverable anomaly: tier-5 fallback hit (suggests missing pointer), threshold not crossed (often expected, but logged if surprising), claude --print returned empty.
- **error** — anything that prevents the operation completing: spawn failed, file not found, json parse fail. Triggers a non-fail-open path internally where possible.

`BRAIN_LOG_LEVEL=warn` means warn + error written, info + debug dropped.

## 6. The bash helper

Add `adapters/openclaw/hooks/memory-tools/_log.sh`. Sourced by every script:

```bash
# _log.sh — append a JSONL entry to the-brain's hook log.
# Usage: log info "observation-written" '{"path":"...","chars":1234}'
log() {
  local level="$1"; shift
  local event="$1"; shift
  local data="${1:-{}}"
  local cur="${BRAIN_LOG_LEVEL:-info}"
  case "$cur:$level" in
    error:*|warn:warn|warn:error|info:info|info:warn|info:error|debug:*) ;;
    *) return 0 ;;
  esac
  local logdir="${HOME}/.the-brain/logs"
  mkdir -p "$logdir" 2>/dev/null
  local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
  local trace="${BRAIN_TRACE_ID:-none:$(date +%s%3N)}"
  local component="${BRAIN_COMPONENT:-${BASH_SOURCE[1]##*/}}"
  printf '{"ts":"%s","level":"%s","traceId":"%s","component":"%s","event":"%s","data":%s}\n' \
    "$ts" "$level" "$trace" "$component" "$event" "$data" \
    >> "$logdir/hook-activity.jsonl" 2>/dev/null || true
}
```

`BRAIN_TRACE_ID` is set by the TS handler when it spawns observe.sh, propagating the trace through the chain.

## 7. The TS helper

Existing `logHookActivity()` in `observe-trigger.ts` is the model. Generalise to `core/log.ts`:

```ts
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel: Level = (process.env.BRAIN_LOG_LEVEL as Level) ?? "info";

export function log(
  level: Level,
  component: string,
  event: string,
  data: Record<string, unknown> = {},
  traceId?: string,
): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  try {
    const logDir = join(homedir(), ".the-brain", "logs");
    mkdirSync(logDir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      level,
      traceId: traceId ?? `none:${Date.now()}`,
      component,
      event,
      ...data,
    };
    appendFileSync(join(logDir, "hook-activity.jsonl"), JSON.stringify(entry) + "\n");
  } catch { /* swallow */ }
}
```

## 8. What to log (per component)

Concrete events to emit. New code, not retrofits — minimum useful coverage.

### `user-prompt-submit.ts`
- `info hook-fired {memoryDir, blockChars, sessionId}`
- `warn empty-block {memoryDir, reason}` if MEMORY.md missing/empty
- `error read-failed {memoryDir, err}` on file read fail

### `memory-root.ts`
- `info resolved {projectDir, memoryDir, tier}` on every resolve

### `observe-trigger.ts`
- (already partially logged — convert to new helper)
- `info hook-fired {force, label, fired, reason, cwd, sessionId, transcriptPath}` (existing entry, reformatted)
- `info spawn-observe {tmpFile, observeSh, memoryDir}`
- `error tools-dir-missing {candidates}` when resolveToolsDir falls through
- `error spawn-failed {err}`

### `observe.sh`
- `info enter {force,$1,$2}`
- `info bootstrap-state` (when state file initialised from `{}`)
- `info chunk-received {chars,messages}`
- `info claude-call-start {model}`
- `info claude-call-ok {chars}`
- `error claude-call-failed {exit, stderr-tail}`
- `info observation-written {path,chars}`
- `info threshold-cross {count, threshold, autoreflect}` if AUTO_REFLECT chains
- `info exit {status}`

### `reflect.sh`
- `info enter`
- `info observations-collated {count,chars}`
- `info reflection-written {path,chars}`
- `info state-reset`
- `info exit {status}`
- `error claude-call-failed {exit, stderr-tail}`

### `build-context.sh`
- `info enter {memoryDir}`
- `info block-rebuilt {chars, era, hot, elders, unprocessed}`
- `info exit {status}`
- `warn era-summary-missing` if no era-summary.md

### `compress-era.sh`
- `info enter {currentLevel}`
- `info compressed {newLevel, oldChars, newChars}`
- `info exit {status}`

## 9. Trace propagation

The trace starts in the hook handler (TS) and propagates to the bash subprocess via env:

```ts
// in observe-trigger.ts when spawning observe.sh
const traceId = `${input.session_id}:${Date.now()}`;
const child = spawn("bash", [observeSh, ...], {
  env: {
    ...process.env,
    MEMORY_DIR: memoryDir,
    AUTO_REFLECT: "1",
    BRAIN_TRACE_ID: traceId,
    BRAIN_COMPONENT: "observe.sh",
  },
  ...
});
```

When `observe.sh` chains into `reflect.sh` via `exec`, it sets `BRAIN_COMPONENT=reflect.sh` and forwards the same trace.

## 10. Verification

After implementation, confirm with one real session:

```bash
# 1. Tail the log in another terminal
tail -f ~/.the-brain/logs/hook-activity.jsonl | jq .

# 2. Open a CC session in ~/inkie-io, send 1 prompt, end the turn
# 3. Confirm the log shows: user-prompt-submit hook-fired, memory-root resolved,
#    on-stop fired, observe-trigger hook-fired, observe.sh enter+exit, etc.,
#    all sharing the same traceId.
```

Pass condition: every step of the chain emits at least one entry, all sharing the same `traceId`.

## 11. Rollout

1. Land the helpers (`_log.sh`, `core/log.ts`).
2. Convert existing `logHookActivity` in `observe-trigger.ts` to the new helper. Verify behaviour unchanged.
3. Add log calls to each component listed in §8. One commit per component is fine.
4. Run §10 verification.
5. Document the env knobs (`BRAIN_LOG_LEVEL`, `BRAIN_TRACE_ID`) in `AGENT-GUIDE.md` Troubleshooting section.

## 12. Out-of-band failure modes (logging-of-logging)

If log writes themselves fail (disk full, permission denied), the helpers swallow the error. Failures here are not catastrophic — the system continues to fail-open on the underlying operation. Acceptable.
