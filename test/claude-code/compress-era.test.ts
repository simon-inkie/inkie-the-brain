import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/**
 * Integration tests for the byte-cap re-distill loop in compress-era.sh.
 *
 * Stubs the `claude` binary with a counter-based fake that emits configurable
 * output (short/long/error/empty) depending on the FAKE_CLAUDE_MODE env var.
 * Call count is tracked via a FAKE_CLAUDE_COUNTER file so each test can
 * assert exactly how many Haiku invocations occurred.
 */

const COMPRESS_ERA_SH = fileURLToPath(
  new URL(
    "../../adapters/openclaw/hooks/memory-tools/compress-era.sh",
    import.meta.url,
  ),
);

// Stub level-0 prompt content (minimal — compress-era.sh just reads it as a system prompt string)
const LEVEL_0_STUB = "You are compressing an era summary. Return ONLY the compressed summary.";

// Stub cap prompt (matches the {target} substitution pattern the script uses)
const CAP_PROMPT_STUB =
  "Shrink this summary to UNDER {target} bytes. Output ONLY the compressed markdown.";

// A short result the fake claude returns when in "short" or "long-then-short" mode (pass 2+)
const SHORT_RESULT = "# Era Summary\n\nShort era summary — well under cap.\n";

// A long result — 15 000 'x' chars, well over the default 12 000 byte cap
const LONG_RESULT = "x".repeat(15_000) + "\n";

let testDir: string;
let memoryDir: string;
let promptsDir: string;
let binDir: string;
let counterFile: string;
let reflectionFile: string;

/**
 * Build the fake `claude` bash script.
 *
 * Modes (FAKE_CLAUDE_MODE):
 *   short           — always returns SHORT_RESULT
 *   long            — always returns LONG_RESULT
 *   long-then-short — call 1 → LONG_RESULT, calls 2+ → SHORT_RESULT
 *   long-then-error — call 1 → LONG_RESULT, calls 2+ → exit 1
 *   long-then-empty — call 1 → LONG_RESULT, calls 2+ → exit 0 with no output
 *   always-long     — always returns LONG_RESULT (same as "long", explicit alias)
 *   error           — always exits 1
 *   empty           — always exits 0 with no output
 */
function buildFakeClaude(shortResult: string, longResult: string): string {
  // Write the result strings to temp files so the fake claude can cat them
  // (avoids shell quoting / escaping issues with arbitrary content).
  const shortFile = join(testDir, "fake-claude-short.txt");
  const longFile = join(testDir, "fake-claude-long.txt");
  writeFileSync(shortFile, shortResult);
  writeFileSync(longFile, longResult);

  return `#!/bin/bash
set -e
COUNTER_FILE="\${FAKE_CLAUDE_COUNTER:-/tmp/fake-claude-counter-$$}"
COUNT=\$(cat "\$COUNTER_FILE" 2>/dev/null || echo 0)
COUNT=\$((COUNT + 1))
echo "\$COUNT" > "\$COUNTER_FILE"

MODE="\${FAKE_CLAUDE_MODE:-short}"
SHORT_FILE="${shortFile}"
LONG_FILE="${longFile}"

case "\$MODE" in
  short)
    cat "\$SHORT_FILE"
    ;;
  long|always-long)
    cat "\$LONG_FILE"
    ;;
  long-then-short)
    if [ "\$COUNT" -le 1 ]; then
      cat "\$LONG_FILE"
    else
      cat "\$SHORT_FILE"
    fi
    ;;
  long-then-error)
    if [ "\$COUNT" -le 1 ]; then
      cat "\$LONG_FILE"
    else
      exit 1
    fi
    ;;
  long-then-empty)
    if [ "\$COUNT" -le 1 ]; then
      cat "\$LONG_FILE"
    else
      exit 0
    fi
    ;;
  error)
    exit 1
    ;;
  empty)
    exit 0
    ;;
  *)
    echo "Unknown FAKE_CLAUDE_MODE: \$MODE" >&2
    exit 1
    ;;
esac
`;
}

