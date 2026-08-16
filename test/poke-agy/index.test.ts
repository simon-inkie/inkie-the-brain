import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  shouldWake,
  lastBlockAuthor,
  isThreadFile,
} from "../../core/poke-agy/index.js";

/**
 * Unit tests for the poke-agy genuine-new-DM gate.
 *
 * The pure decision logic (`shouldWake`) and the author parser
 * (`lastBlockAuthor`) are tested directly — cleaner than driving chokidar. A
 * separate test mocks `child_process` to assert the tmux wake actually spawns
 * the expected send-keys argv when all guards pass, and that NO real tmux call
 * ever happens.
 */

const COOLDOWN_MS = 30000;

describe("isThreadFile — markdown filter for the dir watcher", () => {
  // The watcher now targets the inbox DIRECTORY (chokidar v5 dropped glob
  // support, so a "<dir>/*.md" path is treated as a literal non-existent path
  // and the watcher is inert). chokidar emits events for ANY entry in the dir;
  // this predicate is the in-handler filter that keeps us to *.md threads.
  it("accepts a markdown thread file", () => {
    expect(isThreadFile("/home/test-user/.the-brain/agents/alice/inbox/bob.md")).toBe(
      true,
    );
  });

  it("rejects a non-markdown path (the dir-watcher regression)", () => {
    expect(isThreadFile("/home/test-user/.the-brain/agents/alice/inbox/.DS_Store")).toBe(
      false,
    );
    expect(isThreadFile("/home/test-user/.the-brain/agents/alice/inbox/notes.txt")).toBe(
      false,
    );
    expect(isThreadFile("/home/test-user/.the-brain/agents/alice/inbox")).toBe(false);
  });
});

