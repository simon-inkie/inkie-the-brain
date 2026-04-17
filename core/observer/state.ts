import { readFileSync } from "fs";
import type { ObserverState } from "./types.js";

export function readState(stateFile: string): ObserverState {
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return {};
  }
}
