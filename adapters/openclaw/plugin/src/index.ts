/**
 * greymatter — OpenClaw context engine plugin adapter.
 *
 * Thin wrapper over core/context-engine. Registers a ContextEngine that bounds
 * per-turn message history via intelligent slicing.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { GreymatterEngine, parseConfig } from "../../../../core/context-engine/index.js";

export { GreymatterEngine, sliceRecent, approxChars, readInjectedMemoryBlock, parseConfig, DEFAULT_CONFIG } from "../../../../core/context-engine/index.js";
export type { GreymatterConfig } from "../../../../core/context-engine/index.js";

export default definePluginEntry({
  id: "greymatter",
  name: "Greymatter",
  description: "Context engine — bounds per-turn message history via intelligent slicing.",

  register(api) {
    const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;

    // Cast to satisfy SDK's ContextEngine type — our local Message types are
    // structurally compatible at runtime but TypeScript can't prove it across
    // the package boundary (SDK uses @mariozechner/pi-ai types which aren't
    // in the exports map). Duck typing handles this at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.registerContextEngine("greymatter", (() => {
      const cfg = parseConfig(pluginConfig, process.env.HOME);
      return new GreymatterEngine(cfg);
    }) as any);
  },
});
