/** Linux descriptor primitives. No discovery or probing occurs on import.
 * These checks detect identity drift; they are not a hostile-process sandbox
 * or an immutable snapshot against concurrent in-place mutation.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync, fsyncSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export class WorkspaceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[workspace] ${code}: ${message}`);
    this.name = 'WorkspaceError';
  }
}
export type WorkspaceErrorCode = string;
export function fail(code: string, message: string): never { throw new WorkspaceError(code, message); }
export function inside(base: string, path: string, strict = false): boolean {
  return (!strict && path === base) || path.startsWith(base === '/' ? '/' : base + '/');
}
export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
export function entryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) { if (missing(e)) return false; throw e; }
}
/** Missing ordinary tails are allowed. Present dangling entries are invalid. */
export function canonicalLoose(path: string): string {
  const parts = resolve(path).split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    const next = join(current, part);
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) {
        try { current = realpathSync.native(next); }
        catch { fail('PATH_DANGLING', 'present link does not resolve'); }
      } else current = next;
    } catch (e) {
      if (!missing(e)) throw e;
      current = next;
    }
  }
  return current;
}
export function assertWorkspacePlatform(): void {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 22 ||
      !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK)
    fail('WORKSPACE_PLATFORM_UNSUPPORTED', 'workspace operations require Linux, Node 22 and procfs');
  let fd: number | undefined;
  let probeFd: number | undefined;
  try {
    fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (readlinkSync(`/proc/self/fd/${fd}`) !== '/' || !fstatSync(fd).isDirectory()) throw new Error();
    probeFd = openSync(`/proc/self/fd/${fd}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (readlinkSync(`/proc/self/fd/${probeFd}`) !== '/' || !sameIdentity(fstatSync(fd), fstatSync(probeFd))) throw new Error();
  } catch { fail('WORKSPACE_PLATFORM_UNSUPPORTED', 'descriptor revalidation through procfs is unavailable'); }
  finally { if (probeFd !== undefined) closeSync(probeFd); if (fd !== undefined) closeSync(fd); }
}
export type Authorise = (requested: string) => string;
export function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function revalidateHeld(fd: number, target: string, requested: string, authorise: Authorise): Stats {
  const st = fstatSync(fd);
  if (readlinkSync(`/proc/self/fd/${fd}`) !== target || authorise(requested) !== target ||
      !sameIdentity(st, lstatSync(target))) fail('WORKSPACE_IDENTITY_CHANGED', 'held target or original authorisation changed');
  return st;
}
export function openHeldSync(requested: string, authorise: Authorise, directory = false): { fd: number; target: string } {
  assertWorkspacePlatform();
  const target = authorise(requested);
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const parts = target.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = openSync(`/proc/self/fd/${fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW |
        constants.O_NONBLOCK | (i < parts.length - 1 || directory ? constants.O_DIRECTORY : 0));
      const old = fd; fd = next; closeSync(old);
    }
    const st = revalidateHeld(fd, target, requested, authorise);
    if (directory ? !st.isDirectory() : !st.isFile()) fail('WORKSPACE_FILE_TYPE', 'expected a regular file or directory');
    return { fd, target };
  } catch (e) { closeSync(fd); throw e; }
}
export function checkByteLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024)
    fail('WORKSPACE_LIMIT_INVALID', 'byte limit must be between 1 and 16777216');
}
export function readHeldFileSync(requested: string, authorise: Authorise, limit: number): { bytes: Buffer; info: Stats } {
  checkByteLimit(limit);
  const { fd, target } = openHeldSync(requested, authorise);
  try {
    if (fstatSync(fd).size > limit) fail('WORKSPACE_INPUT_LIMIT', 'file exceeds input byte limit');
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit - total + 1));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      total += n;
      if (total > limit) fail('WORKSPACE_INPUT_LIMIT', 'file grew beyond input byte limit');
      chunks.push(chunk.subarray(0, n));
    }
    const info = revalidateHeld(fd, target, requested, authorise);
    return { bytes: Buffer.concat(chunks, total), info };
  } finally { closeSync(fd); }
}
export function readHeldSync(requested: string, authorise: Authorise, limit: number): Buffer {
  return readHeldFileSync(requested, authorise, limit).bytes;
}
export function listHeldSync(requested: string, authorise: Authorise, limit = 1000): string[] {
  const { fd, target } = openHeldSync(requested, authorise, true);
  try {
    const dir = opendirSync(`/proc/self/fd/${fd}`); const names: string[] = [];
    try {
      for (;;) {
        const entry = dir.readSync(); if (!entry) break;
        if (names.length >= limit) fail('WORKSPACE_INPUT_LIMIT', 'directory exceeds entry limit');
        names.push(entry.name);
      }
    } finally { dir.closeSync(); }
    revalidateHeld(fd, target, requested, authorise);
    return names.sort();
  } finally { closeSync(fd); }
}
/** Create missing parents by descriptor-relative exclusive mkdir. Creation is
 * explicit, used only by derived writes, never by lookup/read operations. */
