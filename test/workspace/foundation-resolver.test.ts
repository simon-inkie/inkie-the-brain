import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, symlinkSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, errorCode, type Fixture } from './fixtures.js';
import { loadWorkspace, resolveWorkspaceRead, resolveWorkspaceWrite, externalReadPath, isWorkspaceMode } from '../../core/workspace.js';
import * as fs from 'node:fs';
describe('explicit version-one resolution',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>{vi.restoreAllMocks();f.clean();});
 it('blank selection reads nothing and ignores inherited mode',()=>{
   expect(isWorkspaceMode({WORKSPACE_ROOT:' \t\n',WORKSPACE_MODE:'workspace'})).toBe(false);
   expect(loadWorkspace({WORKSPACE_ROOT:' \t\n',WORKSPACE_MODE:'workspace'})).toBeNull();
 });
 it('resolves absent roots without creating them, preserving extensions',()=>{
   Object.assign(f.manifest,{extension:{label:'fictional'}});f.save();
   const before=readdirSync(f.root);const ws=f.ws();expect(ws.workspaceId).toBe(f.manifest.workspaceId);
   expect(ws.paths.brain).toBe(join(f.root,'brain'));expect(readdirSync(f.root)).toEqual(before);
 });
 it.each([
   ['schemaVersion',2,'SCHEMA_VERSION_UNSUPPORTED'],['schemaVersion',true,'SCHEMA_VERSION_UNSUPPORTED'],
   ['workspaceId','A1111111-2222-4333-8444-555555555555','WORKSPACE_ID_INVALID']
 ])('refuses invalid %s', (key,value,code)=>{Object.assign(f.manifest,{[key]:value});f.save();expect(errorCode(f.ws)).toBe(code);});
 it.each([['../neighbour','PATH_TRAVERSAL'],['a//b','PATH_EMPTY'],['a/./b','PATH_TRAVERSAL'],['/outside','PATH_ABSOLUTE'],['a\\b','PATH_INVALID_CHARS'],['','PATH_EMPTY']])('refuses path %s',(path,code)=>{f.manifest.paths.brain=path;f.save();expect(errorCode(f.ws)).toBe(code);});
 it('refuses malformed JSON and manifest escape or FIFO/nonregular entries',()=>{
   writeFileSync(join(f.root,'workspace.json'),'[');expect(errorCode(f.ws)).toBe('MANIFEST_INVALID_JSON');
   f.save();renameSync(join(f.root,'workspace.json'),join(f.base,'other.json'));symlinkSync(join(f.base,'other.json'),join(f.root,'workspace.json'));
   expect(errorCode(f.ws)).toBe('PATH_ESCAPES_ROOT');
 });
 it('canonical aliases must be equal or blank; public vault/state aliases are fenced',()=>{
   const ws=f.ws();for(const [name,value] of Object.entries({BRAIN_VAULT_DIR:ws.paths.brain,BRAIN_STATE_DIR:ws.indexDir,AGENTS_HOME:ws.paths.agents,DATA_ROOT:ws.localDeck}))expect(loadWorkspace({...f.env,[name]:value})).not.toBeNull();
   expect(loadWorkspace({...f.env,BRAIN_STATE_DIR:' '})).not.toBeNull();
   expect(errorCode(()=>loadWorkspace({...f.env,BRAIN_STATE_DIR:f.base}))).toBe('LEGACY_ENV_CONFLICT');
   expect(errorCode(()=>loadWorkspace({...f.env,BRAIN_MESSAGE_INDEX_STATE:ws.indexDir}))).toBe('LEGACY_ENV_CONFLICT');
   expect(loadWorkspace({...f.env,BRAIN_MESSAGE_INDEX_STATE:join(ws.indexDir,'messages.json')})).not.toBeNull();
 });
 it('refuses duplicate canonical targets and dangling declared roots',()=>{
   mkdirSync(join(f.root,'brain'));symlinkSync('brain',join(f.root,'agents'));expect(errorCode(f.ws)).toBe('PATH_DUPLICATE');
   f.manifest.paths.agents='missing-link';symlinkSync('absent',join(f.root,'missing-link'));f.save();expect(errorCode(f.ws)).toBe('PATH_DANGLING');
 });
 it('external reads grant no write authority and matching-prefix neighbours are outside',()=>{
   f.manifest.externalReadOnlyEnv=['NOTES_ROOT'];f.env.NOTES_ROOT=f.base;f.save();const ws=f.ws();
   expect(resolveWorkspaceRead(ws,join(f.base,'memo.md'))).toBe(join(f.base,'memo.md'));
   expect(externalReadPath(ws,'UNDECLARED')).toBeNull();expect(errorCode(()=>resolveWorkspaceWrite(ws,join(f.base,'memo.md')))).toBe('WRITE_OUTSIDE_WORKSPACE');
   const other=f.root+'-neighbour';expect(errorCode(()=>resolveWorkspaceRead(fixtureWithoutExternal(ws),other))).toBe('EXTERNAL_READ_NOT_DECLARED');
 });
 it('refuses changed original selected root after canonical acquisition',()=>{
   const ws=f.ws();renameSync(f.root,f.root+'-old');mkdirSync(f.root);expect(errorCode(()=>resolveWorkspaceRead(ws,'brain/note.md'))).toBe('WORKSPACE_IDENTITY_CHANGED');
 });
});
function fixtureWithoutExternal(ws:ReturnType<Fixture['ws']>){return {...ws,externalReadOnlyEnv:[]};}
