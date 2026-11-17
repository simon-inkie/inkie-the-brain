import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture, type Fixture } from '../workspace/fixtures.js';
const repo=fileURLToPath(new URL('../../',import.meta.url));
/** These tests consume actual build output. Run pnpm build before pnpm test. */
describe('standalone extracted workspace packs',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>f.clean());
 const extract=(name:string)=>{
   const source=join(repo,'dist',name);expect(existsSync(join(source,'workspace-foundation.js')),'pnpm build is required before package tests').toBe(true);
   const archive=join(f.base,'pack.tar');execFileSync('tar',['-cf',archive,'-C',source,'.']);const pack=join(f.base,'renamed-pack');mkdirSync(pack);execFileSync('tar',['-xf',archive,'-C',pack]);return pack;
 };
 const childEnv=()=>{
   const bin=join(f.base,'isolated-bin');mkdirSync(bin,{recursive:true});
   for(const [name,path] of [['node',process.execPath],['dirname','/usr/bin/dirname']])if(!existsSync(join(bin,name)))symlinkSync(path,join(bin,name));
   const guard=f.putPath(join(f.base,'deny-source.cjs'),`const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');
const forbidden=process.env.BRAIN_FORBIDDEN_SOURCE; const reject=p=>{if(typeof p==='string' && (p===forbidden || p.startsWith(forbidden+'/')))throw Error('source unavailable');};
for(const key of ['readFileSync','openSync']){const old=fs[key];fs[key]=function(p,...args){reject(p);return old.call(this,p,...args);};}
for(const key of ['readFile','open']){const old=fs.promises[key];fs.promises[key]=async function(p,...args){reject(p);return old.call(this,p,...args);};}
for(const name of ['http','https']){const api=require('node:'+name);api.get=api.request=()=>{throw Error('network forbidden');};}require('node:net').connect=()=>{throw Error('network forbidden');};globalThis.fetch=()=>{throw Error('network forbidden');};syncBuiltinESMExports();`);
   return {...f.env,PATH:bin,BRAIN_FORBIDDEN_SOURCE:repo.replace(/\/$/,''),NODE_OPTIONS:'--require='+guard};
 };
 for(const name of ['plugin','hooks','claude-code'])it.runIf(process.platform==='linux')(`executes the actual ${name} helper with source, sibling packs and package loaders unavailable`,()=>{
   const pack=extract(name);f.put('reflections/2026-05-01.md','packaged fictional note');f.putPath(join(f.root,'agents','finch','CORE.md'),'Packaged Finch');const env=childEnv();
   expect(existsSync(join(pack,'templates','RECALL-INSTRUCTIONS.md'))).toBe(true);
   const render=spawnSync('/bin/bash',[join(pack,'memory-tools','workspace-render.sh'),f.memory,'--cached'],{env,cwd:f.base,encoding:'utf8'});expect(render.status,render.stderr).toBe(0);expect(render.stdout).toContain('packaged fictional note');
   const persona=spawnSync(process.execPath,[join(pack,'workspace-foundation.js'),'persona','finch'],{env,cwd:f.base,encoding:'utf8'});expect(persona.status,persona.stderr).toBe(0);expect(persona.stdout).toContain('Packaged Finch');
   expect(existsSync(join(f.root,'device'))).toBe(false);expect(readdirSync(f.base)).not.toContain('node_modules');
   unlinkSync(join(pack,'workspace-foundation.js'));const missing=spawnSync('/bin/bash',[join(pack,'memory-tools','workspace-render.sh'),f.memory],{env,cwd:f.base,encoding:'utf8'});expect(missing.status).toBe(2);expect(missing.stdout).toBe('');expect(missing.stderr).toContain('WORKSPACE_HELPER_MISSING');
 });
 it.runIf(process.platform==='linux')('actual paths shell output is safe to eval and agrees with TypeScript path identity',()=>{
   const pack=extract('claude-code');const env=childEnv();const helper=join(pack,'hooks','workspace-paths.sh');
   const parsed=spawnSync('/bin/bash',['-c','assignments="$(/bin/bash "$1")" || exit $?; eval "$assignments"; printf "%s\\n%s\\n%s\\n" "$WORKSPACE_ID" "$WORKSPACE_ROOT_REAL" "$WORKSPACE_BRAIN_INDEX"','fixture',helper],{env,cwd:f.base,encoding:'utf8'});
   expect(parsed.status,parsed.stderr).toBe(0);expect(parsed.stdout.split('\n').slice(0,3)).toEqual([f.manifest.workspaceId,f.ws().root,f.ws().indexDir]);
   const blank=spawnSync('/bin/bash',[helper],{env:{...env,WORKSPACE_ROOT:' '},encoding:'utf8'});expect(blank.status).toBe(2);expect(blank.stdout).toBe('');expect(blank.stderr).toContain('WORKSPACE_REQUIRED');
   const bad=spawnSync('/bin/bash',[helper],{env:{...env,BRAIN_STATE_DIR:f.base},encoding:'utf8'});expect(bad.status).toBe(2);expect(bad.stdout).toBe('');expect(bad.stderr).toContain('LEGACY_ENV_CONFLICT');
 });
 it('retains installed wrappers and actual isolated settings merge is idempotent',()=>{
   const pack=extract('claude-code');for(const name of ['user-prompt-submit.sh','on-stop.sh','on-pre-compact.sh'])expect(readFileSync(join(pack,'bin',name))).toEqual(readFileSync(join(repo,'adapters','claude-code','bin',name)));
   const settings=f.putPath(join(f.env.HOME!,'.claude','settings.json'),JSON.stringify({theme:'fictional',hooks:{SessionStart:[{hooks:[{type:'command',command:'/fixture/unrelated.sh'}]}]}}));
   const original=readFileSync(settings,'utf8');
   const dry=spawnSync('/bin/bash',[join(repo,'scripts','install.sh'),'--settings',settings,'--dry-run'],{env:{PATH:process.env.PATH,HOME:f.env.HOME},encoding:'utf8'});
   expect(dry.status,dry.stderr).toBe(0);expect(dry.stdout).toContain('dry run');expect(readFileSync(settings,'utf8')).toBe(original);
   const run=()=>spawnSync(process.execPath,[join(repo,'scripts','install-hooks.mjs'),'--settings',settings,'--dist',pack],{env:{PATH:process.env.PATH,HOME:f.env.HOME},encoding:'utf8'});
   expect(run().status).toBe(0);const first=readFileSync(settings,'utf8');const again=run();expect(again.status).toBe(0);expect(again.stdout).toContain('already current');expect(readFileSync(settings,'utf8')).toBe(first);expect(JSON.parse(first).hooks.SessionStart[0].hooks[0].command).toBe('/fixture/unrelated.sh');
 });
});
