import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadWorkspace, WORKSPACE_PATH_NAMES, type Workspace } from '../../core/workspace.js';
export function fixture() {
  const base=mkdtempSync(join(tmpdir(),'brain-foundation-')); const root=join(base,"space 'quoted'"); mkdirSync(root);
  const paths=Object.fromEntries(WORKSPACE_PATH_NAMES.map(n=>[n,n==='local'?'device':n]));
  const manifest={schemaVersion:1,workspaceId:'a1111111-2222-4333-8444-555555555555',paths,externalReadOnlyEnv:[] as string[]};
  const save=()=>writeFileSync(join(root,'workspace.json'),JSON.stringify(manifest)); save();
  const env:NodeJS.ProcessEnv={WORKSPACE_ROOT:root,HOME:join(base,'fictional-home')};
  const ws=()=>loadWorkspace(env)!;
  const memory=join(root,'silos','finch','memory');
  const put=(name:string,text:string)=>{const p=join(memory,name);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);return p;};
  const putPath=(p:string,text:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);return p;};
  const clean=()=>rmSync(base,{recursive:true,force:true});
  return {base,root,manifest,save,env,ws,memory,put,putPath,clean};
}
export type Fixture=ReturnType<typeof fixture>;
export function errorCode(fn:()=>unknown):string {try{fn();return 'NO_ERROR';}catch(e){return (e as {code:string}).code;}}
export function localPath(ws:Workspace,memory:string,name:string):string {
  return join(ws.localBrain,'state','silos',memory.slice(ws.paths.silos.length+1),name);
}
