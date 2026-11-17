import { join, relative } from 'node:path';
import { resolveWorkspaceWrite, type Workspace } from './workspace.js';
import { fail } from './workspace-fs.js';
export const DERIVED_MEMORY_LEAVES = ['live-state.json','observer-state.json','era-summary.md','era-summary.meta.json','era-authored-provenance.json','rendered-MEMORY.md'] as const;
export function assertDerivedMemoryLeaf(name:string):void {
  if (!(DERIVED_MEMORY_LEAVES as readonly string[]).includes(name)) fail('WORKSPACE_STATE_INVALID','unsupported derived leaf');
}
/** Pure lookup. A resolved path does not grant write authority. */
export function derivedMemoryPaths(memoryDir:string,name:string,ws?:Workspace):{requested:string;resolved:string} {
  assertDerivedMemoryLeaf(name);
  if (!ws) { const requested=join(memoryDir,name); return {requested,resolved:requested}; }
  const memory=resolveWorkspaceWrite(ws,memoryDir,{within:ws.paths.silos});
  const requested=join(ws.localBrain,'state','silos',relative(ws.paths.silos,memory),name);
  return {requested,resolved:resolveWorkspaceWrite(ws,requested,{within:ws.localBrain})};
}
export function derivedMemoryPath(memoryDir:string,name:string,ws?:Workspace):string { return derivedMemoryPaths(memoryDir,name,ws).resolved; }