export function ensureParentSync(requested: string, authorise: Authorise): void {
  const target = authorise(requested); const parent = dirname(target);
  let cursor = parent; const tail: string[] = [];
  while (!entryExists(cursor)) { tail.unshift(cursor.slice(dirname(cursor).length + (dirname(cursor) === '/' ? 0 : 1))); cursor = dirname(cursor); }
  let { fd, target: heldPath } = openHeldSync(cursor, (p) => { authorise(requested); return canonicalLoose(p); }, true);
  try {
    for (const part of tail) {
      if (authorise(requested) !== target) fail('WORKSPACE_IDENTITY_CHANGED', 'write parent changed');
      revalidateHeld(fd, heldPath, heldPath, canonicalLoose);
      try { mkdirSync(`/proc/self/fd/${fd}/${part}`, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const old = fd; fd = next; closeSync(old); heldPath = join(heldPath, part);
    }
    revalidateHeld(fd, parent, parent, (p) => { authorise(requested); return canonicalLoose(p); });
  } finally { closeSync(fd); }
}
/** Owned atomic replacement. An uncertain post-rename sync is reported; old
 * generations are never restored. Cleanup can remove only our temporary inode. */
export function atomicDerivedSync(requested: string, bytes: Uint8Array | null, authorise: Authorise): void {
  assertWorkspacePlatform();
  const target = authorise(requested);
  let before: Stats | undefined;
  if (entryExists(requested)) {
    before = lstatSync(target);
    if (!before.isFile()) fail('WORKSPACE_FILE_TYPE', 'derived target must be a regular file');
  }
  if (bytes === null && !before) return;
  ensureParentSync(requested, authorise);
  const parent = dirname(target);
  const { fd: parentFd } = openHeldSync(parent, (p) => { authorise(requested); return canonicalLoose(p); }, true);
  const leaf = target.slice(parent.length + 1);
  const temp = `/proc/self/fd/${parentFd}/.workspace-${randomUUID()}.tmp`;
  let tempFd: number | undefined; let owned: Stats | undefined; let renamed = false;
  try {
    if (bytes !== null) {
      tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      owned = fstatSync(tempFd);
      if (!owned.isFile()) fail('WORKSPACE_FILE_TYPE', 'temporary target is not regular');
      let offset = 0;
      while (offset < bytes.length) { const n = writeSync(tempFd, bytes, offset, bytes.length - offset); if (!n) throw new Error('short write'); offset += n; }
      fsyncSync(tempFd);
    }
    revalidateHeld(parentFd, parent, parent, (p) => { authorise(requested); return canonicalLoose(p); });
    if (authorise(requested) !== target) fail('WORKSPACE_IDENTITY_CHANGED', 'original write target changed');
    const current = entryExists(target) ? lstatSync(target) : undefined;
    if (before ? !current || !sameIdentity(before, current) : current !== undefined)
      fail('WORKSPACE_IDENTITY_CHANGED', 'derived target changed before replacement');
    if (bytes === null) unlinkSync(`/proc/self/fd/${parentFd}/${leaf}`);
    else {
      if (!owned || !sameIdentity(owned, lstatSync(temp))) fail('WORKSPACE_IDENTITY_CHANGED', 'temporary inode changed');
      renameSync(temp, `/proc/self/fd/${parentFd}/${leaf}`);
    }
    renamed = true;
    try { fsyncSync(parentFd); }
    catch { fail('WORKSPACE_WRITE_UNCERTAIN', 'replacement occurred but parent sync failed'); }
  } finally {
    if (tempFd !== undefined) closeSync(tempFd);
    try {
      if (!renamed && owned && entryExists(temp) && sameIdentity(owned, lstatSync(temp))) unlinkSync(temp);
    } finally { closeSync(parentFd); }
  }
}
