#!/usr/bin/env node
/**
 * replay-transcript.ts — Rebuild observations from a Claude Code transcript JSONL
 *
 * Walks a transcript end-to-end in message-bounded chunks, feeding each
 * chunk through observe.sh to generate a fresh observation file in the
 * target memory dir. Used to backfill history when a session's memory
 * was missing or misrouted — e.g. before the memory-root resolver fix
 * moved CC sessions out of the shared OpenClaw workspace.
 *
 * Skips noise (empty messages, tool_result meta-noise) via the observer
 * core's own filter so the observations are coherent, not raw dumps.
 *
 * Usage:
 *   npx tsx scripts/replay-transcript.ts \
 *     --transcript ~/.claude/projects/-home-simon-xxx/abc.jsonl \
 *     --memory ~/.the-brain/agents/foo/memory \
 *     [--chunk-messages 40] [--chunk-chars 80000] [--dry-run]
 *
 * Does NOT set AUTO_REFLECT — a single reflect.sh pass at the end
 * collapses the full backfill into one dense reflection.
 */
import { writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  readTranscriptFromOffset,
  type TranscriptMessage,
} from "../core/observer/index.js";

interface Args {
  transcript: string;
  memory: string;
  chunkMessages: number;
  chunkChars: number;
  dryRun: boolean;
  fromOffset: number;
}

function parseArgs(): Args {
  const out: Partial<Args> = {
    chunkMessages: 40,
    chunkChars: 80000,
    dryRun: false,
    fromOffset: 0,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transcript") out.transcript = argv[++i];
    else if (a === "--memory") out.memory = argv[++i];
    else if (a === "--chunk-messages") out.chunkMessages = Number(argv[++i]);
    else if (a === "--chunk-chars") out.chunkChars = Number(argv[++i]);
    else if (a === "--from-offset") out.fromOffset = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printUsage();
      process.exit(1);
    }
  }
  if (!out.transcript || !out.memory) {
    printUsage();
    process.exit(1);
  }
  return out as Args;
}

function printUsage(): void {
  console.error(
    "Usage: replay-transcript --transcript <path> --memory <dir> [--chunk-messages N] [--chunk-chars N] [--from-offset N] [--dry-run]",
  );
}

function formatTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => {
      const t = m.timestamp.slice(11, 16);
      const speaker = m.role === "user" ? "User" : "Assistant";
      return `[${t}] ${speaker}: ${m.content}`;
    })
    .join("\n\n");
}

function chunk<T>(
  items: T[],
  chunkLen: number,
  sizeOf: (t: T) => number,
  charBudget: number,
): T[][] {
  const out: T[][] = [];
  let buf: T[] = [];
  let bufChars = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (buf.length >= chunkLen || bufChars + size > charBudget) {
      if (buf.length) out.push(buf);
      buf = [];
      bufChars = 0;
    }
    buf.push(item);
    bufChars += size;
  }
  if (buf.length) out.push(buf);
  return out;
}

function main(): void {
  const args = parseArgs();
  const transcript = resolve(args.transcript);
  const memoryDir = resolve(args.memory);

  const { messages, newOffset } = readTranscriptFromOffset(transcript, args.fromOffset);
  if (messages.length === 0) {
    console.error(
      `[replay] no substantive messages in ${transcript} from offset ${args.fromOffset}`,
    );
    process.exit(0);
  }
  if (args.fromOffset > 0) {
    console.log(
      `[replay] starting from offset ${args.fromOffset} (will end at ${newOffset})`,
    );
  }

  const chunks = chunk<TranscriptMessage>(
    messages,
    args.chunkMessages,
    (m) => m.content.length,
    args.chunkChars,
  );

  const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
  console.log(
    `[replay] ${messages.length} messages, ${totalChars} chars → ${chunks.length} chunks`,
  );
  console.log(`[replay] target memory dir: ${memoryDir}`);

  if (args.dryRun) {
    console.log(`[replay] dry-run — would fire ${chunks.length} observations`);
    chunks.forEach((c, i) => {
      const cChars = c.reduce((s, m) => s + m.content.length, 0);
      console.log(
        `  chunk ${i + 1}: ${c.length} msgs, ${cChars} chars, first ts ${c[0].timestamp}, last ts ${c[c.length - 1].timestamp}`,
      );
    });
    return;
  }

  const here = fileURLToPath(import.meta.url);
  const observeSh = resolve(
    dirname(here),
    "..",
    "adapters",
    "openclaw",
    "hooks",
    "memory-tools",
    "observe.sh",
  );

  let ok = 0;
  let fail = 0;
  const started = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const tmpFile = `/tmp/tb-replay-${started}-${i}.txt`;
    writeFileSync(tmpFile, formatTranscript(c));
    const cChars = c.reduce((s, m) => s + m.content.length, 0);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `[replay] ${i + 1}/${chunks.length} — ${c.length} msgs, ${cChars} chars (t=${elapsed}s)`,
    );
    const r = spawnSync("bash", [observeSh, "--file", tmpFile], {
      env: { ...process.env, MEMORY_DIR: memoryDir },
      stdio: "inherit",
    });
    if (r.status === 0) ok++;
    else {
      fail++;
      console.error(
        `[replay] chunk ${i + 1} failed (exit=${r.status}); continuing`,
      );
    }
  }
  const totalSec = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `[replay] done in ${totalSec}s: ${ok} ok / ${fail} failed / ${chunks.length} total`,
  );
}

main();
