export const MIN_CONTENT_LENGTH = 20;

export const SKIP_PATTERNS = [
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^\[cron:/,
  /^Read HEARTBEAT\.md/,
  /^System: \[/,
];

export function shouldSkipMessage(content: string): boolean {
  if (content.length < MIN_CONTENT_LENGTH) return true;
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(content)) return true;
  }
  return false;
}
