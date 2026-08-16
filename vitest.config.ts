import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Vitest's 5s default is too tight for the tests that SPAWN a process (the
    // hook and CLI suites shell out to node): on a loaded box the spawn alone
    // eats most of it, and they fail on machine load rather than on anything
    // they assert. A timeout is not an assertion, so raising the ceiling
    // weakens no test — it only stops a slow box being reported as a bug.
    testTimeout: 30_000,
  },
});
