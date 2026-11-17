import { closeSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { resolveWorkspaceRead, resolveWorkspaceWrite, type Workspace } from './workspace.js';
import { readHeldSync, openHeldSync, revalidateHeld, listHeldSync, atomicDerivedSync } from './workspace-fs.js';
/** Return a retained async descriptor; reacquisition uses the checked descriptor,
 * never the original pathname. Revalidate the original request after acquisition. */
export async function openWorkspaceRead(ws:Workspace,requested:string,directory=false):Promise<FileHandle> {
  const original=resolve(ws.root,requested); const authorise=(p:string)=>resolveWorkspaceRead(ws,p);
  const {fd,target}=openHeldSync(original,authorise,directory);
  try {
    const handle=await open(`/proc/self/fd/${fd}`, 'r');
    try { revalidateHeld(handle.fd,target,original,authorise); return handle; }
    catch(e) { await handle.close(); throw e; }
  } finally { closeSync(fd); }
}
export function readWorkspaceBytesSync(ws:Workspace,requested:string,maxInputBytes=2*1024*1024):Buffer {
  return readHeldSync(resolve(ws.root,requested),p=>resolveWorkspaceRead(ws,p),maxInputBytes);
}
export function readWorkspaceTextSync(ws:Workspace,requested:string,maxInputBytes=2*1024*1024):string {
  return readWorkspaceBytesSync(ws,requested,maxInputBytes).toString('utf8');
}
export async function readWorkspaceText(ws:Workspace,requested:string,maxInputBytes=2*1024*1024):Promise<string> {
  return readWorkspaceTextSync(ws,requested,maxInputBytes);
}
export function listWorkspaceDirectory(ws:Workspace,requested:string,limit=1000):string[] {
  return listHeldSync(resolve(ws.root,requested),p=>resolveWorkspaceRead(ws,p),limit);
}
export async function writeWorkspaceDerived(ws:Workspace,requested:string,bytes:Uint8Array|string):Promise<void> {
  atomicDerivedSync(resolve(ws.root,requested),typeof bytes==='string'?Buffer.from(bytes):bytes,p=>resolveWorkspaceWrite(ws,p,{within:ws.localBrain}));
}
export async function removeWorkspaceDerived(ws:Workspace,requested:string):Promise<void> {
  atomicDerivedSync(resolve(ws.root,requested),null,p=>resolveWorkspaceWrite(ws,p,{within:ws.localBrain}));
}
/** Narrow authored read, even when another external/root read is declared. */
export function readWorkspaceMemoryBytes(ws:Workspace,memory:string,name:string,limit:number):Buffer {
  const requested=join(memory,name);
  resolveWorkspaceWrite(ws,requested,{within:memory});
  return readHeldSync(requested,p=>resolveWorkspaceWrite(ws,p,{within:memory}),limit);
}