describe("shouldWake — size-increase guard", () => {
  it("wakes when the file grew (new message block appended)", () => {
    const d = shouldWake({
      prevSize: 100,
      curSize: 250,
      author: "bob",
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(true);
    expect(d.reason).toBe("ok");
  });

  it("skips when the size is unchanged (sent->read receipt writeback)", () => {
    const d = shouldWake({
      prevSize: 250,
      curSize: 250,
      author: "bob",
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("no-size-increase");
  });

  it("skips when the size decreased", () => {
    const d = shouldWake({
      prevSize: 250,
      curSize: 100,
      author: "bob",
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("no-size-increase");
  });
});

describe("shouldWake — self-author guard", () => {
  it("skips when the author is the agent itself", () => {
    const d = shouldWake({
      prevSize: 100,
      curSize: 250,
      author: "alice",
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("self-author");
  });

  it("skips when agentName differs only in case (capitalised dir basename)", () => {
    // `author` is lowercased by lastBlockAuthor; `agentName` is a directory
    // basename and may be capitalised ("Alice"). The guard must lowercase
    // agentName at the comparison point or "alice" === "Alice" is false and the
    // self-wake guard is bypassed (self-wake storm).
    const d = shouldWake({
      prevSize: 100,
      curSize: 250,
      author: "alice",
      agentName: "Alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("self-author");
  });
});

describe("shouldWake — unparseable-author guard", () => {
  it("skips (does NOT wake) when the author could not be parsed", () => {
    const d = shouldWake({
      prevSize: 100,
      curSize: 250,
      author: null,
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("unparseable-author");
  });
});

describe("shouldWake — cooldown guard", () => {
  it("skips when a wake fired within the cooldown window", () => {
    const now = 1_000_000;
    const d = shouldWake({
      prevSize: 100,
      curSize: 250,
      author: "bob",
      agentName: "alice",
      lastWakeTs: now - 10_000, // 10s ago, inside the 30s cooldown
      now,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("cooldown-active");
  });

  it("wakes when the cooldown has elapsed", () => {
    const now = 1_000_000;
    const d = shouldWake({
      prevSize: 100,
      curSize: 250,
      author: "bob",
      agentName: "alice",
      lastWakeTs: now - 40_000, // 40s ago, past the 30s cooldown
      now,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(true);
    expect(d.reason).toBe("ok");
  });

  it("wakes on the first message (no prior wake stamp)", () => {
    const d = shouldWake({
      prevSize: 0,
      curSize: 120,
      author: "bob",
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(true);
    expect(d.reason).toBe("ok");
  });
});

describe("lastBlockAuthor — parses the last block's `from:` field", () => {
  it("returns the LAST block's author across a multi-block thread", () => {
    const text = [
      "## 2026-06-13T22:50:00Z - from: bob - status: read - subject: hi",
      "",
      "first body",
      "",
      "---",
      "",
      "## 2026-06-13T22:53:00Z - from: alice - status: sent - subject: re",
      "",
      "second body",
      "",
      "---",
    ].join("\n");
    expect(lastBlockAuthor(text)).toBe("alice");
  });

  it("returns the author for a single-block thread", () => {
    const text =
      "## 2026-06-13T22:53:00Z - from: bob - status: sent - subject: hi\n\nbody\n\n---\n";
    expect(lastBlockAuthor(text)).toBe("bob");
  });

  it("parses the hyphen delimiter dialect", () => {
    const text =
      "## 2026-06-13T22:53:00Z - from: courier - status: sent - subject: x";
    expect(lastBlockAuthor(text)).toBe("courier");
  });

  it("parses the em-dash delimiter dialect", () => {
    const text =
      "## 2026-06-13T22:53:00Z — from: courier — status: sent — subject: x";
    expect(lastBlockAuthor(text)).toBe("courier");
  });

  it("is case-insensitive and lowercases the result", () => {
    const text = "## 2026-06-13T22:53:00Z - From: BOB - status: sent";
    expect(lastBlockAuthor(text)).toBe("bob");
  });

  it("returns null when there is no `from:` token", () => {
    expect(lastBlockAuthor("## a header with no author marker\n\nbody")).toBe(
      null,
    );
    expect(lastBlockAuthor("")).toBe(null);
  });

  it("ignores from: quoted inside message bodies", () => {
    // The LAST real header is `from: bob`. The body that follows quotes the
    // block-header format (agents paste these when discussing the DM protocol),
    // including `from: alice` and `from: courier` on NON-header lines. The parser
    // must anchor to the header and return "bob", never a body quote.
    const text = [
      "## 2026-06-13T22:50:00Z - from: alice - status: read - subject: earlier",
      "",
      "an earlier body",
      "",
      "---",
      "",
      "## 2026-06-13T22:55:00Z - from: bob - status: sent - subject: protocol Q",
      "",
      "Here is how a block header looks when you DM someone:",
      "",
      "## 2026-06-13T10:00:00Z - from: alice - status: sent - subject: example",
      "and another example line saying from: courier in prose",
      "",
      "---",
    ].join("\n");
    // Note: the quoted example line above DOES start with `## ` (it is a pasted
    // header). The real-world contamination we guard is body prose quoting
    // `from:`; to make the regression unambiguous, use non-header quote lines:
    const bodyQuoteOnly = [
      "## 2026-06-13T22:55:00Z - from: bob - status: sent - subject: protocol Q",
      "",
      "When you DM, the header carries from: alice or from: courier.",
      "Quoting from: alice here in prose must not change the parsed author.",
      "",
      "---",
    ].join("\n");
    expect(lastBlockAuthor(bodyQuoteOnly)).toBe("bob");
    // And when the prior REAL header is the only other header, last real header
    // still wins over any body quote.
    expect(lastBlockAuthor(text.replace(/^## 2026-06-13T10:00:00Z.*$/m, "and a pasted example header was here in prose, from: alice"))).toBe("bob");
  });

  it("returns the header author even when the body quotes a different from:", () => {
    // Converse direction: last real header is `from: alice`; body quotes
    // `from: bob`. Must return "alice".
    const text = [
      "## 2026-06-13T22:55:00Z - from: alice - status: sent - subject: re",
      "",
      "Replying to your note. You wrote from: bob in the example you sent.",
      "Even quoting from: bob twice (from: bob) must not flip the author.",
      "",
      "---",
    ].join("\n");
    expect(lastBlockAuthor(text)).toBe("alice");
  });

  it("ignores a FULL pasted header inside the final block's body", () => {
    // Final block's real header is `from: bob`. Its body pastes a complete block
    // header line `## ...T... - from: alice - status: sent` (agents paste the DM
    // protocol header format into bodies whenever they discuss the protocol
    // itself). The FIRST structural header of the LAST block must win, so the pasted body
    // header AFTER it cannot flip the parsed author to "alice". Must return "bob".
    const text = [
      "## 2026-06-13T22:50:00Z - from: alice - status: read - subject: earlier",
      "",
      "earlier body",
      "",
      "---",
      "",
      "## 2026-06-13T22:55:00Z - from: bob - status: sent - subject: protocol Q",
      "",
      "Here is what a header looks like when you DM someone:",
      "",
      "## 2026-06-13T10:00:00Z - from: alice - status: sent - subject: example",
      "",
      "---",
    ].join("\n");
    expect(lastBlockAuthor(text)).toBe("bob");
  });

  it("returns the real header when the final block's body pastes a different full header (converse)", () => {
    // Final block real header is `from: alice`; body pastes `## ...from: bob...`.
    // First structural header wins -> "alice".
    const text = [
      "## 2026-06-13T22:55:00Z - from: alice - status: sent - subject: re",
      "",
      "Quoting the format you used:",
      "",
      "## 2026-06-13T10:00:00Z - from: bob - status: sent - subject: example",
      "",
      "---",
    ].join("\n");
    expect(lastBlockAuthor(text)).toBe("alice");
  });

  it("does NOT treat a casual markdown heading (no timestamp) as a structural header", () => {
    // `## Notes from: somewhere` is a casual heading, not a DM block header: it
    // lacks the ISO-ish timestamp. It must not be parsed as the author, so it
    // cannot override the real last header. Must return "bob".
    const text = [
      "## 2026-06-13T22:55:00Z - from: bob - status: sent - subject: hi",
      "",
      "## Notes from: somewhere",
      "",
      "some notes",
      "",
      "---",
    ].join("\n");
    expect(lastBlockAuthor(text)).toBe("bob");
  });

  it("returns null when the final block has only a casual heading (no structural header)", () => {
    // A final block whose only `##` line lacks a timestamp -> no structural
    // header -> null (caller conservatively skips; a real DM still surfaces on
    // the agent's next turn).
    const text = ["## Notes from: somewhere", "", "no real header here"].join(
      "\n",
    );
    expect(lastBlockAuthor(text)).toBe(null);
  });
});

describe("self-wake-loop regression", () => {
  // Inbox thread files are named after the CORRESPONDENT, not the writer. An
  // agent owns the physical file for ALL of its own threads, so alice's own
  // outbound DM to bob physically lands in
  // ~/.the-brain/agents/alice/inbox/bob.md. The OLD filename-derived sender would
  // read "bob" and never self-skip, spuriously waking alice after every send.
  // The fix: derive the author from the last block's `from:` content.
  const aliceOwnOutbound =
    "## 2026-06-13T22:50:00Z - from: bob - status: read - subject: ping\n\nhi\n\n---\n\n" +
    "## 2026-06-13T22:53:00Z - from: alice - status: sent - subject: re: ping\n\nreply\n\n---\n";

  const realInboundFromBob =
    "## 2026-06-13T22:50:00Z - from: alice - status: read - subject: re\n\nx\n\n---\n\n" +
    "## 2026-06-13T22:55:00Z - from: bob - status: sent - subject: new ask\n\nplease look\n\n---\n";

  it("does NOT wake when alice's own outbound is the last block in bob.md", () => {
    const author = lastBlockAuthor(aliceOwnOutbound);
    expect(author).toBe("alice");
    const d = shouldWake({
      prevSize: 100,
      curSize: 300,
      author,
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(false);
    expect(d.reason).toBe("self-author");
  });

  it("DOES wake when a real inbound from bob is the last block in bob.md", () => {
    const author = lastBlockAuthor(realInboundFromBob);
    expect(author).toBe("bob");
    const d = shouldWake({
      prevSize: 100,
      curSize: 300,
      author,
      agentName: "alice",
      lastWakeTs: undefined,
      now: 1_000_000,
      cooldownMs: COOLDOWN_MS,
    });
    expect(d.wake).toBe(true);
    expect(d.reason).toBe("ok");
  });
});

// --- tmux wake (mocked child_process) ---

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

describe("wakeAgent — tmux spawn (mocked)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function tmuxCalls(): string[][] {
    return execFileMock.mock.calls.map((c) => c[1] as string[]);
  }

  it("spawns literal send-keys then Enter when the window exists", async () => {
    // 1. list-windows -> stdout includes "alice" (window present)
    // 2. send-keys -l "<text>"
    // 3. send-keys Enter
    execFileMock.mockImplementation(
      (
        _bin: string,
        args: string[],
        _opts: object,
        cb: (e: unknown, out: string) => void,
      ) => {
        if (args[0] === "list-windows") cb(null, "bob\nalice\ncourier\n");
        else cb(null, "");
      },
    );

    const { wakeAgent } = await import("../../core/poke-agy/index.js");
    const logs: string[] = [];

    const p = wakeAgent("alice", "bob", (m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(400); // clear the 300ms Enter delay
    await p;

    const calls = tmuxCalls();
    // Every tmux invocation carries the { timeout: 5000 } options object at the
    // third arg (execFile(bin, args, opts, cb)) — the patient-critical hang cap.
    for (const call of execFileMock.mock.calls) {
      expect(call[2]).toEqual({ timeout: 5000 });
    }
    // First: window-exists probe.
    expect(calls[0]).toEqual(["list-windows", "-t", "agents", "-F", "#W"]);
    // Second: literal text via -l (no shell interpolation).
    expect(calls[1]).toEqual([
      "send-keys",
      "-t",
      "agents:alice",
      "-l",
      "[from:bob] check your inbox, message from bob",
    ]);
    // Third: the separate Enter keypress.
    expect(calls[2]).toEqual(["send-keys", "-t", "agents:alice", "Enter"]);
    expect(logs).toContain("poke-agy: woke alice (from bob)");
  });

  it("skips silently when the tmux window is absent (agent offline)", async () => {
    execFileMock.mockImplementation(
      (
        _bin: string,
        args: string[],
        _opts: object,
        cb: (e: unknown, out: string) => void,
      ) => {
        if (args[0] === "list-windows") cb(null, "bob\ncourier\n"); // no alice
        else cb(null, "");
      },
    );

    const { wakeAgent } = await import("../../core/poke-agy/index.js");
    const logs: string[] = [];

    const p = wakeAgent("alice", "bob", (m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(400);
    await p;

    const calls = tmuxCalls();
    // Only the list-windows probe ran; no send-keys.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("list-windows");
    expect(logs.some((l) => l.startsWith("poke-agy: woke"))).toBe(false);
  });

  it("treats a missing tmux binary as a no-op and logs once", async () => {
    execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: object,
        cb: (e: unknown, out: string) => void,
      ) => {
        const err = new Error("spawn tmux ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        cb(err, "");
      },
    );

    const { wakeAgent } = await import("../../core/poke-agy/index.js");
    const logs: string[] = [];

    const p = wakeAgent("alice", "bob", (m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(400);
    await p;

    // Only the probe ran; no send-keys, and no wake logged.
    expect(tmuxCalls()).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("poke-agy: woke"))).toBe(false);
    expect(logs).toContain("poke-agy: tmux binary not found; wakes are no-ops");
  });
});
