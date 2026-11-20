/** Explicit version-1 workspace resolution. Node builtins only, no import effects. */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalLoose, fail, inside, readHeldSync, assertWorkspacePlatform, WorkspaceError } from './workspace-fs.js';
export { WorkspaceError, assertWorkspacePlatform };
export type { WorkspaceErrorCode } from './workspace-fs.js';
export const WORKSPACE_MANIFEST = 'workspace.json';
export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_PATH_NAMES = ['agents','brain','silos','inbox','projects','attachments','plugins','local'] as const;
export type WorkspacePathName = typeof WORKSPACE_PATH_NAMES[number];
export interface Workspace {
  root: string; requestedRoot: string; rootIdentity: { dev:number; ino:number }; workspaceId: string;
  paths: Record<WorkspacePathName, string>; declaredPaths: Record<string, string>;
  externalReadOnlyEnv: string[]; localBrain: string; logsDir: string; indexDir: string;
  localDeck: string; cacheDir: string; cronStateDir: string; env: NodeJS.ProcessEnv;
}
export function isWorkspaceMode(env: NodeJS.ProcessEnv = process.env): boolean { return !!env.WORKSPACE_ROOT?.trim(); }
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value) fail('PATH_EMPTY','declared paths must be nonempty strings');
  if (value.includes('\0') || value.includes('\\')) fail('PATH_INVALID_CHARS','NUL and backslash are forbidden');
  if (isAbsolute(value)) fail('PATH_ABSOLUTE','declared paths must be relative');
  if (value.split('/').some(p => p === '.' || p === '..')) fail('PATH_TRAVERSAL','dot traversal is forbidden');
  if (value.split('/').some(p => !p)) fail('PATH_EMPTY','empty segments are forbidden');
  return value;
}
export function validateWorkspaceIdentity(ws: Workspace): void {
  if (canonicalLoose(ws.requestedRoot) !== ws.root) fail('WORKSPACE_IDENTITY_CHANGED','selected root changed');
  const rootInfo = statSync(ws.root);
  if (rootInfo.dev !== ws.rootIdentity.dev || rootInfo.ino !== ws.rootIdentity.ino)
    fail('WORKSPACE_IDENTITY_CHANGED','selected root inode changed');
  for (const [name, rel] of Object.entries(ws.declaredPaths)) {
    const path = canonicalLoose(join(ws.root, rel));
    if (!inside(ws.root,path) || (name in ws.paths && path !== ws.paths[name as WorkspacePathName]))
      fail('WORKSPACE_IDENTITY_CHANGED','declared root changed');
  }
  for (const path of [ws.localBrain,ws.logsDir,ws.indexDir,ws.localDeck,ws.cacheDir,ws.cronStateDir]) {
    if (canonicalLoose(path) !== path || !inside(ws.paths.local,path,true))
      fail('WORKSPACE_IDENTITY_CHANGED','derived root changed');
  }
}
export function workspaceRootAliases(ws: Workspace): Record<string,string> {
  return { INBOX_ROOT:ws.paths.inbox, ATTACHMENTS_ROOT:ws.paths.attachments, PROJECTS_ROOT:ws.paths.projects,
    DATA_ROOT:ws.localDeck, AGENTS_ROOT:ws.paths.agents, AGENTS_HOME:ws.paths.agents,
    BRAIN_VAULT_DIR:ws.paths.brain, BRAIN_STATE_DIR:ws.indexDir };
}
export function validateWorkspaceAliases(ws: Workspace, env: NodeJS.ProcessEnv): void {
  for (const [name, expected] of Object.entries(workspaceRootAliases(ws))) {
    const raw = env[name]?.trim(); if (!raw) continue;
    if (!isAbsolute(raw) || canonicalLoose(raw) !== expected) fail('LEGACY_ENV_CONFLICT',`${name} conflicts with the declared root`);
  }
  for (const name of ['BRAIN_MESSAGE_INDEX_STATE','BRAIN_ASSET_INDEX_STATE','BRAIN_INDEX_STATE']) {
    const raw = env[name]?.trim(); if (!raw) continue;
    if (!isAbsolute(raw) || !inside(ws.indexDir,canonicalLoose(raw),true)) fail('LEGACY_ENV_CONFLICT',`${name} must be strictly inside indexDir`);
  }
}
export function loadWorkspace(env: NodeJS.ProcessEnv = process.env): Workspace | null {
  const requestedRoot = env.WORKSPACE_ROOT?.trim(); if (!requestedRoot) return null;
  assertWorkspacePlatform();
  if (!isAbsolute(requestedRoot)) fail('ROOT_NOT_ABSOLUTE','WORKSPACE_ROOT must be absolute');
  let root: string;
  try { root = realpathSync.native(requestedRoot); if (!statSync(root).isDirectory()) throw new Error(); }
  catch { fail('ROOT_MISSING','selected root is not an existing directory'); }
  const rootInfo=statSync(root);
  const manifestAuthorise = (p: string) => {
    if (canonicalLoose(requestedRoot) !== root) fail('WORKSPACE_IDENTITY_CHANGED','selected root changed');
    const now=statSync(root);
    if (now.dev!==rootInfo.dev || now.ino!==rootInfo.ino) fail('WORKSPACE_IDENTITY_CHANGED','selected root inode changed');
    const target = canonicalLoose(p);
    if (!inside(root,target,true)) fail('PATH_ESCAPES_ROOT','manifest escapes selected root');
    return target;
  };
  let text: string;
  try { text = readHeldSync(join(requestedRoot,WORKSPACE_MANIFEST),manifestAuthorise,256*1024).toString('utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('MANIFEST_MISSING','workspace.json is missing'); throw e; }
  let m: Record<string,unknown>;
  try { m = JSON.parse(text); }
  catch { fail('MANIFEST_INVALID_JSON','workspace.json must contain valid JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('MANIFEST_INVALID_JSON','manifest must be an object');
  if (m.schemaVersion !== 1) fail('SCHEMA_VERSION_UNSUPPORTED','schemaVersion must be integer 1');
  if (typeof m.workspaceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.workspaceId))
    fail('WORKSPACE_ID_INVALID','workspaceId must be a lowercase canonical UUID');
  if (!m.paths || typeof m.paths !== 'object' || Array.isArray(m.paths)) fail('MANIFEST_INVALID_JSON','paths must be an object');
  const external = m.externalReadOnlyEnv ?? [];
  if (!Array.isArray(external) || !external.every(n=>typeof n==='string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)))
    fail('MANIFEST_INVALID_JSON','externalReadOnlyEnv must contain variable names');
  const declared = m.paths as Record<string,unknown>; const declaredPaths: Record<string,string> = Object.create(null);
  for (const name of [...new Set([...WORKSPACE_PATH_NAMES,...Object.keys(declared)])]) declaredPaths[name] = relativePath(declared[name]);
  const paths = Object.create(null) as Record<WorkspacePathName,string>; const seen = new Set<string>();
  for (const [name,rel] of Object.entries(declaredPaths)) {
    const path = canonicalLoose(join(root,rel));
    if (!inside(root,path,true)) fail('PATH_ESCAPES_ROOT','declared path escapes root');
    if (seen.has(path)) fail('PATH_DUPLICATE','declared paths share a canonical target');
    seen.add(path); if ((WORKSPACE_PATH_NAMES as readonly string[]).includes(name)) paths[name as WorkspacePathName] = path;
  }
  const derive = (...parts:string[]) => {
    const path = canonicalLoose(join(paths.local,...parts));
    if (!inside(paths.local,path,true)) fail('PATH_ESCAPES_ROOT','derived root escapes local');
    return path;
  };
  const ws: Workspace = { root,requestedRoot,rootIdentity:{dev:rootInfo.dev,ino:rootInfo.ino},workspaceId:m.workspaceId,paths,declaredPaths,externalReadOnlyEnv:[...external],env:{...env},
    localBrain:derive('brain'),logsDir:derive('brain','logs'),indexDir:derive('brain','index'),
    localDeck:derive('deck'),cacheDir:derive('brain','cache'),cronStateDir:derive('brain','state','cron') };
  validateWorkspaceAliases(ws,env); return ws;
}
export function resolveWorkspaceWrite(ws: Workspace,candidate:string,opts:{within?:string} = {}): string {
  validateWorkspaceIdentity(ws);
  if (!candidate || candidate.includes('\0') || candidate.includes('\\')) fail('WRITE_OUTSIDE_WORKSPACE','invalid write path');
  const target = canonicalLoose(resolve(ws.root,candidate)); const base = canonicalLoose(opts.within ?? ws.root);
  if (!inside(ws.root,base) || !inside(base,target,true)) fail('WRITE_OUTSIDE_WORKSPACE','write is outside the permitted subtree');
  return target;
}
export function resolveWorkspaceRead(ws: Workspace,candidate:string): string {
  validateWorkspaceIdentity(ws);
  if (!candidate || candidate.includes('\0') || candidate.includes('\\')) fail('EXTERNAL_READ_NOT_DECLARED','invalid read path');
  const target = canonicalLoose(resolve(ws.root,candidate));
  if (inside(ws.root,target)) return target;
  for (const name of ws.externalReadOnlyEnv) {
    const raw=ws.env[name]?.trim();
    if (raw && isAbsolute(raw) && inside(canonicalLoose(raw),target)) return target;
  }
  fail('EXTERNAL_READ_NOT_DECLARED','outside read lacks a declared external variable');
}
export function externalReadPath(ws: Workspace,name:string): string | null {
  if (!ws.externalReadOnlyEnv.includes(name) || !ws.env[name]?.trim()) return null;
  return resolveWorkspaceRead(ws,ws.env[name]!.trim());
}
export function workspaceAgentPaths(ws: Workspace,name:string) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) fail('PATH_INVALID_CHARS','invalid agent name');
  const siloRoot=resolveWorkspaceWrite(ws,join(ws.paths.silos,name),{within:ws.paths.silos});
  return {personaDir:resolveWorkspaceWrite(ws,join(ws.paths.agents,name),{within:ws.paths.agents}),siloRoot,
    memoryDir:resolveWorkspaceWrite(ws,join(siloRoot,'memory'),{within:ws.paths.silos}),inboxDir:join(ws.paths.inbox,name,'inbox')};
}
