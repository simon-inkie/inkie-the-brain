/**
 * poke-agy
 *
 * An EXTERNAL inbox watcher for agents running the agy (Antigravity) runtime.
 *
 * Why this exists: an agy agent cannot self-arm a Monitor (a Claude Code
 * harness primitive). So it only sees a new inbox DM on its next turn, and is
 * dormant between turns. This watcher inverts the pattern: it watches each agy
 * agent's silo inbox and tmux-wakes the agent on a genuine new DM, giving agy
 * agents the live-participant behaviour that Claude Code agents get from a
 * self-armed inbox Monitor.
 *
 * Scope note: this watches ONLY agents whose `.runtime` file reads "agy". It is
 * not a general tmux-wake for every agent regardless of runtime.
 *
 * Fail-isolation is the cardinal constraint: this runs inside the watcher
 * daemon that every agent depends on. It must NEVER crash or degrade the
 * indexer loop. Every path is wrapped; errors are logged, never thrown.
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { watch } from "chokidar";

// --- Tunables (env-overridable) ---

// Coalesce a burst of writes to one thread file into a single wake.
const DEBOUNCE_MS = Number(process.env.POKE_DEBOUNCE_MS) || 5000;

// After firing for an agent, suppress further wakes for this long so a chatty
// thread cannot hammer agy turns (each wake costs a full agy turn).
const COOLDOWN_MS = Number(process.env.POKE_COOLDOWN_MS) || 30000;

// Delay between the literal send-keys and the Enter keypress. Sending the text
// and the Enter as two separate calls, with a gap, avoids racing the TUI: a
// single combined send is accepted before the prompt has finished redrawing and
// the keystrokes are dropped.
const ENTER_DELAY_MS = 300;

const TMUX_SESSION = "agents";

// --- Discovery ---

interface AgyAgent {
  name: string;
  inboxDir: string; // ~/.the-brain/agents/<name>/inbox
}

/**
 * Scan ${AGENTS_HOME or ~/agents}/*\/ for a `.runtime` file whose trimmed
 * contents === "agy". Each match is an agy agent we should watch. Discovery is
 * by runtime marker only: no agent name is hardcoded anywhere in this module.
 */
function discoverAgyAgents(): AgyAgent[] {
  const agentsHome =
    process.env.AGENTS_HOME || join(homedir(), "agents");
  const out: AgyAgent[] = [];

  let entries: string[];
  try {
    entries = readdirSync(agentsHome);
  } catch {
    return out;
  }

  for (const name of entries) {
    try {
      const agentDir = join(agentsHome, name);
      if (!statSync(agentDir).isDirectory()) continue;

      const runtimeFile = join(agentDir, ".runtime");
      if (!existsSync(runtimeFile)) continue;

      const runtime = readFileSync(runtimeFile, "utf-8").trim();
      if (runtime !== "agy") continue;

      const inboxDir = join(
        homedir(),
        ".the-brain",
        "agents",
        name,
        "inbox",
      );
      out.push({ name, inboxDir });
    } catch {
      // Skip any agent dir that errors during probing.
      continue;
    }
  }

  return out;
}

/**
 * Is this path one of the inbox thread files we care about? Inbox threads are
 * flat `*.md` files. chokidar (v5 dropped glob support) is now pointed at the
 * inbox DIRECTORY, so it emits events for ANY entry inside it; this predicate is
 * the in-handler filter that keeps us to markdown thread files only.
 *
 * Exported so the regression is unit-testable without driving chokidar.
 */
export function isThreadFile(filePath: string): boolean {
  return filePath.endsWith(".md");
}

// --- Pure gate logic (unit-tested directly) ---

export interface WakeDecisionInput {
  prevSize: number;
  curSize: number;
  /**
   * The REAL author of the last message block, parsed from the file content
   * (the `from:` field of the last block). May be null when unparseable.
   * Note: this is NOT the thread file's basename — inbox thread files are named
   * after the correspondent, not the writer, so the filename is the wrong
   * signal for the self-sender guard.
   */
  author: string | null;
  agentName: string;
  lastWakeTs: number | undefined;
  now: number;
  cooldownMs: number;
}

