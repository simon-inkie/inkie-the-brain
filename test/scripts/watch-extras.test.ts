import { describe, it, expect } from "vitest";
import { parseWatchExtras } from "../../core/watch-extras.js";

describe("parseWatchExtras", () => {
  it("starts nothing by default", () => {
    for (const raw of [undefined, "", "none", "0", "false", " , "]) {
      expect(parseWatchExtras(raw).enabled.size).toBe(0);
    }
  });

  it("enables both for all, 1 and true", () => {
    for (const raw of ["all", "1", "true", "ALL"]) {
      expect([...parseWatchExtras(raw).enabled].sort()).toEqual(["media-filer", "poke-agy"]);
    }
  });

  it("enables only the named ones", () => {
    expect([...parseWatchExtras("poke-agy").enabled]).toEqual(["poke-agy"]);
    expect([...parseWatchExtras("media-filer, poke-agy").enabled].sort()).toEqual([
      "media-filer",
      "poke-agy",
    ]);
  });

  it("reports unknown names instead of silently starting something", () => {
    const r = parseWatchExtras("poke-agy,bogus");
    expect(r.unknown).toEqual(["bogus"]);
    expect([...r.enabled]).toEqual(["poke-agy"]);
  });
});
