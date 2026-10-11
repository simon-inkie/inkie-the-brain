export class SettingsShapeError extends Error {}
export const HOOK_SPECS: {
  event: string;
  matcher?: string;
  script: string;
  timeout: number;
}[];
export function mergeHooks(
  settings: unknown,
  binDir: string,
): { event: string; matcher?: string; status: "added" | "updated" | "unchanged" }[];