export interface WakeDecision {
  wake: boolean;
  reason:
    | "ok"
    | "no-size-increase"
    | "unparseable-author"
    | "self-author"
    | "cooldown-active";
}

/**
 * The genuine-new-DM gate. All guards must hold to wake:
 *   1. Size increased (a sent->read receipt does not grow the file).
 *   2. Author is parseable (conservative: skip on ambiguity — a self-write
 *      must never slip through; a real DM still surfaces on the next turn).
 *   3. Author is not the watched agent itself (the genuine self-write guard).
 *   4. No wake fired for this agent within the cooldown window.
 */
export function shouldWake(input: WakeDecisionInput): WakeDecision {
  const { prevSize, curSize, author, agentName, lastWakeTs, now, cooldownMs } =
    input;

  if (curSize <= prevSize) {
    return { wake: false, reason: "no-size-increase" };
  }

  if (author === null) {
    return { wake: false, reason: "unparseable-author" };
  }

  // Lowercase agentName at the comparison point: `author` is already lowercased
  // by lastBlockAuthor, but agentName is a directory basename and may differ in
  // case (e.g. "Alice"). Without this, "alice" === "Alice" is false -> the self
  // guard is bypassed -> self-wake storm. Null check stays first (above).
  if (author === agentName.toLowerCase()) {
    return { wake: false, reason: "self-author" };
  }

  if (lastWakeTs !== undefined && now - lastWakeTs < cooldownMs) {
    return { wake: false, reason: "cooldown-active" };
  }

  return { wake: true, reason: "ok" };
}

/**
 * Extract the REAL author of the LAST message block from a thread file's text.
 *
 * Block headers look like:
 *   ## 2026-06-13T22:53:00Z - from: io - status: sent - subject: ...
 * Delimiters vary by dialect (hyphen or em-dash, spacing differs), but the
 * stable tokens are an ISO-ish timestamp and a `from:` field. Message blocks are
 * separated by a line of three-or-more dashes (`---`), the DM-format delimiter.
 *
 * The hardening this implements: a message BODY can contain a line that starts
 * with `## ... from: <name>` (agents paste the DM-protocol header format into
 * bodies when discussing the protocol — these very threads do). A naive "last
 * line starting with ## that carries a from:" scan would let such a body quote
 * override the real header, misidentifying the author in both directions
 * (spurious self-wake, or a missed real wake). To be robust:
 *   1. Split the tail into blocks on the `---` delimiter line.
 *   2. Take the LAST non-empty block (the newest message is at the file end).
 *   3. Within that block, take the FIRST line that is a STRUCTURAL header: starts
 *      with `##`, carries an ISO-ish timestamp (YYYY-MM-DDT...), and carries a
 *      `from:` token. The timestamp requirement rejects casual markdown headings
 *      like `## Notes from: somewhere` that lack the structural timestamp. Taking
 *      the FIRST structural header of the LAST block means a body quote appearing
 *      AFTER the real header (same block) cannot override it.
 *   4. No structural header in the final block -> return null (caller skips
 *      conservatively; a real DM still surfaces on the agent's next turn).
 *
 * Note: a `---`/`-----` horizontal rule INSIDE a message body could create a
 * spurious block boundary. That degrades to conservative-skip (null), which is
 * the safe direction, so it is acceptable.
 *
 * Pure function: takes the file text, returns the lowercased author or null.
 * The caller reads the file (or its tail) and passes the text in, so this is
 * unit-testable without touching the filesystem.
 */
