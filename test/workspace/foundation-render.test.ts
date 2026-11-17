import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { symlinkSync, mkdirSync, readdirSync, readFileSync, utimesSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, type Fixture } from './fixtures.js';
import { renderWorkspaceMemory } from '../../core/workspace-memory.js';
import { readWorkspacePersona } from '../../core/workspace-persona.js';
describe('bounded read-only memory and persona',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>f.clean());
 it('new silo returns authored MEMORY only without changing any bytes',async()=>{
   f.putPath(join(f.root,'silos','finch','MEMORY.md'),'# Finch\n🐦 authored only\n');const ws=f.ws();const before=readdirSync(join(f.root,'silos','finch'));
   expect(await renderWorkspaceMemory(ws,f.memory,{cached:true})).toBe('# Finch\n🐦 authored only\n');expect(readdirSync(join(f.root,'silos','finch'))).toEqual(before);expect(readdirSync(f.root)).not.toContain('device');
 });
 it('era, hot reflections and later observations keep the public zone order',async()=>{
   f.put('live-state.json','{"hotReflectionCount":1}');f.put('era-summary.md','ancient era');f.put('reflections/2026-05-01.md','older reflection');f.put('reflections/2026-05-02.md','recent reflection');f.put('observations/2026-05-03.md','later observation');
   utimesSync(join(f.memory,'reflections/2026-05-01.md'),1000,1000);utimesSync(join(f.memory,'reflections/2026-05-02.md'),2000,2000);utimesSync(join(f.memory,'observations/2026-05-03.md'),3000,3000);
   const ws=f.ws();const out=await renderWorkspaceMemory(ws,f.memory,{cached:true});expect(out.indexOf('ancient era')).toBeLessThan(out.indexOf('recent reflection'));expect(out.indexOf('recent reflection')).toBeLessThan(out.indexOf('later observation'));expect(out).not.toContain('older reflection');expect(out).toContain('<!-- IO_LIVE_END -->');expect(out).not.toContain('Current time:');expect(readdirSync(f.root)).not.toContain('device');
 });
 it('Unicode gists keep complete codepoints while oversized complete output refuses',async()=>{
   f.put('reflections/2026-05-01.md','🐦'.repeat(600));const ws=f.ws();const text=await renderWorkspaceMemory(ws,f.memory,{cached:true});expect(text).toContain('🐦'.repeat(500));expect(text).not.toContain('\ufffd');expect(text).toContain('gist truncated');
   await expect(renderWorkspaceMemory(ws,f.memory,{maxOutputBytes:200})).rejects.toMatchObject({code:'WORKSPACE_OUTPUT_LIMIT'});
   f.put('reflections/2026-05-02.md','x'.repeat(2*1024*1024));await expect(renderWorkspaceMemory(ws,f.memory)).rejects.toMatchObject({code:'WORKSPACE_INPUT_LIMIT'});
 });
 it('escaping notes refuse even when elsewhere inside the workspace; inbox is not read',async()=>{
   const outside=f.putPath(join(f.root,'brain','outside.md'),'outside notes');mkdirSync(join(f.memory,'reflections'),{recursive:true});symlinkSync(outside,join(f.memory,'reflections','2026-05-01.md'));
   // A poisonous inbox cannot affect standalone context; no read is authorised.
   mkdirSync(join(f.root,'inbox'),{recursive:true});symlinkSync('missing',join(f.root,'inbox','mail.md'));
   await expect(renderWorkspaceMemory(f.ws(),f.memory)).rejects.toMatchObject({code:'WRITE_OUTSIDE_WORKSPACE'});
 });
 it('missing CORE emits only the generic wrapper; regular CORE is bounded and read-only',async()=>{
   const ws=f.ws();expect(await readWorkspacePersona(ws,'finch',{maxOutputBytes:9500})).toContain('Read the full persona files');
   const core=f.putPath(join(ws.paths.agents,'finch','CORE.md'),'Fictional Finch 🐦\n\n');const before=readFileSync(core);
   expect(await readWorkspacePersona(ws,'finch',{maxOutputBytes:9500})).toContain('Fictional Finch 🐦\n\nRead');expect(readFileSync(core)).toEqual(before);
   await expect(readWorkspacePersona(ws,'finch',{maxOutputBytes:10})).rejects.toMatchObject({code:'WORKSPACE_INPUT_LIMIT'});
   await expect(readWorkspacePersona(ws,'../other',{maxOutputBytes:9500})).rejects.toMatchObject({code:'PATH_INVALID_CHARS'});
 });
 it('escaped or dangling CORE is never treated as missing',async()=>{
   const ws=f.ws();mkdirSync(join(ws.paths.agents,'finch'),{recursive:true});const path=join(ws.paths.agents,'finch','CORE.md');symlinkSync('absent',path);await expect(readWorkspacePersona(ws,'finch')).rejects.toMatchObject({code:'PATH_DANGLING'});
   unlinkSync(path);const outside=f.putPath(join(ws.paths.brain,'CORE.md'),'fictional other persona');symlinkSync(outside,path);await expect(readWorkspacePersona(ws,'finch')).rejects.toMatchObject({code:'WRITE_OUTSIDE_WORKSPACE'});
 });
});
