import { describe, it, expect } from "vitest";
import { parseConfig, DEFAULT_CONFIG } from "../../core/context-engine/config.js";

describe("DEFAULT_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_CONFIG.recentTurnCount).toBe(20);
    expect(DEFAULT_CONFIG.preserveFirstUserMessage).toBe(true);
    expect(DEFAULT_CONFIG.minRawFloor).toBe(4);
    expect(DEFAULT_CONFIG.maxInjectedChars).toBe(40000);
    expect(DEFAULT_CONFIG.memoryBlockSource).toBe("memory-core");
    expect(DEFAULT_CONFIG.debug).toBe(false);
  });
});

describe("parseConfig", () => {
  it("returns defaults when called with no arguments", () => {
    const cfg = parseConfig(undefined, "/home/test");
    expect(cfg.recentTurnCount).toBe(20);
    expect(cfg.preserveFirstUserMessage).toBe(true);
    expect(cfg.minRawFloor).toBe(4);
    expect(cfg.maxInjectedChars).toBe(40000);
    expect(cfg.memoryBlockSource).toBe("memory-core");
    expect(cfg.debug).toBe(false);
  });

  it("merges provided values with defaults", () => {
    const cfg = parseConfig({ recentTurnCount: 10, debug: true }, "/home/test");
    expect(cfg.recentTurnCount).toBe(10);
    expect(cfg.debug).toBe(true);
    // Unset fields get defaults
    expect(cfg.preserveFirstUserMessage).toBe(true);
    expect(cfg.minRawFloor).toBe(4);
  });

  it("clamps recentTurnCount — negative values fall back to default then clamp", () => {
    // Number(-5) || 20 = -5 (truthy), then Math.max(1, -5) = 1
    expect(parseConfig({ recentTurnCount: -5 }, "/home/test").recentTurnCount).toBe(1);
    // Number(0) || 20 = 20 (0 is falsy → falls back to default)
    expect(parseConfig({ recentTurnCount: 0 }, "/home/test").recentTurnCount).toBe(20);
  });

  it("clamps minRawFloor — negative values fall back to default then clamp", () => {
    expect(parseConfig({ minRawFloor: -10 }, "/home/test").minRawFloor).toBe(1);
    // 0 is falsy → falls back to default 4
    expect(parseConfig({ minRawFloor: 0 }, "/home/test").minRawFloor).toBe(4);
  });

  it("clamps maxInjectedChars to minimum of 0", () => {
    expect(parseConfig({ maxInjectedChars: -100 }, "/home/test").maxInjectedChars).toBe(0);
  });

  it("treats maxInjectedChars=0 as falsy — falls back to default", () => {
    // Number(0) || 40000 = 40000 because 0 is falsy in JS
    // This means you can't explicitly set maxInjectedChars to 0
    expect(parseConfig({ maxInjectedChars: 0 }, "/home/test").maxInjectedChars).toBe(40000);
  });

  it("validates memoryBlockSource — accepts valid values", () => {
    expect(parseConfig({ memoryBlockSource: "file" }, "/tmp").memoryBlockSource).toBe("file");
    expect(parseConfig({ memoryBlockSource: "none" }, "/tmp").memoryBlockSource).toBe("none");
    expect(parseConfig({ memoryBlockSource: "memory-core" }, "/tmp").memoryBlockSource).toBe("memory-core");
  });

  it("defaults memoryBlockSource for invalid values", () => {
    expect(parseConfig({ memoryBlockSource: "invalid" }, "/tmp").memoryBlockSource).toBe("memory-core");
    expect(parseConfig({ memoryBlockSource: 42 }, "/tmp").memoryBlockSource).toBe("memory-core");
    expect(parseConfig({ memoryBlockSource: "" }, "/tmp").memoryBlockSource).toBe("memory-core");
  });

  it("resolves memoryRoot and memoryFile using workspace path", () => {
    const cfg = parseConfig({}, "/home/simon");
    expect(cfg.memoryRoot).toBe("/home/simon/.openclaw/workspace/memory");
    expect(cfg.memoryFile).toBe("/home/simon/.openclaw/workspace/MEMORY.md");
  });

  it("uses custom memoryRoot and memoryFile when provided", () => {
    const cfg = parseConfig({
      memoryRoot: "/custom/memory",
      memoryFile: "/custom/MEMORY.md",
    }, "/home/simon");
    expect(cfg.memoryRoot).toBe("/custom/memory");
    expect(cfg.memoryFile).toBe("/custom/MEMORY.md");
  });

  it("treats preserveFirstUserMessage as true unless explicitly false", () => {
    expect(parseConfig({}, "/tmp").preserveFirstUserMessage).toBe(true);
    expect(parseConfig({ preserveFirstUserMessage: true }, "/tmp").preserveFirstUserMessage).toBe(true);
    expect(parseConfig({ preserveFirstUserMessage: false }, "/tmp").preserveFirstUserMessage).toBe(false);
    // Truthy non-boolean values should be treated as true
    expect(parseConfig({ preserveFirstUserMessage: "yes" }, "/tmp").preserveFirstUserMessage).toBe(true);
    expect(parseConfig({ preserveFirstUserMessage: 1 }, "/tmp").preserveFirstUserMessage).toBe(true);
  });

  it("treats debug as false unless explicitly true", () => {
    expect(parseConfig({}, "/tmp").debug).toBe(false);
    expect(parseConfig({ debug: true }, "/tmp").debug).toBe(true);
    expect(parseConfig({ debug: false }, "/tmp").debug).toBe(false);
    // Truthy non-boolean values should NOT enable debug
    expect(parseConfig({ debug: "yes" }, "/tmp").debug).toBe(false);
    expect(parseConfig({ debug: 1 }, "/tmp").debug).toBe(false);
  });

  it("handles NaN numeric inputs by falling back to defaults", () => {
    const cfg = parseConfig({
      recentTurnCount: "not a number",
      minRawFloor: undefined,
      maxInjectedChars: null,
    } as Record<string, unknown>, "/tmp");
    expect(cfg.recentTurnCount).toBe(20);
    expect(cfg.minRawFloor).toBe(4);
    expect(cfg.maxInjectedChars).toBe(40000);
  });
});
