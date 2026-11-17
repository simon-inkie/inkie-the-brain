import { join } from 'node:path';
import { workspaceAgentPaths, resolveWorkspaceWrite, type Workspace } from './workspace.js';
import { entryExists, readHeldSync, checkByteLimit, fail } from './workspace-fs.js';
/** Generic wrapper refers only to declared workspace persona files. */
export function workspacePersonaWrapper(ws:Workspace,agentId:string):string {
  const {personaDir}=workspaceAgentPaths(ws,agentId);
  return ['Read the full persona files before responding:',join(ws.paths.agents,'SYSTEM.md'),join(ws.paths.agents,'ROSTER.md'),
    ...['SOUL.md','IDENTITY.md','TOOLS.md','USER.md'].map(n=>join(personaDir,n)),
    'The CORE is a summary; the full files provide the detail.'].join('\n');
}
export async function readWorkspacePersona(ws:Workspace,agentId:string,opts:{maxOutputBytes:number}={maxOutputBytes:9500}):Promise<string> {
  checkByteLimit(opts.maxOutputBytes);
  const {personaDir}=workspaceAgentPaths(ws,agentId); const requested=join(personaDir,'CORE.md');
  const authorise=(p:string)=>resolveWorkspaceWrite(ws,p,{within:ws.paths.agents});
  authorise(requested);
  const core=entryExists(requested)?readHeldSync(requested,authorise,opts.maxOutputBytes).toString('utf8').replace(/\n+$/,''):null;
  const text=(core===null?'':core+'\n\n')+workspacePersonaWrapper(ws,agentId)+'\n';
  if (Buffer.byteLength(text)>opts.maxOutputBytes) fail('WORKSPACE_OUTPUT_LIMIT','assembled persona exceeds byte limit');
  return text;
}
