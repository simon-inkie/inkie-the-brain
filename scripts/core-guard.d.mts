/**
 * Type declarations for core-guard.mjs (the build-time CORE guard).
 * Keep in sync with the exports in core-guard.mjs.
 */

/** Assembled-byte cap: CORE + wrapper must stay under this to clear the 10,000-char hook cap. */
export const CORE_CAP: number;

/** The static first-action read wrapper for an agent (byte-identical to build_wrapper() in persona-inject.sh). */
export function buildWrapper(agentName: string, home?: string): string;

/** Assembled byte size the hook emits for a CORE-present agent: CORE + wrapper. */
export function assembledBytes(coreContent: string, agentName: string, home?: string): number;

/** Scan agentsDir for <agent>/CORE.md and return the agents whose assembled CORE+wrapper exceeds CORE_CAP. */
export function checkCores(opts?: { agentsDir?: string; home?: string }): { agent: string; bytes: number }[];
