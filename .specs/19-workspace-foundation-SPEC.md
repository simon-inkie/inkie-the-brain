# Workspace foundation

Issue: https://github.com/simon-inkie/inkie-the-brain/issues/19

Build an explicit, packaged workspace foundation: portable roots, confined reads and derived writes, authored memory precedence and bounded read-only memory/persona rendering. This slice supplies libraries and standalone helpers. Existing installed callers retain their legacy behaviour; complete workspace integration follows separately.

## Scope

New `core/workspace*.ts` foundation modules and `core/derived-state.ts`; standalone `cli/workspace-foundation.ts`; adjacent shell adapters; helper packaging in `scripts/build.mjs`; fictional workspace and packaging tests; `docs/workspace-foundation.md`. Preserve existing providers, weights, metadata, installation, configuration and legacy callers. Node builtins only, no new runtime dependency.

Workspace selection comes only from an external nonblank `WORKSPACE_ROOT`. Validate version-1 workspace metadata and declared roots before side effects. Environment files cannot switch modes or roots. Conflicting aliases fail visibly. Path lookup creates nothing.

Linux workspace operations require Node 22 and descriptor traversal/revalidation through procfs. Held descriptors, no-follow opens, type checks and canonical authorisation protect reads and owned derived writes. Preserve the original requested entry for dangling-link checks. Unsupported capabilities refuse before side effects. Legacy Linux/macOS support remains intact; native macOS workspace support is not claimed. This is not a hostile-process sandbox or a snapshot against concurrent in-place mutation.

Authored observer configuration and memory constrain disposable local state. Content hashes distinguish missing, empty and changed era inputs. Malformed present state/provenance is not first run. Preserve effective local hot-state reductions when authored targets are unchanged. Read-only operations must not refresh files or acknowledge progress.

Standalone operations are fixed `paths`, `render` and `persona` commands. Use adjacent packaged Node helpers; missing helpers fail visibly. No source-checkout, HOME, tsx or download fallback. No provider/store imports, model calls, inbox/wake operations, transport or observer pointer updates.

## Verification

Exercise real TypeScript and shell entrypoints on fictional workspaces: blank selection, schema/alias conflicts, relocation with unchanged identities, escaped and dangling links, FIFO/nonregular targets, held-descriptor failures, authored edits/deletions, read-only state and bounded Unicode rendering. Pin exact refusal and state preservation. Deliberately remove confinement/provenance guards to prove regressions fail after valid setup.

Build and extract each relevant pack into isolated renamed roots, hide source/sibling paths and execute the actual adjacent helpers. Preserve existing wrappers and settings-merge behaviour. Run frozen-lockfile install, build, authoritative typecheck, full tests, leak self-test/full scan and licence checks. Keep native and synthetic portability evidence distinct; record unavailable platform/installation checks honestly.

## Integration boundary

This foundation does not establish a usable replacement installation. Indexer configuration, optional inbox, observation completion and full installed executable closure require subsequent integration slices. No live runtime or settings change is included. Verification and review dispositions will be appended with the implementation.
