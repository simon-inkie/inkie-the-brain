/**
 * the-brain — structured JSONL logging.
 *
 * One shared log at ~/.the-brain/logs/hook-activity.jsonl. Append-only.
 * Every component (TS handlers + bash scripts via env-propagated traceId)
 * writes here so a single `grep <traceId>` shows the full chain of a
 * hook fire. Failures swallowed — logging never blocks the agent.
 *
 * See LOGGING-SPEC.md for entry shape, levels, and what to log.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function minLevel(): Level {
  const raw = process.env.BRAIN_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

interface LogExtras {
  cwd?: string;
  sessionId?: string;
  memoryDir?: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export function log(
  level: Level,
  component: string,
  event: string,
  extras: LogExtras = {},
  traceId?: string,
): void {
  if (ORDER[level] < ORDER[minLevel()]) return;
  try {
    const logDir = join(homedir(), ".the-brain", "logs");
    mkdirSync(logDir, { recursive: true });
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      traceId: traceId ?? process.env.BRAIN_TRACE_ID ?? `none:${Date.now()}`,
      component,
      event,
    };
    // Carry persona identity on every trace line so a session-wide
    // `grep '"agentName":"brain-surgeon"' hook-activity.jsonl` filters to
    // just that persona's activity across all components.
    const agentName = process.env.AGENT_NAME?.trim();
    if (agentName) entry.agentName = agentName;
    if (extras.cwd) entry.cwd = extras.cwd;
    if (extras.sessionId) entry.sessionId = extras.sessionId;
    if (extras.memoryDir) entry.memoryDir = extras.memoryDir;
    if (extras.msg) entry.msg = extras.msg;
    if (extras.data) entry.data = extras.data;
    appendFileSync(
      join(logDir, "hook-activity.jsonl"),
      JSON.stringify(entry) + "\n",
    );
  } catch {
    /* swallow */
  }
}

export function makeTraceId(sessionId?: string): string {
  return `${sessionId ?? "anon"}:${Date.now()}`;
}
