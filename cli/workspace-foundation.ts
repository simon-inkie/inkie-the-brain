#!/usr/bin/env node
/** Fixed private-to-process entrypoint for standalone packaged adapters. */
import { loadWorkspace, WORKSPACE_PATH_NAMES } from '../core/workspace.js';
import { fail } from '../core/workspace-fs.js';
import { renderWorkspaceMemory, resolveWorkspaceMemoryDir } from '../core/workspace-memory.js';
import { readWorkspacePersona } from '../core/workspace-persona.js';
const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
async function main():Promise<void> {
  const [op,...args]=process.argv.slice(2);
  if (!['paths','render','persona'].includes(op)) fail('WORKSPACE_OPERATION_INVALID','expected paths, render or persona');
  const ws=loadWorkspace(); if (!ws) fail('WORKSPACE_REQUIRED','nonblank external WORKSPACE_ROOT is required');
  let output:string;
  if (op==='paths') {
    if (args.length) fail('WORKSPACE_OPERATION_INVALID','paths accepts no arguments');
    output=[['WORKSPACE_MODE','workspace'],['WORKSPACE_ROOT_REAL',ws.root],['WORKSPACE_ID',ws.workspaceId],
      ...WORKSPACE_PATH_NAMES.map(n=>['WORKSPACE_'+n.toUpperCase(),ws.paths[n]]),
      ['WORKSPACE_BRAIN_LOCAL',ws.localBrain],['WORKSPACE_BRAIN_LOGS',ws.logsDir],['WORKSPACE_BRAIN_INDEX',ws.indexDir]]
      .map(([key,value])=>`${key}=${quote(value)}`).join('\n')+'\n';
  } else if (op==='persona') {
    if (args.length!==1) fail('WORKSPACE_OPERATION_INVALID','persona requires one agent ID');
    output=await readWorkspacePersona(ws,args[0],{maxOutputBytes:9500});
  } else {
    if (args.length>2 || (args[1]!==undefined && args[1]!=='--cached')) fail('WORKSPACE_OPERATION_INVALID','render accepts a memory path and optional --cached');
    const memory=args[0]??resolveWorkspaceMemoryDir(ws,process.cwd());
    output=await renderWorkspaceMemory(ws,memory,{cached:args[1]==='--cached'});
  }
  process.stdout.write(output);
}
main().catch(error=>{
  // Do not leak external paths, file contents or raw filesystem diagnostics.
  const code=typeof error?.code==='string'?error.code:'WORKSPACE_OPERATION_FAILED';
  process.stderr.write(`[workspace] ${code}: foundation operation refused\n`); process.exitCode=2;
});
