import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, errorCode, localPath, type Fixture } from './fixtures.js';
import { resolveWorkspaceMemoryDir, renderWorkspaceMemory } from '../../core/workspace-memory.js';
import { refreshDerivedMemoryState, readDerivedMemoryState } from '../../core/workspace-derived.js';
describe.runIf(process.platform==='linux')('workspace memory tiers and relocation',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>f.clean());
 it('explicit identity wins over a project pointer and unrelated HOME',()=>{
   const project=join(f.root,'projects','project');f.putPath(join(project,'.the-brain','memory_root'),'silos/other/memory');
   const ws=f.ws();expect(resolveWorkspaceMemoryDir(ws,project,{AGENT_NAME:'finch',HOME:'/fictional/no-home'})).toBe(f.memory);
 });
 it('existing project memory is honoured only inside silos',()=>{
   f.put('note.md','valid');const project=join(f.root,'projects','project');mkdirSync(project,{recursive:true});symlinkSync(f.memory,join(project,'memory'));
   expect(resolveWorkspaceMemoryDir(f.ws(),project,{})).toBe(f.memory);
   const other=join(f.root,'projects','outside');mkdirSync(join(other,'memory'),{recursive:true});expect(errorCode(()=>resolveWorkspaceMemoryDir(f.ws(),other,{}))).toBe('WRITE_OUTSIDE_WORKSPACE');
 });
 it('a declared external project pointer is held-read but memory must remain in silos',()=>{
   const project=join(f.base,'external-project');f.putPath(join(project,'.the-brain','memory_root'),'silos/finch/memory');f.manifest.externalReadOnlyEnv=['PROJECT_READ'];f.env.PROJECT_READ=project;f.save();
   expect(resolveWorkspaceMemoryDir(f.ws(),project,{})).toBe(f.memory);
   f.putPath(join(project,'.the-brain','memory_root'),f.base);expect(errorCode(()=>resolveWorkspaceMemoryDir(f.ws(),project,{}))).toBe('WRITE_OUTSIDE_WORKSPACE');
 });
 it('supports workspace-relative env override and refuses tilde and escapes',()=>{
   const project=join(f.root,'projects','project');expect(resolveWorkspaceMemoryDir(f.ws(),project,{BRAIN_MEMORY_DIR:'silos/finch/memory'})).toBe(f.memory);
   for(const p of ['~/memory',f.base,f.root+'-prefix/memory'])expect(errorCode(()=>resolveWorkspaceMemoryDir(f.ws(),project,{BRAIN_MEMORY_DIR:p}))).toBe('WRITE_OUTSIDE_WORKSPACE');
 });
 it('auto-silo creates nothing and invalid names fall through with a warning',()=>{
   const project=join(f.root,'projects','project');const ws=f.ws();expect(resolveWorkspaceMemoryDir(ws,project,{AGENT_NAME:'../invalid'})).toBe(join(ws.paths.silos,'project','memory'));
   expect(errorCode(()=>resolveWorkspaceMemoryDir(ws,project,{BRAIN_MEMORY_DIR:ws.paths.silos}))).toBe('WRITE_OUTSIDE_WORKSPACE');
 });
 it.each(['',' \t\n'])('present blank pointer %j refuses valid lower tiers but preserves earlier priority',raw=>{
   f.put('note.md','valid lower-tier memory');const project=join(f.root,'projects','project');const pointer=f.putPath(join(project,'.the-brain','memory_root'),raw);const ws=f.ws();
   const before=readFileSync(pointer);const lower={BRAIN_MEMORY_DIR:'silos/finch/memory'};
   expect(errorCode(()=>resolveWorkspaceMemoryDir(ws,project,lower))).toBe('WORKSPACE_MEMORY_POINTER_INVALID');
   expect(errorCode(()=>resolveWorkspaceMemoryDir(ws,project,{}))).toBe('WORKSPACE_MEMORY_POINTER_INVALID');
   expect(readFileSync(pointer)).toEqual(before);
   expect(resolveWorkspaceMemoryDir(ws,project,{...lower,AGENT_NAME:'finch'})).toBe(f.memory);
   symlinkSync(f.memory,join(project,'memory'));expect(resolveWorkspaceMemoryDir(ws,project,lower)).toBe(f.memory);
 });
 it('truly absent pointer preserves environment and basename fallback without writes',()=>{
   f.put('note.md','valid fallback');const project=join(f.root,'projects','project');mkdirSync(project,{recursive:true});const ws=f.ws();
   expect(resolveWorkspaceMemoryDir(ws,project,{BRAIN_MEMORY_DIR:'silos/finch/memory'})).toBe(f.memory);
   expect(resolveWorkspaceMemoryDir(ws,project,{})).toBe(join(ws.paths.silos,'project','memory'));
   expect(readFileSync(join(f.memory,'note.md'),'utf8')).toBe('valid fallback');
 });
 it('undeclared and dangling pointer entries refuse rather than fall through',()=>{
   const project=join(f.base,'external');f.putPath(join(project,'.the-brain','memory_root'),'silos/finch/memory');expect(errorCode(()=>resolveWorkspaceMemoryDir(f.ws(),project,{}))).toBe('EXTERNAL_READ_NOT_DECLARED');
   const internal=join(f.root,'projects','inside');mkdirSync(join(internal,'.the-brain'),{recursive:true});symlinkSync('absent',join(internal,'.the-brain','memory_root'));
   expect(errorCode(()=>resolveWorkspaceMemoryDir(f.ws(),internal,{}))).toBe('PATH_DANGLING');
 });
 it('relocates authored and derived identities without old-root leakage',async()=>{
   f.put('live-state.json','{"hotReflectionCount":4}');f.put('era-summary.md','fictional era');f.put('era-summary.meta.json','{"level":2,"coverageLatestReflectionDate":"2026-05-04"}');
   const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');const oldRoot=f.root;const newRoot=join(f.base,'relocated');renameSync(oldRoot,newRoot);f.env.WORKSPACE_ROOT=newRoot;f.env.HOME=join(f.base,'relocated-home');
   const moved=f.ws();const memory=join(moved.paths.silos,'finch','memory');const view=readDerivedMemoryState(moved,memory,'live-state.json');
   expect(moved.workspaceId).toBe(ws.workspaceId);expect(view.state.eraCompressionLevel).toBe(2);expect(view.eraSummary).toBe('fictional era');
   const rendered=await renderWorkspaceMemory(moved,memory,{cached:true});expect(rendered).not.toContain(oldRoot);expect(localPath(moved,memory,'live-state.json')).not.toContain(oldRoot);
 });
});