function readCounter(): number {
  if (!existsSync(counterFile)) return 0;
  return parseInt(readFileSync(counterFile, "utf-8").trim(), 10) || 0;
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `tb-compress-era-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  memoryDir = join(testDir, "memory");
  promptsDir = join(memoryDir, "prompts");
  binDir = join(testDir, "bin");
  counterFile = join(testDir, "claude-call-count");
  reflectionFile = join(testDir, "reflection-2026-06-19.md");

  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Stub level-0 prompt
  writeFileSync(join(promptsDir, "compress-era-level-0.md"), LEVEL_0_STUB);

  // Stub cap prompt
  writeFileSync(join(promptsDir, "compress-era-cap.md"), CAP_PROMPT_STUB);

  // A minimal reflection to compress
  writeFileSync(reflectionFile, "## Session reflection\n\nSome work happened.\n");

  // Fake claude binary
  const fakeClaude = buildFakeClaude(SHORT_RESULT, LONG_RESULT);
  writeFileSync(join(binDir, "claude"), fakeClaude);
  chmodSync(join(binDir, "claude"), 0o755);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Run compress-era.sh with the given env overrides.
 * PATH is prepended with binDir so the fake claude is found first.
 */
async function runCompressEra(
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [COMPRESS_ERA_SH, "0", reflectionFile],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          MEMORY_DIR: memoryDir,
          BRAIN_LOG_LEVEL: "error",
          FAKE_CLAUDE_COUNTER: counterFile,
          ...envOverrides,
        },
        timeout: 15_000,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

function eraContent(): string {
  const eraFile = join(memoryDir, "era-summary.md");
  return existsSync(eraFile) ? readFileSync(eraFile, "utf-8") : "";
}

// ---------------------------------------------------------------------------

describe("compress-era.sh — byte-cap re-distill loop", () => {
  it("no-op when fusion result is already under cap: exits 0, writes result, calls claude once", async () => {
    const { exitCode, stderr } = await runCompressEra({
      FAKE_CLAUDE_MODE: "short",
      ERA_SUMMARY_MAX_BYTES: "12000",
    });

    expect(exitCode).toBe(0);
    expect(readCounter()).toBe(1); // only the fusion call
    const era = eraContent();
    expect(era).toBeTruthy();
    expect(era).toContain("Short era summary");
    // Should NOT have entered the cap loop
    expect(stderr).not.toContain("re-distill");
  });

  it("re-distills over-cap candidate: calls claude twice, final result under cap", async () => {
    const { exitCode, stderr } = await runCompressEra({
      FAKE_CLAUDE_MODE: "long-then-short",
      ERA_SUMMARY_MAX_BYTES: "12000",
      ERA_SUMMARY_CAP_PASSES: "3",
    });

    expect(exitCode).toBe(0);
    // Call 1 = fusion, call 2 = cap pass 1
    expect(readCounter()).toBe(2);
    const era = eraContent();
    expect(era).toBeTruthy();
    expect(era.length).toBeLessThanOrEqual(12000);
    expect(era).toContain("Short era summary");
    expect(stderr).toContain("re-distill");
    expect(stderr).toContain("cap satisfied");
  });

  it("fail-open when always over cap: exits 0, writes best (over-cap) result, logs warn", async () => {
    const { exitCode, stderr } = await runCompressEra({
      FAKE_CLAUDE_MODE: "always-long",
      ERA_SUMMARY_MAX_BYTES: "12000",
      ERA_SUMMARY_CAP_PASSES: "2",
    });

    expect(exitCode).toBe(0);
    // 1 fusion + 2 cap passes = 3 total
    expect(readCounter()).toBe(3);
    const era = eraContent();
    expect(era).toBeTruthy();
    // Should accept the over-cap result rather than failing
    expect(era.length).toBeGreaterThan(12000);
    expect(stderr).toContain("accepting best result");
  });

  it("fail-open when cap pass errors: exits 0, keeps fusion result, logs warn", async () => {
    const { exitCode, stderr } = await runCompressEra({
      FAKE_CLAUDE_MODE: "long-then-error",
      ERA_SUMMARY_MAX_BYTES: "12000",
      ERA_SUMMARY_CAP_PASSES: "3",
    });

    expect(exitCode).toBe(0);
    // 1 fusion + 1 cap pass (which errors) = 2 total
    expect(readCounter()).toBe(2);
    const era = eraContent();
    expect(era).toBeTruthy();
    // Should have kept the over-cap fusion result
    expect(era.length).toBeGreaterThan(12000);
    expect(stderr).toContain("keeping best so far");
  });

  it("fail-open when cap pass returns empty: exits 0, keeps fusion result, logs warn", async () => {
    const { exitCode, stderr } = await runCompressEra({
      FAKE_CLAUDE_MODE: "long-then-empty",
      ERA_SUMMARY_MAX_BYTES: "12000",
      ERA_SUMMARY_CAP_PASSES: "3",
    });

    expect(exitCode).toBe(0);
    // 1 fusion + 1 cap pass (empty) = 2 total
    expect(readCounter()).toBe(2);
    const era = eraContent();
    expect(era).toBeTruthy();
    expect(era.length).toBeGreaterThan(12000);
    expect(stderr).toContain("keeping best so far");
  });

  it("never writes an empty era-summary.md: cap-pass-empty still leaves non-empty file", async () => {
    const { exitCode } = await runCompressEra({
      FAKE_CLAUDE_MODE: "long-then-empty",
      ERA_SUMMARY_MAX_BYTES: "12000",
      ERA_SUMMARY_CAP_PASSES: "3",
    });

    expect(exitCode).toBe(0);
    const era = eraContent();
    expect(era.length).toBeGreaterThan(0);
  });

  it("respects ERA_SUMMARY_MAX_BYTES knob: no cap loop when under a generous limit", async () => {
    // LONG_RESULT is ~15001 bytes; set cap to 20000 so it passes without a loop
    const { exitCode, stderr } = await runCompressEra({
      FAKE_CLAUDE_MODE: "long",
      ERA_SUMMARY_MAX_BYTES: "20000",
    });

    expect(exitCode).toBe(0);
    expect(readCounter()).toBe(1); // only the fusion call
    expect(stderr).not.toContain("re-distill");
  });

  it("respects ERA_SUMMARY_CAP_PASSES knob: stops after K passes", async () => {
    const { exitCode } = await runCompressEra({
      FAKE_CLAUDE_MODE: "always-long",
      ERA_SUMMARY_MAX_BYTES: "12000",
      ERA_SUMMARY_CAP_PASSES: "1",
    });

    expect(exitCode).toBe(0);
    // 1 fusion + 1 cap pass = 2 total
    expect(readCounter()).toBe(2);
    const era = eraContent();
    expect(era).toBeTruthy(); // fail-open: accepted despite over cap
  });
});
