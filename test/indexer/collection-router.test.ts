import { describe, it, expect } from "vitest";
import { detectCollection, agentNameFromPath } from "../../core/indexer/collection-router.js";
import { config } from "../../core/config.js";

describe("detectCollection", () => {
  describe("per-agent silos (the regression this fix addresses)", () => {
    it("routes ~/.the-brain/agents/inkie-io/memory/observations/* to io-observations", () => {
      expect(
        detectCollection(
          "/home/simon/.the-brain/agents/inkie-io/memory/observations/2026-04-21-14-05-22.md",
        ),
      ).toBe(config.collections.observations);
    });

    it("routes ~/.the-brain/agents/inkie-io/memory/reflections/* to io-reflections", () => {
      expect(
        detectCollection(
          "/home/simon/.the-brain/agents/inkie-io/memory/reflections/2026-04-21-14-05-22.md",
        ),
      ).toBe(config.collections.reflections);
    });

    it("routes per-agent MEMORY.md to io-reflections", () => {
      expect(
        detectCollection("/home/simon/.the-brain/agents/inkie-io/MEMORY.md"),
      ).toBe(config.collections.reflections);
    });

    it("works for arbitrary future agent names", () => {
      expect(
        detectCollection(
          "/home/simon/.the-brain/agents/harness-hello-world/memory/observations/2026-04-21-14-05-22.md",
        ),
      ).toBe(config.collections.observations);
      expect(
        detectCollection(
          "/home/simon/.the-brain/agents/greymatter-dev/memory/reflections/2026-04-21.md",
        ),
      ).toBe(config.collections.reflections);
      expect(
        detectCollection("/home/simon/.the-brain/agents/inkie-bugfix-2/MEMORY.md"),
      ).toBe(config.collections.reflections);
    });
  });

  describe("legacy OpenClaw paths (transition-compat)", () => {
    it("still routes OpenClaw observations", () => {
      expect(
        detectCollection(
          "/home/simon/.openclaw/workspace/memory/observations/2026-04-19-15-43.md",
        ),
      ).toBe(config.collections.observations);
    });

    it("still routes OpenClaw reflections", () => {
      expect(
        detectCollection(
          "/home/simon/.openclaw/workspace/memory/reflections/2026-04-19.md",
        ),
      ).toBe(config.collections.reflections);
    });

    it("still routes OpenClaw MEMORY.md", () => {
      expect(
        detectCollection("/home/simon/.openclaw/workspace/MEMORY.md"),
      ).toBe(config.collections.reflections);
    });
  });

  describe("brain vault", () => {
    it("routes ~/brain/ideas/* to brain-vault", () => {
      expect(
        detectCollection("/home/simon/brain/ideas/claude-io-multi-agent-platform.md"),
      ).toBe(config.collections.brain);
    });

    it("routes ~/brain/decisions/* to brain-vault", () => {
      expect(
        detectCollection("/home/simon/brain/decisions/2026-04-10-context-engine-plugin.md"),
      ).toBe(config.collections.brain);
    });

    it("routes ~/.openclaw/workspace/brain/* to brain-vault (symlink source)", () => {
      expect(
        detectCollection("/home/simon/.openclaw/workspace/brain/ideas/foo.md"),
      ).toBe(config.collections.brain);
    });
  });

  describe("non-matching paths", () => {
    it("returns null for random files", () => {
      expect(detectCollection("/home/simon/some/random/file.md")).toBe(null);
    });

    it("returns null for files outside tracked locations", () => {
      expect(detectCollection("/tmp/ephemeral.md")).toBe(null);
    });
  });

  describe("ambiguity safety", () => {
    it("prefers observations over brain when path contains both substrings", () => {
      // A memory silo under a nested brain-labelled path should still route to
      // observations — the per-agent check runs first.
      expect(
        detectCollection(
          "/home/simon/brain/some/weird/memory/observations/x.md",
        ),
      ).toBe(config.collections.observations);
    });
  });
});

describe("agentNameFromPath", () => {
  describe("absolute paths (runtime indexer)", () => {
    it("extracts name from ~/.the-brain/agents/<name>/memory/...", () => {
      expect(
        agentNameFromPath(
          "/home/simon/.the-brain/agents/io/memory/observations/2026-04-22-10-00.md",
        ),
      ).toBe("io");
    });

    it("extracts name from per-agent MEMORY.md", () => {
      expect(
        agentNameFromPath("/home/simon/.the-brain/agents/doctor-two/MEMORY.md"),
      ).toBe("doctor-two");
    });

    it("handles hyphenated names", () => {
      expect(
        agentNameFromPath(
          "/home/simon/.the-brain/agents/inkie-bugfix-2/memory/reflections/2026-04-19.md",
        ),
      ).toBe("inkie-bugfix-2");
    });
  });

  describe("workspace-relative source strings (backfill from Qdrant payload)", () => {
    it("extracts name from ../../.the-brain/agents/<name>/memory/...", () => {
      expect(
        agentNameFromPath(
          "../../.the-brain/agents/io/memory/observations/2026-04-22-10-00.md",
        ),
      ).toBe("io");
    });

    it("extracts name from ../../.the-brain/agents/<name>/MEMORY.md", () => {
      expect(
        agentNameFromPath("../../.the-brain/agents/greymatter-dev/MEMORY.md"),
      ).toBe("greymatter-dev");
    });
  });

  describe("unscoped paths (should be null)", () => {
    it("returns null for brain vault paths", () => {
      expect(
        agentNameFromPath("/home/simon/brain/ideas/something.md"),
      ).toBe(null);
    });

    it("returns null for legacy pre-silo source (no agents/ segment)", () => {
      expect(
        agentNameFromPath("memory/observations/2026-03-27-23-56.md"),
      ).toBe(null);
    });

    it("returns null for bare MEMORY.md (no agents/ segment)", () => {
      expect(agentNameFromPath("MEMORY.md")).toBe(null);
    });

    it("returns null for OpenClaw workspace paths", () => {
      expect(
        agentNameFromPath("/home/simon/.openclaw/workspace/memory/observations/x.md"),
      ).toBe(null);
    });

    it("returns null for random paths", () => {
      expect(agentNameFromPath("/tmp/ephemeral.md")).toBe(null);
      expect(agentNameFromPath("")).toBe(null);
    });
  });

  describe("edge cases", () => {
    it("does not match /agents/ that isn't preceded by path separator", () => {
      // the regex anchors on `(?:^|\/)agents\/` so a file literally named
      // `fooagents/bar.md` shouldn't match
      expect(agentNameFromPath("fooagents/bar/baz.md")).toBe(null);
    });

    it("does not match agents/ without a trailing segment", () => {
      // `agents/` at end of string with no name shouldn't match
      expect(agentNameFromPath("/tmp/agents/")).toBe(null);
      expect(agentNameFromPath("/tmp/agents")).toBe(null);
    });

    it("does not match names with invalid chars (matches the tier-0 validator)", () => {
      // Capital letters, slashes, underscores aren't in the [a-z0-9-]+ alphabet.
      expect(agentNameFromPath("/agents/Upper/memory/x.md")).toBe(null);
      expect(agentNameFromPath("/agents/bad_name/memory/x.md")).toBe(null);
    });
  });
});
