# Workspace foundation

The foundation provides explicit-call libraries and standalone read-only helpers.
It is an unwired foundation: the existing installed hooks, configuration,
indexer and observer still use their legacy paths. It does not yet provide a
usable workspace installation. Subsequent integration must connect and verify
all installed callers together.

## Selection and manifest

Only a nonblank external `WORKSPACE_ROOT` selects workspace mode. It must name an
absolute existing directory with a regular readable `workspace.json`:

```json
{
  "schemaVersion": 1,
  "workspaceId": "a1111111-2222-4333-8444-555555555555",
  "paths": {
    "agents": "agents",
    "brain": "brain",
    "silos": "silos",
    "inbox": "inbox",
    "projects": "projects",
    "attachments": "attachments",
    "plugins": "plugins",
    "local": "device"
  },
  "externalReadOnlyEnv": []
}
```

All required paths are relative, without dot traversal, empty segments, NUL or
backslash. Extra declared paths receive the same validation. Top-level extension
keys are allowed. Targets must be distinct and confined to the selected root;
present dangling links refuse. Resolution creates nothing. The workspace ID
stays unchanged when the directory moves.

`local/brain` contains disposable state, index data, cache and logs.
`local/deck` is resolved for alias compatibility and is never written by Brain.
`INBOX_ROOT`, `ATTACHMENTS_ROOT`, `PROJECTS_ROOT`, `DATA_ROOT`, `AGENTS_ROOT`,
`AGENTS_HOME`, `BRAIN_VAULT_DIR` and `BRAIN_STATE_DIR` must be absent, blank or
equal to their declared paths. Message index state overrides must be strictly
inside `local/brain/index`. Conflicts fail before writes.

## Runtime and confinement

Workspace operations require Linux, Node 22 or newer, no-follow and nonblocking
opens, directory descriptors and working `/proc/self/fd` revalidation. Native
macOS workspace mode is unsupported and refuses before effects; legacy macOS
behaviour is unchanged. This is not a hostile-process sandbox or an immutable
snapshot against concurrent in-place edits.

Reads retain descriptors through traversal, type and identity checks and original
request reauthorisation. Canonical in-root symlinks are permitted. Manifest,
memory, pointer, environment and persona reads use these primitives. An external
read requires a named environment variable declared in `externalReadOnlyEnv`;
it grants no write authority. Persona reads stay within `agents`; note and era
reads stay within the selected memory directory.

Derived writes stay strictly inside `local/brain`. They create exclusive mode
0600 temporary files beside their destination, write and sync before replacing,
and remove only their own temporary inode on failure. A failed sync after
replacement reports `WORKSPACE_WRITE_UNCERTAIN`; it does not restore old bytes.
A refresh is a sequence of atomic files, not a multi-file transaction. Missing
provenance prevents a partial era refresh being treated as a complete generation.
Concurrent refresh writers must be serialised by a later consumer. This slice
supplies no active pointer CAS or managed reset protocol.

## Libraries

`loadWorkspace(env)` returns null for blank selection without filesystem access.
All other foundation operations are explicit; imports discover no roots, create
no directories and load no provider or store clients.

`loadFoundationEnv(env)` returns validated values and sanitised warnings without
mutating the process. `applyFoundationEnv(result)` applies them explicitly. In
legacy mode process values win, followed by explicit `BRAIN_ENV_FILE`, the public
home environment file and its legacy location. The existing TypeScript parser
fills empty values, retains literal quotes and does not implement dotenv syntax.
Workspace mode reads no implicit home environment file. Even an in-root explicit
file needs `BRAIN_ENV_FILE` declared. File entries cannot switch mode or roots.
Existing shell empty-variable behaviour will be reconciled at caller integration.

`resolveWorkspaceMemoryDir(ws, projectDir, env)` selects a valid explicit agent,
existing project memory, a confined project pointer, explicit memory override or
basename silo. Overrides must remain strictly within `silos`; no home fallback
or tilde expansion applies. Invalid names warn and try later tiers. An invalid
present pointer, including an empty or whitespace-only pointer, or escaping
override refuses instead of falling through. Blank present pointers report
`WORKSPACE_MEMORY_POINTER_INVALID`; absent pointers retain lower-tier fallback.

`derivedMemoryPaths(memoryDir, leaf, ws)` preserves both requested and resolved
entries and creates nothing. The allowed leaves are `live-state.json`,
`observer-state.json`, `era-summary.md`, `era-summary.meta.json`,
`era-authored-provenance.json` and `rendered-MEMORY.md`. Lookup grants no write
permission. Without an explicit workspace it returns the legacy memory leaf.

`readDerivedMemoryState` computes authored configuration plus disposable counters.
`refreshDerivedMemoryState` explicitly persists that view and matching era source
hashes. If a local era artifact needed for the authored pair is missing, reads
and refreshes restore the authored summary, metadata, level and coverage date
together. Each live view derives level and coverage from its selected validated
era metadata, including after an observer-first refresh restores the shared
pair and provenance. Live refresh persists that coherent view; read alone does
not repair stored state. Complete local compression pairs retain their local
coverage and reduced hot count when authored inputs are unchanged. Other live
counters remain preserved. Observer thresholds and timing configuration remain
authored. An unchanged
configured hot target preserves local reductions within authored limits. Era
coverage can seed from validated authored metadata after disposable state loss.
SHA-256 source hashes distinguish absent, empty and changed era inputs. Present
malformed state, provenance or dangling links refuse. Neither operation rebuilds
history, calls models or grants observation success credit.

`renderWorkspaceMemory` returns era, recent reflections and unprocessed
observations using the public zone headings and live-block markers. A new silo
can return authored `MEMORY.md` alone. Cached mode omits wall-clock time and marks
500-codepoint reflection gists. Total note input is limited to 2 MiB and 1000
entries per directory. Output defaults to 2 MiB, or 9500 bytes for cached mode;
oversized complete output refuses rather than silently truncating. No memory
splice, inbox read, acknowledgement or cache refresh occurs.

`readWorkspacePersona` returns confined CORE text and a generic full-file read
wrapper. Missing CORE returns the wrapper alone; invalid present CORE refuses.
The assembled output has a caller-supplied byte bound, defaulting to 9500 bytes.

## Standalone packs and verification

After `pnpm build`, each pack has its own `workspace-foundation.js` and adjacent
`memory-tools/workspace-render.sh`. The Claude Code pack also has
`hooks/workspace-paths.sh`. Fixed commands are:

```sh
node dist/claude-code/workspace-foundation.js paths
node dist/claude-code/workspace-foundation.js render /absolute/workspace/silos/finch/memory --cached
node dist/claude-code/workspace-foundation.js persona finch
bash dist/claude-code/hooks/workspace-paths.sh
```

The environment must explicitly select a workspace. Successful paths output
contains only fixed shell-quoted assignments; callers must check success before
evaluating it. Missing helpers fail visibly. There is no source checkout, home,
package loader or download fallback. The CLI exposes no activation, repair,
replay, model, transport or arbitrary execution command.

Run `pnpm build` before `pnpm test` so package tests extract the actual bundles.
The normal build CORE guard remains active. Tests use fictional workspaces,
actual shell adapters, held-descriptor fault cases and isolated child processes.
Linux synthetic unsupported-platform checks do not constitute native macOS
acceptance. Docker installation and native macOS validation remain required CI
checks; local results and unavailable checks are recorded in the issue SPEC.
