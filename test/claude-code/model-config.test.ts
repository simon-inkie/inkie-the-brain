import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  copyFileSync,
  readdirSync,
  cpSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The memory loop's model CLI and id come from configuration (_model.sh), not
 * from constants in observe.sh / reflect.sh / compress-era.sh. A stub CLI
 * records its argv, so each case proves exactly what the scripts invoked.
 */

const TOOLS_SRC = fileURLToPath(
  new URL("../../adapters/openclaw/hooks/memory-tools/", import.meta.url),
);
// Scripts run from a copy whose build-context.sh is a no-op: these tests are
// about which model CLI is called, and build-context.sh has its own suite
// (and needs flock and a newer bash than macOS ships).
let TOOLS: string;
const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));

let root: string;
let home: string;
let memory: string;
let bin: string;
let argvLog: string;

function stub(name: string): void {
  writeFileSync(
    join(bin, name),
    `#!/bin/bash\necho "$*" | tr '\\n' ' ' >> "${argvLog}"; echo >> "${argvLog}"\ncat > /dev/null\necho "<observations>stub result</observations>"\n`,
  );
  chmodSync(join(bin, name), 0o755);
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [join(TOOLS, script), ...args], {
    input: "user: hello\nassistant: hi\n",
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      MEMORY_DIR: memory,
      EMBED_DRY_RUN: "true",
      ...env,
    },
  });
}

function calls(): string[] {
  try {
    return readFileSync(argvLog, "utf-8").trim().split("\n");
  } catch {
    return [];
  }
}

beforeEach(() => {
  root = join(tmpdir(), `tb-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  home = join(root, "home");
  memory = join(root, "memory");
  bin = join(root, "bin");
  argvLog = join(root, "argv.log");
  mkdirSync(join(memory, "prompts"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  TOOLS = join(root, "tools");
  cpSync(TOOLS_SRC, TOOLS, { recursive: true });
  writeFileSync(join(TOOLS, "build-context.sh"), "#!/bin/bash\nexit 0\n");
  copyFileSync(join(TEMPLATES, "OBSERVATION-PROMPT.md"), join(memory, "OBSERVATION-PROMPT.md"));
  copyFileSync(join(TEMPLATES, "live-state.json"), join(memory, "live-state.json"));
  copyFileSync(join(TEMPLATES, "MEMORY.md"), join(root, "MEMORY.md"));
  for (const f of readdirSync(join(TEMPLATES, "prompts"))) {
    copyFileSync(join(TEMPLATES, "prompts", f), join(memory, "prompts", f));
  }
  stub("claude");
  stub("my-llm");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("observe.sh model configuration", () => {
  it("defaults to the claude CLI and the Haiku id, with no key set", () => {
    const r = run("observe.sh", []);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const [call] = calls();
    expect(call).toMatch(/^--print --strict-mcp-config --model claude-haiku-4-5-20251001 --system-prompt /);
  });

  it("honours BRAIN_MODEL_CLI and BRAIN_MODEL_ID from the environment", () => {
    const r = run("observe.sh", [], { BRAIN_MODEL_CLI: "my-llm", BRAIN_MODEL_ID: "small-1" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain("--model small-1");
  });

  it("reads the model from ~/.the-brain/.env when the environment is silent", () => {
    mkdirSync(join(home, ".the-brain"), { recursive: true });
    writeFileSync(
      join(home, ".the-brain", ".env"),
      'BRAIN_MODEL_CLI=my-llm\nBRAIN_MODEL_ID="from-file"\n',
    );
    const r = run("observe.sh", []);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls()[0]).toContain("--model from-file");
  });

  it("lets the environment beat the env file", () => {
    mkdirSync(join(home, ".the-brain"), { recursive: true });
    writeFileSync(join(home, ".the-brain", ".env"), "BRAIN_MODEL_ID=from-file\n");
    const r = run("observe.sh", [], { BRAIN_MODEL_ID: "from-env" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls()[0]).toContain("--model from-env");
    expect(calls()[0]).not.toContain("from-file");
  });

  it("passes no model flag when BRAIN_MODEL_ID is empty", () => {
    const r = run("observe.sh", [], { BRAIN_MODEL_ID: "" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls()[0]).not.toContain("--model");
  });

  it("uses BRAIN_MODEL_ARGS, BRAIN_MODEL_FLAG and BRAIN_MODEL_SYSTEM_FLAG for another CLI", () => {
    const r = run("observe.sh", [], {
      BRAIN_MODEL_CLI: "my-llm",
      BRAIN_MODEL_ARGS: "run --quiet",
      BRAIN_MODEL_FLAG: "-m",
      BRAIN_MODEL_SYSTEM_FLAG: "--sys",
      BRAIN_MODEL_ID: "tiny",
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls()[0]).toMatch(/^run --quiet -m tiny --sys /);
  });
});

describe("reflect.sh and compress-era.sh model configuration", () => {
  it("reflect.sh uses the configured CLI and keeps its ephemeral flag by default", () => {
    writeFileSync(join(memory, "observer-state.json"), '{"unprocessedObservationCount":1}');
    mkdirSync(join(memory, "observations"), { recursive: true });
    writeFileSync(join(memory, "observations", "2026-01-01-00-00-00.md"), "obs\n");
    const r = run("reflect.sh", [], { BRAIN_MODEL_CLI: "my-llm", BRAIN_MODEL_ID: "small-1" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls()[0]).toMatch(
      /^--print --no-session-persistence --strict-mcp-config --model small-1 --system-prompt /,
    );
  });

  it("compress-era.sh uses the configured CLI", () => {
    const refl = join(root, "reflection.md");
    writeFileSync(refl, "## reflection\n");
    const r = run("compress-era.sh", ["0", refl], {
      BRAIN_MODEL_CLI: "my-llm",
      BRAIN_MODEL_ID: "small-1",
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(calls().length).toBeGreaterThan(0);
    expect(calls()[0]).toContain("--model small-1");
  });
});
