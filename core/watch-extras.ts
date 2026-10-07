// Which optional watchers `pnpm watch` starts besides the main file watcher.
//
// The daemon always watches the brain, memory and asset paths. The media filer
// (OpenClaw inbound media) and poke-agy (tmux wake for agy agents) serve
// specific runtimes, so they start only when asked:
//
//   BRAIN_WATCH_EXTRAS=media-filer,poke-agy   name them
//   BRAIN_WATCH_EXTRAS=all                    both (1 and true also mean all)
//   unset, empty or none                      neither (the default)

export const WATCH_EXTRAS = ["media-filer", "poke-agy"] as const;
export type WatchExtra = (typeof WATCH_EXTRAS)[number];

export interface ParsedWatchExtras {
  enabled: Set<WatchExtra>;
  unknown: string[];
}

export function parseWatchExtras(raw: string | undefined): ParsedWatchExtras {
  const enabled = new Set<WatchExtra>();
  const unknown: string[] = [];
  for (const token of (raw ?? "").split(",")) {
    const t = token.trim().toLowerCase();
    if (!t || t === "none" || t === "0" || t === "false") continue;
    if (t === "all" || t === "1" || t === "true") {
      for (const e of WATCH_EXTRAS) enabled.add(e);
    } else if ((WATCH_EXTRAS as readonly string[]).includes(t)) {
      enabled.add(t as WatchExtra);
    } else {
      unknown.push(t);
    }
  }
  return { enabled, unknown };
}
