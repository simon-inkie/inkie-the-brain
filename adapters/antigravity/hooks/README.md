# agy `.agents/hooks.json` template

`hooks.json` here is the the-brain hook wiring for an agy (Antigravity CLI)
agent. Install it by copying to the agent's WORKSPACE customization dir:

```
~/agents/<name>/.agents/hooks.json
```

replacing `__THE_BRAIN_ROOT__` with the absolute path to your checkout of
this repository (e.g. `~/the-brain`, spelled out in full). agy's expansion
of env vars inside command strings is unverified, so the template uses an
explicit placeholder instead of `$VARS`.

The workspace `.agents/` location is the VERIFIED-FIRING location (agy
1.0.7). The docs also allow `~/.gemini/config/`, and plugin-bundled hooks
exist, but the plugin validator contradicts the docs and plugin hooks
remain unverified. Stick to the workspace file.

## Schema: the dialect trap (read before editing)

agy's hooks.json is one nesting level DIFFERENT from Claude Code's, and
getting it wrong fails SILENTLY (hooks validate but never fire):

1. Events are nested under a top-level hook NAME (`"the-brain"` above),
   not under a top-level `"hooks"` key.
2. The non-matcher events (`PreInvocation`, `PostInvocation`, `Stop`) take
   the FLAT form:

   ```json
   "Stop": [{ "type": "command", "command": "..." }]
   ```

   The CC-style nested form `"Stop": [{ "hooks": [{ ... }] }]` validates
   but silently no-ops — this exact trap cost a day of "Stop doesn't fire"
   during discovery. Do not copy CC hook stanzas across.
3. Only `PreToolUse` / `PostToolUse` use the matcher+hooks form:

   ```json
   "PreToolUse": [
     { "matcher": "*", "hooks": [{ "type": "command", "command": "..." }] }
   ]
   ```

   (the-brain ships no agy tool hooks in v1; shape documented for future use.)

## Event payload contract

All five events (PreToolUse / PostToolUse / PreInvocation / PostInvocation /
Stop) receive camelCase JSON on stdin carrying `transcriptPath` (a
transcript.jsonl), `conversationId`, and `workspacePaths`. PreInvocation
consumes stdout: `{"injectSteps":[{"ephemeralMessage":"..."}]}` injects a
transient system message into the upcoming model call. Headless `agy -p`
does NOT fire hooks; only interactive sessions do.

## Runtime requirements

- `AGENT_NAME` must be set in the session env (the boot path launches
  `AGENT_NAME=<name> agy ...`) so memory routing and log tagging resolve.
  Without it the hooks fail open: no injection, no silo writes, no crash.
- Both bin/ entries are fail-open: any error emits the neutral envelope
  (`{"injectSteps":[]}` / `{}`) and exits 0, never blocking the turn.