export function lastBlockAuthor(fileText: string): string | null {
  // Match a structural header line: `##` + ISO-ish timestamp + a `from:` token.
  // The `from:` char class includes underscore for robustness (the naming
  // convention does not currently use underscores, but `my_agent` should not
  // truncate to `my`).
  const structuralHeaderRe =
    /^##.*\d{4}-\d{2}-\d{2}T.*from:\s*([a-z0-9_][a-z0-9_-]*)/i;

  // Split on a delimiter line of three-or-more dashes (the DM block delimiter).
  const blocks = fileText.split(/\n-{3,}\n/);

  // Walk from the END to the first non-empty block (the newest message).
  let lastBlock: string | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].trim().length > 0) {
      lastBlock = blocks[i];
      break;
    }
  }
  if (lastBlock === null) return null;

  // First structural header within that block wins (a body quote after the real
  // header cannot override it).
  for (const line of lastBlock.split("\n")) {
    const m = structuralHeaderRe.exec(line);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Read the last `maxBytes` of a file as UTF-8. Fail-isolated: on ANY read error
 * (missing file, permission, etc.) returns null so the caller treats the author
 * as unparseable and conservatively skips. Never throws into the daemon.
 *
 * The last block's `from:` always sits near the end of the thread file, so a
 * tail read avoids loading a large thread into memory on every change.
 */
function readTail(filePath: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(filePath).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

// Tail window for author parsing. The last block's `from:` is always near the
// file end; 16KB is generous headroom for a long final block. If the tail
// window begins mid-body and the last `##` header sits above it, parsing
// returns null and the caller conservatively skips (rare: only a final block
// whose body alone exceeds 16KB; it still surfaces on the agent's next turn).
const TAIL_BYTES = 16384;

// --- tmux helpers (fail-isolated) ---

// Hard cap on any tmux invocation. A hung/deadlocked tmux server would otherwise
// hang the call forever, leaking promise handlers + zombie procs onto the
// RESIDENT daemon until fd/memory exhaustion. On timeout, execFile kills the
// child and surfaces an error in the callback (err.code is "ETIMEDOUT", NOT
// "ENOENT"), so it maps to { ok: false, missing: false } -> the wake is skipped,
// never thrown. Only ENOENT (tmux not installed) maps to missing:true.
const TMUX_TIMEOUT_MS = 5000;

/** Promise wrapper around execFile that never rejects with a thrown error. */
function runTmux(
  args: string[],
): Promise<{ ok: boolean; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        // ENOENT === tmux binary not installed. A timeout kill surfaces as a
        // non-ENOENT error here, so it falls through to ok:false/missing:false.
        const missing =
          (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ ok: false, stdout: stdout || "", missing });
        return;
      }
      resolve({ ok: true, stdout: stdout || "", missing: false });
    });
  });
}

let tmuxMissingLogged = false;

/**
 * Check the target tmux window exists before waking. Returns false (skip) if
 * the session/window is absent (agent offline) or tmux is missing entirely.
 */
async function windowExists(
  name: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const res = await runTmux([
    "list-windows",
    "-t",
    TMUX_SESSION,
    "-F",
    "#W",
  ]);
  if (res.missing) {
    if (!tmuxMissingLogged) {
      log("poke-agy: tmux binary not found; wakes are no-ops");
      tmuxMissingLogged = true;
    }
    return false;
  }
  if (!res.ok) {
    // No `agents` session (agent not running). Silent skip.
    return false;
  }
  const windows = res.stdout.split("\n").map((w) => w.trim());
  return windows.includes(name);
}

/**
 * Two-step wake: literal text, then (after a short delay) Enter. Avoids racing
 * the TUI. Uses execFile (argv form) so there is no shell injection surface.
 */
