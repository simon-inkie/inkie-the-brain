import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, errorCode, type Fixture } from './fixtures.js';
import { loadFoundationEnv, applyFoundationEnv } from '../../core/workspace-env.js';
describe('environment selection and precedence',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>f.clean());
 it('keeps process, explicit, public, legacy precedence and public empty treatment',()=>{
   const explicit=f.putPath(join(f.base,'explicit.env'),'VALUE=explicit\nEMPTY=filled\nWORKSPACE_ROOT=/no-switch\nWORKSPACE_MODE=workspace\nQUOTED="literal"\n#COMMENT=ignored\nBAD =ignored\n');
   f.putPath(join(f.env.HOME!,'.the-brain','.env'),'VALUE=public\nPUBLIC=available\n');f.putPath(join(f.env.HOME!,'io-data','.env'),'VALUE=legacy\nPUBLIC=older\nLEGACY=available\n');
   const result=loadFoundationEnv({HOME:f.env.HOME,BRAIN_ENV_FILE:explicit,VALUE:'process',EMPTY:''});
   expect(result.workspace).toBeNull();expect(result.values).toMatchObject({VALUE:'process',EMPTY:'filled',PUBLIC:'available',LEGACY:'available',QUOTED:'"literal"'});
   expect(result.values.WORKSPACE_ROOT).toBeUndefined();expect(result.values.WORKSPACE_MODE).toBeUndefined();expect(result.values['BAD ']).toBeUndefined();
   expect(loadFoundationEnv({HOME:f.env.HOME,BRAIN_ENV_FILE:explicit}).values.VALUE).toBe('explicit');
 });
 it('workspace never reads implicit HOME env files',()=>{
   f.putPath(join(f.env.HOME!,'.the-brain','.env'),'SECRET_MARKER=fictional-secret\n');expect(loadFoundationEnv(f.env).values.SECRET_MARKER).toBeUndefined();
 });
 it('in-root explicit env files still require a declared name',()=>{
   f.env.BRAIN_ENV_FILE=f.putPath(join(f.root,'config.env'),'PUBLIC=available');expect(errorCode(()=>loadFoundationEnv(f.env))).toBe('EXTERNAL_READ_NOT_DECLARED');
   f.manifest.externalReadOnlyEnv=['BRAIN_ENV_FILE'];f.save();expect(loadFoundationEnv(f.env).values.PUBLIC).toBe('available');
 });
 it('validates selectors and aliases before applying any earlier entries',()=>{
   f.manifest.externalReadOnlyEnv=['BRAIN_ENV_FILE'];f.save();
   for(const selector of ['WORKSPACE_ROOT=/different','WORKSPACE_MODE=legacy','BRAIN_VAULT_DIR=/different','BRAIN_STATE_DIR=/different','BRAIN_MESSAGE_INDEX_STATE=/different']){
     f.env.BRAIN_ENV_FILE=f.putPath(join(f.root,'config.env'),'VALUE=should-not-apply\n'+selector+'\n');const target={...f.env,VALUE:'existing'};
     expect(errorCode(()=>applyFoundationEnv(loadFoundationEnv(f.env),target))).toBe('LEGACY_ENV_CONFLICT');expect(target.VALUE).toBe('existing');
   }
 });
 it('unavailable declared env retains caller values with sanitised warnings',()=>{
   f.manifest.externalReadOnlyEnv=['BRAIN_ENV_FILE'];f.save();f.env.BRAIN_ENV_FILE=join(f.base,'unavailable.env');
   const result=loadFoundationEnv({...f.env,VALUE:'existing'});expect(result.values.VALUE).toBe('existing');expect(result.warnings).toHaveLength(1);expect(result.warnings.join('')).not.toContain(f.base);
 });
 it('environment application is explicit and supports fresh-process import ordering',()=>{
   f.env.BRAIN_ENV_FILE=f.putPath(join(f.root,'config.env'),'READY=fictional-value\n');f.manifest.externalReadOnlyEnv=['BRAIN_ENV_FILE'];f.save();
   const child=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
     "import {loadFoundationEnv,applyFoundationEnv} from './core/workspace-env.ts'; const result=loadFoundationEnv(); if(process.env.READY) throw Error('import mutated env'); applyFoundationEnv(result); const later=await import('data:text/javascript,export const value=process.env.READY'); console.log(later.value);"],{cwd:process.cwd(),env:{PATH:process.env.PATH,...f.env},encoding:'utf8'});
   expect(child.trim()).toBe('fictional-value');
 });
});
