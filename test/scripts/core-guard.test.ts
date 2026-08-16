import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkCores, assembledBytes, CORE_CAP } from "../../scripts/core-guard.mjs";

/**
 * Build-time CORE guard. checkCores() scans <agentsDir>/<agent>/CORE.md
 * and flags any whose assembled (CORE + static wrapper) byte size exceeds the
 * cap. The hook fail-closes on a missing CORE, so missing is NOT a violation.
 */

let dir: string;
let agentsDir: string;
const HOME = "/home/test-user";

beforeEach(async () => {
  dir = join(
    tmpdir(),
    `tb-coreguard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeCore(agent: string, content: string): Promise<void> {
  const agentDir = join(agentsDir, agent);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "CORE.md"), content);
}

describe("core-guard checkCores", () => {
  it("passes when all CORE.md assemble under the cap", async () => {
    await writeCore("alpha", "small core\n");
    await writeCore("beta", "another small core\n");
    const violations = checkCores({ agentsDir, home: HOME });
    expect(violations).toEqual([]);
  });

  it("fails (reports the agent + size) when a CORE assembles over the cap", async () => {
    await writeCore("alpha", "small core\n");
    await writeCore("fatcore", "x".repeat(CORE_CAP + 1000));
    const violations = checkCores({ agentsDir, home: HOME });
    expect(violations).toHaveLength(1);
    expect(violations[0].agent).toBe("fatcore");
    expect(violations[0].bytes).toBeGreaterThan(CORE_CAP);
  });

  it("treats a missing CORE.md as a non-failure (skipped, not flagged)", async () => {
    // agent dir exists but no CORE.md
    await mkdir(join(agentsDir, "noCore"), { recursive: true });
    await writeCore("alpha", "small core\n");
    const violations = checkCores({ agentsDir, home: HOME });
    expect(violations).toEqual([]);
  });

  it("returns empty when the agents dir does not exist", () => {
    const violations = checkCores({ agentsDir: join(dir, "nope"), home: HOME });
    expect(violations).toEqual([]);
  });

  it("assembledBytes accounts for CORE + wrapper (wrapper adds overhead)", () => {
    const core = "hello core\n";
    const bytes = assembledBytes(core, "alpha", HOME);
    // Strictly larger than the bare CORE (wrapper + separators appended).
    expect(bytes).toBeGreaterThan(Buffer.byteLength(core, "utf8"));
  });
});
