import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkspace } from '../../core/workspace.js';
import { fixture, errorCode, type Fixture } from './fixtures.js';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const modules=['workspace','workspace-read','workspace-fs','workspace-env','derived-state','workspace-derived','workspace-memory','workspace-persona'];
let f:Fixture|undefined;afterEach(()=>f?.clean());
async function bundle(){
 const result=await build({stdin:{contents:modules.map((n,i)=>`export * as api${i} from './core/${n}.ts';`).join('\n'),resolveDir:repo},bundle:true,platform:'node',format:'esm',target:'node22',write:false,metafile:true});
 return result;
}
describe('import and read isolation',()=>{
 it.runIf(process.platform!=='linux')('native unsupported platform refuses explicit workspace selection',()=>{
   expect(errorCode(()=>loadWorkspace({WORKSPACE_ROOT:'/fictional/unsupported-workspace'}))).toBe('WORKSPACE_PLATFORM_UNSUPPORTED');
 });
 it('imports only foundation modules and Node builtins, with zero import-time IO/network',async()=>{
   const result=await bundle();expect(Object.keys(result.metafile!.inputs).filter(p=>p!=='<stdin>').every(p=>modules.some(n=>p===`core/${n}.ts`))).toBe(true);
   for(const out of Object.values(result.metafile!.outputs))expect(out.imports.every(i=>i.path.startsWith('node:'))).toBe(true);
   const url='data:text/javascript;base64,'+Buffer.from(result.outputFiles![0].text).toString('base64');
   const program="import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; let calls=0; for(const k of ['openSync','readFileSync','mkdirSync','writeFileSync','renameSync','unlinkSync']) fs[k]=()=>{calls++;throw Error('unexpected IO')}; syncBuiltinESMExports(); globalThis.fetch=()=>{throw Error('network')}; const api=await import(process.argv[1]); if(api.api0.loadWorkspace({WORKSPACE_ROOT:' '})!==null)throw Error('blank mode'); console.log(calls);";
   expect(execFileSync(process.execPath,['--input-type=module','-e',program,url],{env:{PATH:process.env.PATH},encoding:'utf8'}).trim()).toBe('0');
 });
 it.runIf(process.platform==='linux')('real read-only operations have zero writes and network calls in a fresh process',async()=>{
   f=fixture();f.put('reflections/2026-05-01.md','fictional reflection');const result=await bundle();const url='data:text/javascript;base64,'+Buffer.from(result.outputFiles![0].text).toString('base64');
   const program="import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module'; let writes=0; for(const k of ['mkdirSync','writeFileSync','renameSync','unlinkSync']) fs[k]=()=>{writes++;throw Error('write')}; for(const m of [http,https]){m.request=()=>{throw Error('network')};m.get=m.request;} net.connect=()=>{throw Error('network')}; globalThis.fetch=()=>{throw Error('network')};syncBuiltinESMExports(); const api=await import(process.argv[1]); const ws=api.api0.loadWorkspace(); const text=await api.api6.renderWorkspaceMemory(ws,process.argv[2],{cached:true}); await api.api7.readWorkspacePersona(ws,'finch'); api.api3.loadFoundationEnv(); if(!text.includes('fictional reflection')) throw Error('missing rendering');console.log(writes);";
   expect(execFileSync(process.execPath,['--input-type=module','-e',program,url,f.memory],{env:{PATH:process.env.PATH,...f.env},encoding:'utf8'}).trim()).toBe('0');
 });
 it('synthetic unsupported-platform refusal precedes filesystem effects',async()=>{
   const result=await bundle();const url='data:text/javascript;base64,'+Buffer.from(result.outputFiles![0].text).toString('base64');
   const program="import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const api=await import(process.argv[1]);let calls=0; for(const k of ['openSync','readFileSync','mkdirSync','lstatSync','statSync','realpathSync','writeFileSync','renameSync','unlinkSync']) fs[k]=()=>{calls++;throw Error('IO')};syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'darwin'});try{api.api0.loadWorkspace({WORKSPACE_ROOT:'/fictional/unsupported-workspace'});throw Error('accepted');}catch(e){console.log(e.code,calls);}";
   expect(execFileSync(process.execPath,['--input-type=module','-e',program,url],{env:{PATH:process.env.PATH},encoding:'utf8'}).trim()).toBe('WORKSPACE_PLATFORM_UNSUPPORTED 0');
 });
});
