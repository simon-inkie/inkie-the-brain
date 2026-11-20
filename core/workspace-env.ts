import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadWorkspace, resolveWorkspaceRead, validateWorkspaceAliases, workspaceRootAliases, type Workspace } from './workspace.js';
import { canonicalLoose, fail, missing } from './workspace-fs.js';
import { readWorkspaceTextSync } from './workspace-read.js';
export interface FoundationEnv { workspace:Workspace|null; values:NodeJS.ProcessEnv; warnings:string[] }
/** Public TypeScript line syntax and empty-value treatment are intentional.
 * Shell empty-variable semantics remain a separate caller integration concern. */
function entries(text:string):Array<[string,string]> {
  return text.split('\n').flatMap(line=>{const m=line.match(/^([^#]\w*)=(.+)$/); return m?[[m[1],m[2].trim()] as [string,string]]:[];});
}
export function loadFoundationEnv(env:NodeJS.ProcessEnv=process.env):FoundationEnv {
  const workspace=loadWorkspace(env); const values={...env}; const warnings:string[]=[];
  const home=env.HOME || homedir();
  const candidates=workspace ? (env.BRAIN_ENV_FILE?.trim()?[env.BRAIN_ENV_FILE.trim()]:[]) :
    [env.BRAIN_ENV_FILE,resolve(home,'.the-brain','.env'),resolve(home,'io-data','.env')].filter((p):p is string=>!!p);
  if (workspace && candidates.length && !workspace.externalReadOnlyEnv.includes('BRAIN_ENV_FILE'))
    fail('EXTERNAL_READ_NOT_DECLARED','BRAIN_ENV_FILE must be declared, including in-root files');
  for (const path of candidates) {
    let text:string;
    try { text=workspace?readWorkspaceTextSync(workspace,path,256*1024):readFileSync(path,'utf8'); }
    catch(e) {
      const code=(e as NodeJS.ErrnoException).code;
      if (!workspace) continue;
      if (missing(e) || code==='EACCES' || code==='EPERM') {warnings.push('Declared environment file unavailable; retaining caller values'); continue;}
      throw e;
    }
    const lines=entries(text);
    if (workspace) {
      const aliases=workspaceRootAliases(workspace);
      for (const [name,value] of lines) {
        if (!value) continue;
        if (name==='WORKSPACE_ROOT' && canonicalLoose(value)!==workspace.root) fail('LEGACY_ENV_CONFLICT','file cannot change WORKSPACE_ROOT');
        if (name==='WORKSPACE_MODE' && value!=='workspace') fail('LEGACY_ENV_CONFLICT','file cannot change workspace mode');
        if (name==='BRAIN_ENV_FILE' && resolveWorkspaceRead(workspace,value)!==resolveWorkspaceRead(workspace,path))
          fail('LEGACY_ENV_CONFLICT','file cannot change its selector');
        if (name in aliases || ['BRAIN_MESSAGE_INDEX_STATE','BRAIN_ASSET_INDEX_STATE','BRAIN_INDEX_STATE'].includes(name))
          validateWorkspaceAliases(workspace,{[name]:value});
      }
    }
    for (const [name,value] of lines) {
      if (name==='WORKSPACE_ROOT' || name==='WORKSPACE_MODE') continue;
      if (!values[name]) values[name]=value;
    }
  }
  if (workspace) validateWorkspaceAliases(workspace,values);
  return {workspace,values,warnings};
}
/** Mutation is a separate explicit choice after all entries validate. */
export function applyFoundationEnv(result:FoundationEnv,target:NodeJS.ProcessEnv=process.env):void {
  if (result.workspace) validateWorkspaceAliases(result.workspace,result.values);
  Object.assign(target,result.values);
}
