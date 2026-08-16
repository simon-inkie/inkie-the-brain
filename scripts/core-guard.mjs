#!/usr/bin/env node
/**
 * Build-time CORE guard.
 *
 * The SessionStart hook adapters/claude-code/hooks/persona-inject.sh injects
 * each agent's distilled CORE (~/agents/<name>/CORE.md) inline, plus a static
 * first-action read wrapper. Claude Code truncates any hook output over 10,000
 * chars, so a CORE that grows too fat would silently get cut and the agent
 * would start the session without its persona. This guard recomputes the SAME
 * assembled size the hook emits (CORE +
 * the static wrapper for that agent) and FAILS the build if any exceeds the
 * cap, before a fat CORE can ever reach a live session.
 *
 * Measure: BYTES (Buffer.byteLength utf8), identical to the hook's `wc -c`.
 * Bytes >= chars, so a sub-9,500-byte block is safely under the 10,000-char
 * cap. Keep buildWrapper() byte-for-byte in sync with build_wrapper() in
 * persona-inject.sh.
 *
 * Missing CORE.md is NOT a failure: agents are rolled out incrementally and the
 * hook fail-closes to a wrapper-alone read-trigger at runtime for any agent
 * without a CORE yet.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const CORE_CAP = 9500;

/**
 * The static first-action read wrapper for an agent, identical to
 * build_wrapper() in persona-inject.sh. Paths are absolute under `home`.
 */
export function buildWrapper(agentName, home = homedir()) {
  const sharedDir = join(home, "agents");
  const agentDir = join(sharedDir, agentName);
  return [
    "\u{1F534} FIRST ACTION THIS SESSION, before you respond to anything: Read these full persona files now (your CORE is your floor; these are your depth):",
    join(sharedDir, "SYSTEM.md"),
    join(sharedDir, "ROSTER.md"),
    join(agentDir, "SOUL.md"),
    join(agentDir, "IDENTITY.md"),
    join(agentDir, "TOOLS.md"),
    join(agentDir, "USER.md"),
    "Do not skip this. Your CORE is a distilled summary; the full files carry the detail you operate on.",
  ].join("\n");
}

/** Assembled byte size the hook emits for CORE-present agents: CORE + wrapper. */
export function assembledBytes(coreContent, agentName, home = homedir()) {
  const assembled = coreContent + "\n\n" + buildWrapper(agentName, home);
  return Buffer.byteLength(assembled, "utf8");
}

/**
 * Scan `agentsDir` for <agent>/CORE.md and return the agents whose assembled
 * CORE+wrapper exceeds CORE_CAP. Missing CORE.md is skipped (not a violation).
 *
 * @param {{agentsDir?: string, home?: string}} [opts]
 *   agentsDir defaults to ~/agents; home (used to build the wrapper's absolute
 *   paths, matching runtime) defaults to the real home.
 * @returns {{agent: string, bytes: number}[]}
 */
export function checkCores(opts = {}) {
  const home = opts.home ?? homedir();
  const agentsDir = opts.agentsDir ?? join(home, "agents");
  const violations = [];

  let entries;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return violations; // no agents dir -> nothing to check
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const coreFile = join(agentsDir, ent.name, "CORE.md");
    if (!existsSync(coreFile)) continue; // missing CORE is not a failure
    // Read EXACTLY as the hook does. persona-inject.sh uses CORE="$(cat ...)",
    // and command substitution strips trailing newlines; readFileSync keeps them.
    // Those two models differed by one byte, and that difference happened to
    // cancel the >-vs--lt mismatch below, so this gate was green by accident
    // rather than by design.
    const core = readFileSync(coreFile, "utf8").replace(/\n+$/, "");
    const bytes = assembledBytes(core, ent.name, home);
    // >=, not >. The hook emits the CORE only when assembled `-lt CAP`, so at
    // EXACTLY CAP it drops the whole CORE. A `>` here calls that case clean.
    //
    // 🔴 THESE TWO CHANGES ARE A PAIR AND MUST NOT BE SPLIT. Landing the
    // readFileSync trimEnd on its own, as tidy-up, makes the bug LIVE for every
    // agent instead of only those whose CORE.md lacks a trailing newline: the
    // two models then agree and the `>` is exposed. The dangerous edit is the
    // one that looks like cleanup. The boundary sweep in test/core-guard.test.ts
    // is what stops it being split.
    //
    // Measured, not reasoned, across the boundary and with the metric NAMED --
    // a first sweep that sampled trailing-newline counts {0,1} and missed {2}
    // reported the trimEnd-alone row as 2 rather than 3, and three different
    // metrics quoted loosely manufactured a disagreement that did not exist:
    //
    //   split                       total  SILENT-DROP  false-alarm
    //   readFileSync, >  (pre-fix)      2            1            1
    //   trimEnd, >       (cleanup)      3            3            0
    //   readFileSync, >= (op only)      3            0            3
    //   both, >=         (merged)       0            0            0
    //
    // 🔴 COUNT NOTHING, CLASSIFY. On raw totals the op-only split scores 3
    // against the pre-fix 2 and looks WORSE, while actually eliminating the only
    // case that can hurt: all three of its disagreements are the guard flagging
    // while the hook keeps the CORE. Assert ZERO SILENT DROPS, never an expected
    // total. A false alarm costs a build; a silent drop costs an agent its
    // persona with nothing to see.
    if (bytes >= CORE_CAP) violations.push({ agent: ent.name, bytes });
  }

  return violations;
}
