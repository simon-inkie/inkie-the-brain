/**
 * What the score-weight env var is allowed to be.
 *
 * A pure typo like "abc" yields NaN and is caught below, but `parseFloat`
 * parses a leading numeric prefix and silently ignores the rest, so a typo
 * AFTER a valid number ("0.93oops") would parse as 0.93 with no warning at
 * all, `Number()` is used instead so the whole trimmed string must be valid.
 * Validation belongs at the sink, where the value is born, so no caller has
 * to remember.
 *
 * Zero and negatives are rejected rather than clamped: 0 silently MUTES a
 * collection and a negative INVERTS its ranking. Neither is a plausible intent
 * for a tuning knob, and muting deserves an explicit mechanism.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const DEFAULT = 0.93;

async function weightFor(envValue: string | undefined): Promise<{
  weight: number;
  warnings: string[];
}> {
  vi.resetModules();
  const warnings: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    warnings.push(args.join(" "));
  });

  delete process.env.BRAIN_MESSAGES_COLLECTION;
  if (envValue === undefined) delete process.env.BRAIN_MESSAGES_SCORE_WEIGHT;
  else process.env.BRAIN_MESSAGES_SCORE_WEIGHT = envValue;

  const { config } = await import("../../core/config.js");
  spy.mockRestore();
  return {
    weight: config.searchDefaults.collectionWeights[config.collections.messages],
    warnings,
  };
}

const previous = process.env.BRAIN_MESSAGES_SCORE_WEIGHT;

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.BRAIN_MESSAGES_SCORE_WEIGHT;
  else process.env.BRAIN_MESSAGES_SCORE_WEIGHT = previous;
});

describe("a bad score weight falls back to the default instead of poisoning the ranking", () => {
  it.each([
    ["a typo", "abc"],
    ["a mute", "0"],
    ["an inversion", "-1"],
    ["an empty string", ""],
    ["a valid prefix with trailing garbage", "0.93oops"],
  ])("rejects %s and warns", async (_label, value) => {
    const { weight, warnings } = await weightFor(value);
    expect(weight).toBe(DEFAULT);
    if (value !== "") {
      expect(
        warnings.join("\n"),
        "a silently-ignored env var is how a tuning knob stops meaning anything",
      ).toMatch(/BRAIN_MESSAGES_SCORE_WEIGHT/);
    }
  });

  it("applies a valid weight", async () => {
    const { weight, warnings } = await weightFor("0.9");
    expect(weight).toBe(0.9);
    expect(warnings.join("\n")).not.toMatch(/BRAIN_MESSAGES_SCORE_WEIGHT/);
  });

  it("applies the default when unset", async () => {
    const { weight, warnings } = await weightFor(undefined);
    expect(weight).toBe(DEFAULT);
    expect(warnings.join("\n")).not.toMatch(/BRAIN_MESSAGES_SCORE_WEIGHT/);
  });
});
