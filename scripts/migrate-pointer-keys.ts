#!/usr/bin/env node
/**
 * migrate-pointer-keys.ts — Consolidate fragmented observer pointers
 *
 * Bug: sessionKeyFor used to include projectDir (cwd at hook-fire time), so
 * agents that cd'd between worktrees within a single session ended up with
 * multiple pointer files for the SAME conversation, each tracking only
 * the observations fired while that cwd was active.
 *
 * This script walks each agent's observer-pointers/ dir, groups pointers
 * by (sessionId, transcriptPath), keeps the one with the highest
 * lastObservedOffset, rewrites it under the new canonical sessionKey
 * (`cc:<sessionId>`), and deletes the orphans.
 *
 * Usage:
 *   tsx scripts/migrate-pointer-keys.ts [--dry-run] [--agent <name>]
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface Pointer {
  sessionKey: string;
  sessionId: string;
  transcriptPath: string;
  lastObservedOffset: number;
  lastObservedTimestamp: string | null;
  messagesSinceLastObservation: number;
  charsSinceLastObservation: number;
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const agentIdx = argv.indexOf("--agent");
const onlyAgent = agentIdx !== -1 ? argv[agentIdx + 1] : null;

const agentsRoot = join(homedir(), ".the-brain", "agents");
const agents = readdirSync(agentsRoot).filter((a) => {
  if (onlyAgent && a !== onlyAgent) return false;
  try {
    return statSync(join(agentsRoot, a, "memory", "observer-pointers")).isDirectory();
  } catch {
    return false;
  }
});

let totalKept = 0;
let totalDeleted = 0;
let totalRenamed = 0;

for (const agent of agents) {
  const dir = join(agentsRoot, agent, "memory", "observer-pointers");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) continue;

  const groups = new Map<string, { file: string; ptr: Pointer }[]>();
  for (const f of files) {
    let ptr: Pointer;
    try {
      ptr = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    } catch {
      console.error(`[migrate] ${agent}: corrupt pointer ${f} — skipping`);
      continue;
    }
    if (!ptr.sessionId) continue;
    const groupKey = `${ptr.sessionId}|${ptr.transcriptPath}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push({ file: f, ptr });
  }

  let kept = 0,
    deleted = 0,
    renamed = 0;

  for (const [, entries] of groups) {
    entries.sort((a, b) => b.ptr.lastObservedOffset - a.ptr.lastObservedOffset);
    const winner = entries[0];
    const losers = entries.slice(1);
    const canonicalKey = `cc:${winner.ptr.sessionId}`;
    const canonicalFile = `${canonicalKey.replace(/[/:]/g, "-")}.json`;

    if (winner.file === canonicalFile && losers.length === 0) {
      kept++;
      continue;
    }

    if (winner.file !== canonicalFile) {
      const newPtr: Pointer = { ...winner.ptr, sessionKey: canonicalKey };
      const newPath = join(dir, canonicalFile);
      const oldPath = join(dir, winner.file);
      console.log(
        `[migrate] ${agent}: rename ${winner.file} → ${canonicalFile} (offset ${winner.ptr.lastObservedOffset})`,
      );
      if (!dryRun) {
        writeFileSync(newPath, JSON.stringify(newPtr, null, 2));
        if (oldPath !== newPath) unlinkSync(oldPath);
      }
      renamed++;
    }

    for (const loser of losers) {
      console.log(
        `[migrate] ${agent}: delete ${loser.file} (orphan, offset ${loser.ptr.lastObservedOffset})`,
      );
      if (!dryRun) unlinkSync(join(dir, loser.file));
      deleted++;
    }
    kept++;
  }

  console.log(`[migrate] ${agent}: ${kept} sessions kept, ${renamed} renamed, ${deleted} orphans removed`);
  totalKept += kept;
  totalDeleted += deleted;
  totalRenamed += renamed;
}

console.log(
  `\n[migrate] ${dryRun ? "DRY-RUN: " : ""}total: ${totalKept} sessions, ${totalRenamed} renamed, ${totalDeleted} orphans removed`,
);
