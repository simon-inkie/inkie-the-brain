#!/usr/bin/env node
// Context statusline -- "<agent> | <model> | <dir> | [bar] <used>%".
//
// A purpose-built context-usage bar for Claude Code's `statusLine` hook: the
// context math (used % of the usable window, with the auto-compact-buffer
// normalisation) and nothing else. Also writes a best-effort context bridge
// file to tmp for any external context monitor that wants to read it.
//
// Wire it in via the `statusLine` field in your project or user
// `~/.claude/settings.json`:
//   { "statusLine": { "type": "command", "command": "node /path/to/context-statusline.cjs" } }
// AGENT_NAME is read optionally, for a multi-agent setup that sets it per
// agent home (e.g. ~/agents/<name>/.claude/settings.json); it is not required.

const fs = require('fs');
const path = require('path');
const os = require('os');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);

    // Best-effort rate-limit snapshot for the morning roundup (real weekly-window
    // %, not the ccusage token proxy). Fails silently if the field is absent.
    try {
      if (data.rate_limits) {
        const usageDir = path.join(os.homedir(), '.the-brain', 'usage');
        fs.mkdirSync(usageDir, { recursive: true });
        fs.writeFileSync(
          path.join(usageDir, 'rate-limits.json'),
          JSON.stringify({ rate_limits: data.rate_limits, timestamp: Math.floor(Date.now() / 1000) })
        );
      }
    } catch (e) {
      // best-effort, never break the statusline
    }

    const model = data.model?.display_name || 'Claude';
    let dir = data.workspace?.current_dir || process.cwd();
    const home = os.homedir();
    if (dir === home) dir = '~';
    else if (dir.startsWith(home + path.sep)) dir = '~' + dir.slice(home.length);
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;
    const rawTotalCtx = data.context_window?.context_window_size;
    const totalCtx = Number.isFinite(rawTotalCtx) && rawTotalCtx > 0 ? rawTotalCtx : 1_000_000;

    // Context usage bar (USED % of the usable window). Claude Code reserves a
    // buffer for auto-compact (~16.5% by default, overridable via
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW); normalise so the meter reflects it.
    let ctx = '';
    if (remaining != null) {
      const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
      const bufferPct = acw > 0 ? Math.min(100, (acw / totalCtx) * 100) : 16.5;
      const usableRemaining = Math.max(0, ((remaining - bufferPct) / (100 - bufferPct)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Best-effort context bridge for any context monitor that reads it.
      // Reject session ids with path separators / traversal to stay in tmp.
      const sessionSafe = session && !/[/\\]|\.\./.test(session);
      if (sessionSafe) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          fs.writeFileSync(
            bridgePath,
            JSON.stringify({
              session_id: session,
              remaining_percentage: remaining,
              used_pct: Math.round(100 - remaining),
              timestamp: Math.floor(Date.now() / 1000),
            })
          );
        } catch (e) {
          // best-effort, never break the statusline
        }
      }

      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      if (used < 50) ctx = `\x1b[32m${bar} ${used}%\x1b[0m`;
      else if (used < 65) ctx = `\x1b[33m${bar} ${used}%\x1b[0m`;
      else if (used < 80) ctx = `\x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      else ctx = `\x1b[5;31m\u{1F480} ${bar} ${used}%\x1b[0m`;
    }

    const agentName = process.env.AGENT_NAME || '';
    const segs = [];
    if (agentName) segs.push(`\x1b[36m${agentName}\x1b[0m`);
    segs.push(`\x1b[1m${model}\x1b[0m`);
    segs.push(dir);
    if (ctx) segs.push(ctx);
    process.stdout.write(segs.join(' │ '));
  } catch (e) {
    process.exit(0);
  }
});
