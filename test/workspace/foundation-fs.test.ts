import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdirSync, writeFileSync, symlinkSync, unlinkSync, renameSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fixture, errorCode, type Fixture } from './fixtures.js';
import { openWorkspaceRead, readWorkspaceTextSync, writeWorkspaceDerived } from '../../core/workspace-read.js';
import { assertWorkspacePlatform } from '../../core/workspace-fs.js';
describe('held filesystem operations',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>{vi.restoreAllMocks();syncBuiltinESMExports();f.clean();});
 it('reads through an allowed canonical symlink and an async retained descriptor',async()=>{
   const note=f.put('note.md','fictional 🐦');symlinkSync('note.md',join(f.memory,'alias.md'));const ws=f.ws();
   expect(readWorkspaceTextSync(ws,join(f.memory,'alias.md'))).toBe('fictional 🐦');
   const handle=await openWorkspaceRead(ws,note);try{expect(await handle.readFile('utf8')).toBe('fictional 🐦');}finally{await handle.close();}
 });
 it('rejects FIFOs without blocking and rejects directories and dangling entries',()=>{
   f.put('valid.md','valid');const ws=f.ws();expect(readWorkspaceTextSync(ws,join(f.memory,'valid.md'))).toBe('valid');
   execFileSync('mkfifo',[join(f.memory,'pipe.md')]);expect(errorCode(()=>readWorkspaceTextSync(ws,join(f.memory,'pipe.md')))).toBe('WORKSPACE_FILE_TYPE');
   expect(errorCode(()=>readWorkspaceTextSync(ws,f.memory))).toBe('WORKSPACE_FILE_TYPE');
   symlinkSync('absent',join(f.memory,'dangling.md'));expect(errorCode(()=>readWorkspaceTextSync(ws,join(f.memory,'dangling.md')))).toBe('PATH_DANGLING');
 });
 it('rechecks the original allowed symlink before reading a held file',()=>{
   const note=f.put('note.md','safe');f.put('other.md','other');const alias=join(f.memory,'alias.md');symlinkSync('note.md',alias);const ws=f.ws();
   expect(readWorkspaceTextSync(ws,alias)).toBe('safe');
   const original=fs.readlinkSync;let swaps=0;
   vi.spyOn(fs,'readlinkSync').mockImplementation(((path:fs.PathLike,opts?:unknown)=>{
     const result=original(path,opts as never);
     if (String(path).startsWith('/proc/self/fd/') && result===note && swaps++===0) {unlinkSync(alias);symlinkSync('other.md',alias);}
     return result;
   }) as typeof fs.readlinkSync);syncBuiltinESMExports();
   expect(errorCode(()=>readWorkspaceTextSync(ws,alias))).toBe('WORKSPACE_IDENTITY_CHANGED');
 });
 it('no-follow component opens refuse final and ancestor replacement',()=>{
   const note=f.put('note.md','safe');const ws=f.ws();expect(readWorkspaceTextSync(ws,note)).toBe('safe');
   const original=fs.openSync;let swapped=false;
   vi.spyOn(fs,'openSync').mockImplementation(((path:fs.PathLike,flags:number|string,mode?:number)=>{
     if (!swapped&&String(path).endsWith('/note.md')) {swapped=true;renameSync(note,note+'.old');symlinkSync('note.md.old',note);}
     return original(path,flags,mode);
   }) as typeof fs.openSync);syncBuiltinESMExports();
   expect(errorCode(()=>readWorkspaceTextSync(ws,note))).toBe('ELOOP');
   vi.restoreAllMocks();syncBuiltinESMExports();unlinkSync(note);renameSync(note+'.old',note);swapped=false;
   vi.spyOn(fs,'openSync').mockImplementation(((path:fs.PathLike,flags:number|string,mode?:number)=>{
     if (!swapped&&String(path).endsWith('/memory')) {swapped=true;renameSync(f.memory,f.memory+'.old');symlinkSync('memory.old',f.memory);}
     return original(path,flags,mode);
   }) as typeof fs.openSync);syncBuiltinESMExports();
   expect(errorCode(()=>readWorkspaceTextSync(ws,note))).toBe('ENOTDIR');
 });
 it('missing procfs capability refuses before writable opens',async()=>{
   const ws=f.ws();const original=fs.readlinkSync;
   vi.spyOn(fs,'readlinkSync').mockImplementation(((path:fs.PathLike)=>{if(String(path).startsWith('/proc/self/fd/'))throw Object.assign(new Error('unavailable'),{code:'ENOENT'});return original(path);}) as typeof fs.readlinkSync);syncBuiltinESMExports();
   expect(errorCode(assertWorkspacePlatform)).toBe('WORKSPACE_PLATFORM_UNSUPPORTED');
   await expect(writeWorkspaceDerived(ws,join(ws.localBrain,'state','file.json'),'{}')).rejects.toMatchObject({code:'WORKSPACE_PLATFORM_UNSUPPORTED'});
   expect(fs.existsSync(ws.paths.local)).toBe(false);
 });
 it('bounds input before reading and closes failed descriptors',()=>{
   const note=f.put('note.md','x'.repeat(4096));const ws=f.ws();const count=()=>readdirSync('/proc/self/fd').length;const before=count();
   for(let i=0;i<20;i++)expect(errorCode(()=>readWorkspaceTextSync(ws,note,100))).toBe('WORKSPACE_INPUT_LIMIT');
   expect(count()).toBe(before);
 });
 it('writes only confined derived bytes and leaves authored files intact',async()=>{
   const original=f.put('live-state.json','{"hotReflectionCount":3}');const ws=f.ws();const target=join(ws.localBrain,'state','new','cursor.json');
   await writeWorkspaceDerived(ws,target,'{}');expect(readFileSync(target,'utf8')).toBe('{}');expect(statSync(target).mode&0o777).toBe(0o600);
   await expect(writeWorkspaceDerived(ws,original,'bad')).rejects.toMatchObject({code:'WRITE_OUTSIDE_WORKSPACE'});
   expect(readFileSync(original,'utf8')).toBe('{"hotReflectionCount":3}');
 });
 it('valid final-file symlinks retain their requested entry and replace the confined resolved target',async()=>{
   const ws=f.ws();const target=join(ws.localBrain,'cache','file.json');await writeWorkspaceDerived(ws,target,'old');
   const requested=join(ws.localBrain,'state','alias.json');mkdirSync(join(ws.localBrain,'state'),{recursive:true});symlinkSync('../cache/file.json',requested);
   await writeWorkspaceDerived(ws,requested,'new');expect(fs.lstatSync(requested).isSymbolicLink()).toBe(true);expect(readFileSync(target,'utf8')).toBe('new');
 });
 it('failed rename cleans the owned temporary file and preserves prior bytes',async()=>{
   const ws=f.ws();const target=join(ws.localBrain,'state','file.json');await writeWorkspaceDerived(ws,target,'old');
   vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw Object.assign(new Error('disk failure'),{code:'EIO'});});syncBuiltinESMExports();
   await expect(writeWorkspaceDerived(ws,target,'new')).rejects.toMatchObject({code:'EIO'});expect(readFileSync(target,'utf8')).toBe('old');
   expect(readdirSync(join(ws.localBrain,'state'))).toEqual(['file.json']);
 });
 it('a real read-only parent refuses writes and preserves existing bytes',async()=>{
   const ws=f.ws();const target=join(ws.localBrain,'state','file.json');await writeWorkspaceDerived(ws,target,'old');
   const parent=join(ws.localBrain,'state');chmodSync(parent,0o500);
   try {await expect(writeWorkspaceDerived(ws,target,'new')).rejects.toMatchObject({code:'EACCES'});expect(readFileSync(target,'utf8')).toBe('old');}
   finally {chmodSync(parent,0o700);}
 });
 it('cleanup never unlinks a foreign replacement temporary inode',async()=>{
   const ws=f.ws();const target=join(ws.localBrain,'state','file.json');await writeWorkspaceDerived(ws,target,'old');
   const originalRename=fs.renameSync;
   vi.spyOn(fs,'renameSync').mockImplementation(((temp:fs.PathLike)=>{originalRename(temp,temp+'.owned');writeFileSync(temp,'foreign');throw Object.assign(new Error('rename failed'),{code:'EIO'});}) as typeof fs.renameSync);syncBuiltinESMExports();
   await expect(writeWorkspaceDerived(ws,target,'new')).rejects.toMatchObject({code:'EIO'});
   const names=readdirSync(join(ws.localBrain,'state'));const foreign=names.find(n=>n.endsWith('.tmp'))!;
   expect(foreign,'foreign temporary inode must remain visible').toBeDefined();
   expect(readFileSync(join(ws.localBrain,'state',foreign),'utf8')).toBe('foreign');expect(readFileSync(target,'utf8')).toBe('old');
 });
 it('post-rename sync failure reports uncertainty and never rolls back',async()=>{
   const ws=f.ws();const target=join(ws.localBrain,'state','file.json');await writeWorkspaceDerived(ws,target,'old');const sync=fs.fsyncSync;
   vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('sync failure'),{code:'EIO'});sync(fd);});syncBuiltinESMExports();
   await expect(writeWorkspaceDerived(ws,target,'new')).rejects.toMatchObject({code:'WORKSPACE_WRITE_UNCERTAIN'});expect(readFileSync(target,'utf8')).toBe('new');
 });
});
