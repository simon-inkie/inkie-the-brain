/**
 * Pure merge of the-brain's Claude Code hooks into a settings object.
 *
 * Kept free of file and process access so it can be unit tested. The CLI that
 * reads and writes settings.json is scripts/install-hooks.mjs.
 *
 * A hook is recognised as ours by the tail of its command, not by the whole
 * path: `.../claude-code/bin/<script>.sh`. That is what makes the merge
 * path-agnostic. A checkout cloned under any name, or moved since the last
 * install, still matches its own earlier entry, which is rewritten in place
 * rather than duplicated. Hooks that are not ours are never touched.
 */

export class SettingsShapeError extends Error {}

export const HOOK_SPECS = [
  { event: "UserPromptSubmit", script: "user-prompt-submit.sh", timeout: 5 },
  { event: "Stop", script: "on-stop.sh", timeout: 5 },
  { event: "PreCompact", matcher: "auto", script: "on-pre-compact.sh", timeout: 10 },
  { event: "PreCompact", matcher: "manual", script: "on-pre-compact.sh", timeout: 10 },
];

function isOurs(command, script) {
  if (typeof command !== "string") return false;
  const bare = command.trim().replace(/^["']|["']$/g, "");
  return bare.endsWith(`/claude-code/bin/${script}`) || bare.endsWith(`\\claude-code\\bin\\${script}`);
}

/**
 * @param {object} settings  parsed settings.json (mutated in place)
 * @param {string} binDir    absolute path of dist/claude-code/bin
 * @returns {{event:string, matcher?:string, status:"added"|"updated"|"unchanged"}[]}
 */
export function mergeHooks(settings, binDir) {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new SettingsShapeError("settings.json must contain a JSON object");
  }
  if (settings.hooks === undefined) settings.hooks = {};
  if (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new SettingsShapeError('"hooks" in settings.json must be an object');
  }

  const dir = binDir.replace(/[\\/]+$/, "");
  const results = [];

  for (const spec of HOOK_SPECS) {
    const command = `${dir}/${spec.script}`;
    if (settings.hooks[spec.event] === undefined) settings.hooks[spec.event] = [];
    const groups = settings.hooks[spec.event];
    if (!Array.isArray(groups)) {
      throw new SettingsShapeError(`hooks.${spec.event} in settings.json must be an array`);
    }

    let status = "added";
    let found = false;
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
      if ((group.matcher ?? undefined) !== spec.matcher) continue;
      for (const hook of group.hooks) {
        if (!hook || !isOurs(hook.command, spec.script)) continue;
        found = true;
        if (hook.command !== command) {
          hook.command = command;
          status = "updated";
        } else {
          status = "unchanged";
        }
      }
    }

    if (!found) {
      const group = { hooks: [{ type: "command", command, timeout: spec.timeout }] };
      if (spec.matcher !== undefined) group.matcher = spec.matcher;
      groups.push(group);
    }
    results.push({ event: spec.event, ...(spec.matcher ? { matcher: spec.matcher } : {}), status });
  }
  return results;
}