export async function wakeAgent(
  name: string,
  author: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const present = await windowExists(name, log);
    if (!present) return; // offline / no tmux — skip silently

    const text = `[from:${author}] check your inbox, message from ${author}`;
    const sendText = await runTmux([
      "send-keys",
      "-t",
      `${TMUX_SESSION}:${name}`,
      "-l",
      text,
    ]);
    if (!sendText.ok) return;

    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));

    await runTmux(["send-keys", "-t", `${TMUX_SESSION}:${name}`, "Enter"]);

    log(`poke-agy: woke ${name} (from ${author})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`poke-agy: wake error for ${name}: ${msg}`);
  }
}

// --- Per-agent watcher wiring ---

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Seed the size map from the current state of an inbox dir at startup. */
function seedSizes(inboxDir: string, sizes: Map<string, number>): void {
  let entries: string[];
  try {
    entries = readdirSync(inboxDir);
  } catch {
    // Inbox dir may not exist yet — chokidar still watches the directory.
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = join(inboxDir, entry);
    sizes.set(full, fileSize(full));
  }
}

function watchAgent(agent: AgyAgent, log: (msg: string) => void): void {
  // Per-file last-seen byte size (size-increase guard).
  const sizes = new Map<string, number>();
  // Per-file debounce timers (coalesce a burst of writes to one thread).
  const debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  // Per-agent last-wake timestamp (cooldown guard).
  let lastWakeTs: number | undefined;

  seedSizes(agent.inboxDir, sizes);

  // Watch the inbox DIRECTORY (not a glob). chokidar v5 dropped glob support and
  // treats "<dir>/*.md" as a literal path that does not exist, so the watcher
  // would be inert. Watching the flat dir emits add/change/unlink for files
  // directly inside it; the .md filter lives in the handlers (isThreadFile).
  // ignoreInitial suppresses the startup adds; the seeded size map gives the
  // first real change a true baseline to compare.
  const watcher = watch(agent.inboxDir, {
    ignoreInitial: true,
    usePolling: true,
    interval: 3000,
    awaitWriteFinish: { stabilityThreshold: 500 },
  });

  const onChange = (filePath: string): void => {
    try {
      // The watch target is the inbox DIR, so events fire for any entry inside
      // it. We only care about flat *.md thread files; ignore everything else.
      if (!isThreadFile(filePath)) return;

      const prevSize = sizes.get(filePath) ?? 0;
      const curSize = fileSize(filePath);
      // Update the size map on EVERY change regardless of the decision.
      sizes.set(filePath, curSize);

      // Parse the REAL author from the file content (the last block's `from:`),
      // NOT the filename — inbox thread files are named after the correspondent,
      // not the writer, so the filename misidentifies the author. A watched
      // agent owns the physical file for ALL of its own threads, so its own
      // outbound writes would otherwise never self-skip.
      const tail = readTail(filePath, TAIL_BYTES);
      const author = tail === null ? null : lastBlockAuthor(tail);

      const decision = shouldWake({
        prevSize,
        curSize,
        author,
        agentName: agent.name,
        lastWakeTs,
        now: Date.now(),
        cooldownMs: COOLDOWN_MS,
      });

      if (!decision.wake) {
        // Conservative skip on ambiguity: an unparseable author must never wake
        // (the common self-write case must not slip through; a genuinely-missed
        // real DM still surfaces on the agent's next turn).
        if (decision.reason === "unparseable-author") {
          log(
            `poke-agy: skip ${agent.name} (${filePath}): author unparseable`,
          );
        }
        return; // quiet skip (size/self/cooldown/unparseable)
      }

      // `decision.wake === true` guarantees a parseable, non-self author.
      const wakeAuthor: string = author as string;

      // Debounce per-FILE: coalesce a burst of writes to this thread into one
      // wake. The cooldown stamp is set when the debounced wake actually fires.
      const existing = debounceTimers.get(filePath);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        filePath,
        setTimeout(() => {
          debounceTimers.delete(filePath);
          // Re-check cooldown at fire time (a sibling thread may have woken
          // the agent during the debounce window).
          if (
            lastWakeTs !== undefined &&
            Date.now() - lastWakeTs < COOLDOWN_MS
          ) {
            return;
          }
          lastWakeTs = Date.now();
          void wakeAgent(agent.name, wakeAuthor, log);
        }, DEBOUNCE_MS),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`poke-agy: change-handler error (${agent.name}): ${msg}`);
    }
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);

  // Drop the stale size on unlink. Otherwise a deleted/recreated/truncated inbox
  // file keeps its old (larger) size in the map, so the first new DM after the
  // recreate fails the size-gate and the wake is missed. map.delete never throws.
  watcher.on("unlink", (filePath: string) => {
    if (!isThreadFile(filePath)) return;
    sizes.delete(filePath);
  });

  watcher.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`poke-agy: watcher error (${agent.name}): ${msg}`);
  });
}

// --- Entry point ---

export function startPokeAgyWatcher(log: (msg: string) => void): void {
  try {
    const agents = discoverAgyAgents();

    if (agents.length === 0) {
      log("poke-agy: no agy-runtime agents found; not watching");
      return;
    }

    log(
      `poke-agy: watching ${agents.length} agy agent(s): ${agents
        .map((a) => a.name)
        .join(", ")}`,
    );

    for (const agent of agents) {
      watchAgent(agent, log);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`poke-agy: startup error: ${msg}`);
  }
}
