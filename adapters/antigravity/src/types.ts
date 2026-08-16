/**
 * the-brain Antigravity (agy) adapter — shared hook event types.
 *
 * agy CLI hook events (verified live on agy 1.0.7):
 * PreToolUse / PostToolUse / PreInvocation / PostInvocation / Stop.
 * Every event arrives as camelCase JSON on stdin and carries
 * `transcriptPath` (a transcript.jsonl), `conversationId`, and
 * `workspacePaths`. Hook output is camelCase JSON on stdout.
 *
 * Layout mirrors adapters/claude-code/: bin/ thin bash entries probe a
 * bundled .js first and fall back to tsx on the src/ handler; src/ holds
 * the TS handlers. Fail-open everywhere: a broken hook must never block
 * the agent's turn.
 */

/** Fields common to every agy hook event payload. */
export interface AgyHookInput {
  transcriptPath?: string;
  conversationId?: string;
  workspacePaths?: string[];
}

/** Stop event extras (A2: Stop fires at execution end in the flat form). */
export interface AgyStopInput extends AgyHookInput {
  terminationReason?: string;
  fullyIdle?: boolean;
}

/**
 * PreInvocation output envelope. `ephemeralMessage` is injected as a
 * transient system message for the upcoming model call only — the agy
 * equivalent of Claude Code's UserPromptSubmit `additionalContext`.
 * Fail-open shape is `{ "injectSteps": [] }`.
 */
export interface AgyInjectEnvelope {
  injectSteps: Array<{ ephemeralMessage: string }>;
}

/**
 * One line of an agy transcript.jsonl (observed shape, agy 1.0.7).
 * `source` is USER_EXPLICIT | SYSTEM | MODEL; `type` is USER_INPUT,
 * PLANNER_RESPONSE, CONVERSATION_HISTORY, SYSTEM_MESSAGE, or a tool
 * step name (VIEW_FILE, RUN_COMMAND, GREP_SEARCH, ...).
 */
export interface AgyTranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
}

/**
 * A single tool call as delivered in the agy PreToolUse hook payload.
 * Verified live against agy:
 *   { "name": "run_command", "args": { "CommandLine": "...", "Cwd": "...", "WaitMsBeforeAsync": N } }
 */
export interface AgyToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Full agy PreToolUse hook input (camelCase JSON on stdin).
 * Extends the common hook fields with the tool call being proposed.
 */
export interface AgyPreToolUseInput extends AgyHookInput {
  toolCall?: AgyToolCall;
  stepIdx?: number;
}

/**
 * PreToolUse hook result emitted on stdout.
 * STRICT: agy unmarshals via protojson on hooks_go_proto.PreToolHookResult.
 * ANY extra field (userMessage, blockReasonMessage, reason, etc.) fails the
 * whole unmarshal at col 20 and defaults to allow. Emit ONLY { allowTool }.
 */
export interface AgyPreToolResult {
  allowTool: boolean;
}
