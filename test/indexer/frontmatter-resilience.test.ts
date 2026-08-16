/**
 * The indexer must not let ONE malformed-frontmatter file abort the whole run
 * (an uncaught gray-matter throw once killed semantic recall workspace-wide for
 * days).
 * safeParseFrontmatter returns null on a parse throw so the caller skips + continues.
 *
 * gray-matter's real throw-on-bad-YAML behaviour is environment-dependent (its
 * bundled js-yaml is more lenient under the test transform than in prod/standalone -
 * the corpus files that triggered it genuinely crash a deployed indexer). So this
 * unit test mocks the parser to THROW deterministically and asserts the catch
 * contract: a throw becomes null (skip), never propagates. The real-corpus crash
 * was proven separately, by a standalone gray-matter scan over the vault.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("gray-matter", () => ({
  default: (content: string) => {
    if (content.includes("__THROW__")) {
      throw new Error("malformed YAML (simulated): end of stream expected");
    }
    const m = content.match(/title:\s*(.+)/);
    return {
      data: m ? { title: m[1].trim() } : {},
      content: content.replace(/^---[\s\S]*?---/, "").trim(),
    };
  },
}));

import { safeParseFrontmatter } from "../../core/indexer/files.js";

describe("safeParseFrontmatter - indexer resilience", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns null (does NOT throw) when the parser throws on malformed frontmatter", () => {
    const bad = "---\n__THROW__\n---\nbody";
    expect(() => safeParseFrontmatter(bad, "/bad.md")).not.toThrow();
    expect(safeParseFrontmatter(bad, "/bad.md")).toBeNull();
  });

  it("logs the skipped file (so the skip is visible, not silent)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    safeParseFrontmatter("---\n__THROW__\n---\nx", "/silos/bad-note.md");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("bad-note.md"))).toBe(true);
  });

  it("returns the parsed result for valid frontmatter", () => {
    const r = safeParseFrontmatter("---\ntitle: Hello\n---\nbody", "/ok.md");
    expect(r).not.toBeNull();
    expect(r!.data.title).toBe("Hello");
    expect(r!.content).toBe("body");
  });

  it("a valid file still parses AFTER a malformed one (the run continues)", () => {
    safeParseFrontmatter("---\n__THROW__\n---\nx", "/bad.md"); // does not throw
    const r = safeParseFrontmatter("---\ntitle: Recovered\n---\nok", "/next.md");
    expect(r).not.toBeNull();
    expect(r!.data.title).toBe("Recovered");
  });
});
