/**
 * core-guard.test.ts - the build guard must agree with the hook, at the boundary.
 *
 * WHY THIS EXISTS. scripts/core-guard.mjs and adapters/claude-code/hooks/
 * persona-inject.sh are two models of ONE quantity: the assembled size of
 * CORE.md + wrapper. They disagreed in two ways that cancelled:
 *
 *   guard: readFileSync (KEEPS the trailing newline)   flagged on bytes >  CAP
 *   hook:  CORE="$(cat)" (STRIPS trailing newlines)    drops CORE on  -lt CAP
 *
 * The guard therefore counted one byte MORE, and that +1 exactly cancelled the
 * `>` against the `-lt`. Every agent measured agreed - for a reason nobody
 * designed. Any CORE.md saved WITHOUT a trailing newline broke the
 * cancellation: at exactly CAP the hook dropped the entire CORE and the guard
 * stayed green. Silent, and in the check whose only job is to prevent it.
 *
 * 🔴 WHAT THIS FILE IS ACTUALLY PROTECTING is not the boundary, it is the
 * INSEPARABILITY of the two halves of the fix. Landing the readFileSync trimEnd
 * on its own - as harmless-looking cleanup - makes the bug LIVE for every agent
 * rather than only the no-trailing-newline ones, because the models then agree
 * and the `>` is exposed. Measured across the boundary: current 1 silent-drop
 * case, trimEnd-alone THREE, `>=`-alone 0, both 0 -- and those are SILENT
 * DROPS specifically, not total disagreements. Counting totals inverts the
 * ranking: `>=`-alone has MORE disagreements than the pre-fix state and is
 * strictly safer, because all of its are false alarms. Classify, do not count.
 *
 * No amount of care at review time catches that, because the dangerous change
 * looks like tidying. So this asserts the INVARIANT (guard verdict == hook
 * verdict) rather than any particular comparison operator, and it goes red on
 * every way of splitting the pair.
 *
 * It deliberately does NOT reimplement the arithmetic - it calls assembledBytes,
 * the same function the guard uses. A restatement of this arithmetic is easy to
 * get wrong, and a second wrong copy would only agree with itself.
 *
 * NOTE checkCores takes an OPTIONS OBJECT, not positional args. Calling it as
 * checkCores(agentsDir, home) silently falls back to the real ~/agents and
 * returns a plausible empty result, i.e. the test passes while measuring the
 * real agents directory instead of the fixture.
 *
 * ASCII only in this file, deliberately: it is quoted verbatim in failure
 * output and a stray multi-byte character muddies a byte-level diff.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkCores, assembledBytes, CORE_CAP } from "../scripts/core-guard.mjs";

const AGENT = "probe";

/** What persona-inject.sh does: $(cat) strips trailing newlines, emit if -lt CAP. */
function hookDropsCore(fileContent: string, home: string): boolean {
  const hookCore = fileContent.replace(/\n+$/, "");
  return !(assembledBytes(hookCore, AGENT, home) < CORE_CAP);
}

/** Build a home dir whose probe/CORE.md assembles to exactly `target` bytes. */
function makeHome(target: number, trailingNewline: boolean) {
  const home = mkdtempSync(join(tmpdir(), "core-guard-"));
  const agentsDir = join(home, "agents");
  mkdirSync(join(agentsDir, AGENT), { recursive: true });
  const wrapperOnly = assembledBytes("", AGENT, home);
  const body = "x".repeat(target - wrapperOnly);
  const content = trailingNewline ? body + "\n" : body;
  writeFileSync(join(agentsDir, AGENT, "CORE.md"), content);
  return { home, agentsDir, content };
}

describe("the build guard agrees with the hook at the cap boundary", () => {
  // Sweep both sides of CAP in both newline cases. The band is deliberately
  // wider than the defect so a one-byte drift in either direction is caught.
  for (const trailingNewline of [true, false]) {
    for (let target = CORE_CAP - 3; target <= CORE_CAP + 3; target++) {
      const label = trailingNewline ? "with trailing newline" : "no trailing newline";
      it(`assembled=${target} ${label}: guard verdict matches hook verdict`, () => {
        const { home, agentsDir, content } = makeHome(target, trailingNewline);
        try {
          const guardFlags = checkCores({ agentsDir, home }).some((v) => v.agent === AGENT);
          const hookDrops = hookDropsCore(content, home);
          // The invariant. If these ever diverge, a CORE is silently dropped
          // while the gate reports clean, which is the whole defect.
          expect(guardFlags).toBe(hookDrops);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }

  it("flags the exact-CAP case that used to pass silently", () => {
    // The specific instance: assembled lands exactly on CAP with no trailing
    // newline. Hook drops the entire CORE; the old guard called it clean.
    const { home, agentsDir, content } = makeHome(CORE_CAP, false);
    try {
      expect(hookDropsCore(content, home)).toBe(true);
      expect(checkCores({ agentsDir, home }).some((v) => v.agent === AGENT)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a comfortably-under CORE alone", () => {
    // Guard against an over-strict fix that flags everything: the failure mode
    // of a byte gate is not only false-green.
    const { home, agentsDir } = makeHome(CORE_CAP - 500, true);
    try {
      expect(checkCores({ agentsDir, home }).some((v) => v.agent === AGENT)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
