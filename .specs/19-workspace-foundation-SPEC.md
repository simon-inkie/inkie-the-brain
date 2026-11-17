# Workspace foundation

Issue: #19

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

### Local candidate receipt

Verified on Linux x64 with Node 22.23.2 and pnpm 9.15.0. The candidate is frozen for independent review; these results do not constitute
approval or complete installed workspace acceptance.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed using an isolated dependency store; package and lockfile unchanged |
| `pnpm build` | Passed on corrected source, including the normal CORE guard |
| `pnpm typecheck` | Passed on corrected source |
| `pnpm test` | 537 passed across 43 files, including 73 new tests across 8 files |
| Guard sensitivity | Three deliberate guard removals failed at the intended assertions; exact source restored |
| Extracted packs | Actual plugin, hooks and Claude Code helpers passed with source and network access blocked |
| Installer compatibility | Actual isolated dry run and repeated settings merge passed; unrelated hooks retained |
| `pnpm check:leaks:self-test` | Passed |
| `pnpm check:leaks` | Passed |
| `pnpm check:licence` | Passed |
| Docker installation checks | Not run: separate environment and authorised embedding credentials required |
| Native macOS checks | Not run: no native host available; synthetic refusal tests are not native acceptance |

All 48 public additions and the existing licence/privacy changes remain intact.
Existing configuration, installed callers, providers and installer wiring are
unchanged. Required CI, clean committed-tree verification and an independent
maintainer review remain outstanding.

## Integration boundary

This foundation does not establish a usable replacement installation. Indexer configuration, optional inbox, observation completion and full installed executable closure require subsequent integration slices. No live runtime or settings change is included. Verification and review dispositions will be appended with the implementation.

## Log

### 2026-11-17: Foundation implementation started

Verified the authorised branch is clean and the public base is current. Implementing explicit-call libraries with a shared descriptor primitive, fixed standalone commands and adjacent bundles. Existing caller and configuration files remain outside this change. Verification is pending; this candidate will remain uncommitted for maintainer handling.

### 2026-11-17: Corrected foundation candidate verified

Implemented the eight foundation modules, fixed standalone operations, two shell
adapters, adjacent bundles in all three packs and public documentation. Tests
found a missing selected-root inode check; corrected it before final verification.
Review also corrected final-file symlink writes to hold the resolved target's
parent and narrowed derived-state read reauthorisation to local state throughout
acquisition. A failed multi-file era refresh drops provenance before replacement,
so incomplete generations cannot certify coverage. Unchanged authored era inputs
retain valid local compression and effective hot-state reductions.

The corrected build, typecheck, full suite, leak and licence gates pass. Confinement, provenance and
temporary-inode cleanup controls were individually removed to prove their
regressions fail, then restored exactly. No installed workspace wiring or live
operation is included. Publication and independent review are not performed by
this candidate builder.

### 2026-11-17: Candidate frozen for independent review

Confirmed the final source and packaged artifact bindings against the builder
receipts. The executable source is unchanged from the passing local gates.
Only this status wording changed after handoff. Clean committed-tree checks,
independent review and required platform CI remain outstanding.
