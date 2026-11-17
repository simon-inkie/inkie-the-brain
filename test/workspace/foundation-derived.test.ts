import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs, { readFileSync, symlinkSync, mkdirSync, unlinkSync, utimesSync, statSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fixture, localPath, errorCode, type Fixture } from './fixtures.js';
import { readDerivedMemoryState, refreshDerivedMemoryState } from '../../core/workspace-derived.js';
import { derivedMemoryPaths } from '../../core/derived-state.js';
describe.runIf(process.platform==='linux')('authored truth and disposable state',()=>{
 let f:Fixture;beforeEach(()=>f=fixture());afterEach(()=>{vi.restoreAllMocks();syncBuiltinESMExports();f.clean();});
 const seed=(f:Fixture)=>{f.put('live-state.json','{"hotReflectionCount":4,"softBudgetChars":10000,"hardBudgetChars":20000}');f.put('era-summary.md','authored era');f.put('era-summary.meta.json','{"level":2,"coverageLatestReflectionDate":"2026-05-04"}');};
 it('read-only lost local state seeds validated era coverage without creating local files',()=>{
   seed(f);const ws=f.ws();const view=readDerivedMemoryState(ws,f.memory,'live-state.json');expect(view.state).toMatchObject({eraCompressionLevel:2,eraCoverageThroughReflectionDate:'2026-05-04',hotReflectionCount:4});expect(fs.existsSync(ws.paths.local)).toBe(false);
 });
 it('refresh preserves all authored bytes, writes matching provenance and no progress credit',async()=>{
   seed(f);const ws=f.ws();const before=readFileSync(join(f.memory,'live-state.json'));const view=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');
   expect(view.eraChanged).toBe(false);expect(readFileSync(join(f.memory,'live-state.json'))).toEqual(before);expect(view.state.lastRebuildAt).toBeNull();
   expect(JSON.parse(readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'),'utf8'))).toEqual(view.sourceHashes);
 });
 it('unchanged authored targets retain reduced hot counts and local compressed era',async()=>{
   seed(f);const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');
   f.putPath(localPath(ws,f.memory,'live-state.json'),'{"hotReflectionCount":2,"configuredHotReflectionCount":4,"eraCompressionLevel":3,"eraCoverageThroughReflectionDate":"2026-05-06"}');
   f.putPath(localPath(ws,f.memory,'era-summary.md'),'local compressed era');f.putPath(localPath(ws,f.memory,'era-summary.meta.json'),'{"level":3,"coverageLatestReflectionDate":"2026-05-06"}');
   const view=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');expect(view.state.hotReflectionCount).toBe(2);expect(view.state.eraCompressionLevel).toBe(3);expect(view.eraSummary).toBe('local compressed era');
   f.put('live-state.json','{"hotReflectionCount":5}');expect(readDerivedMemoryState(ws,f.memory,'live-state.json').state.hotReflectionCount).toBe(5);
 });
 it.each([false,true])('era generation stays coherent with local metadata missing=%s',async missing=>{
   seed(f);const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');
   const names=['live-state.json','era-summary.md','era-summary.meta.json'] as const;
   const authoredBytes=names.map(name=>readFileSync(join(f.memory,name)));
   f.putPath(localPath(ws,f.memory,'live-state.json'),' {"hotReflectionCount":2,"configuredHotReflectionCount":4,"eraCompressionLevel":3,"eraCoverageThroughReflectionDate":"2026-05-10"}');
   f.putPath(localPath(ws,f.memory,'era-summary.md'),'newer local compressed era');f.putPath(localPath(ws,f.memory,'era-summary.meta.json'),'{"level":3,"coverageLatestReflectionDate":"2026-05-10"}');
   if(missing)unlinkSync(localPath(ws,f.memory,'era-summary.meta.json'));
   const tracked=['live-state.json','era-summary.md','era-authored-provenance.json'];const before=tracked.map(name=>readFileSync(localPath(ws,f.memory,name)));
   const expectedSummary=missing?'authored era':'newer local compressed era';const level=missing?2:3;const date=missing?'2026-05-04':'2026-05-10';
   const coherent=(view:ReturnType<typeof readDerivedMemoryState>)=>{
     expect(view.eraSummary).toBe(expectedSummary);expect(view.eraMeta).toMatchObject({level,coverageLatestReflectionDate:date});
     expect(view.state).toMatchObject({hotReflectionCount:2,eraCompressionLevel:level,eraCoverageThroughReflectionDate:date});
   };
   coherent(readDerivedMemoryState(ws,f.memory,'live-state.json'));
   expect(tracked.map(name=>readFileSync(localPath(ws,f.memory,name)))).toEqual(before);
   expect(fs.existsSync(localPath(ws,f.memory,'era-summary.meta.json'))).toBe(!missing);
   const refreshed=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');coherent(refreshed);const reread=readDerivedMemoryState(ws,f.memory,'live-state.json');coherent(reread);expect(reread).toEqual(refreshed);
   expect(readFileSync(localPath(ws,f.memory,'era-summary.md'),'utf8')).toBe(expectedSummary);
   expect(JSON.parse(readFileSync(localPath(ws,f.memory,'era-summary.meta.json'),'utf8'))).toMatchObject({level,coverageLatestReflectionDate:date});
   expect(JSON.parse(readFileSync(localPath(ws,f.memory,'live-state.json'),'utf8'))).toEqual(refreshed.state);
   expect(JSON.parse(readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'),'utf8'))).toEqual(refreshed.sourceHashes);
   expect(names.map(name=>readFileSync(join(f.memory,name)))).toEqual(authoredBytes);
 });
 it.each(['metadata-loss','authored-change','unchanged'] as const)('observer-first %s selects coherent live era without erasing counters',async cause=>{
   seed(f);f.put('observer-state.json','{"reflectionThreshold":10}');
   const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');
   const retained={hotReflectionCount:2,configuredHotReflectionCount:4,lastRebuildAt:'2026-05-10T12:00:00Z',lastBlockCharCount:1234,rebuildCount:7,customCount:9};
   f.putPath(localPath(ws,f.memory,'live-state.json'),JSON.stringify({...retained,eraCompressionLevel:3,eraCoverageThroughReflectionDate:'2026-05-10'}));
   f.putPath(localPath(ws,f.memory,'observer-state.json'),'{"reflectionThreshold":3,"unprocessedObservationCount":6,"unprocessedObservationChars":42,"lastReflectionAt":"2026-05-10T12:00:00Z"}');
   f.putPath(localPath(ws,f.memory,'era-summary.md'),'newer local compressed era');
   f.putPath(localPath(ws,f.memory,'era-summary.meta.json'),'{"level":3,"coverageLatestReflectionDate":"2026-05-10"}');
   if(cause==='metadata-loss')unlinkSync(localPath(ws,f.memory,'era-summary.meta.json'));
   if(cause==='authored-change'){
     f.put('era-summary.md','changed authored era');
     f.put('era-summary.meta.json','{"level":1,"coverageLatestReflectionDate":"2026-05-07"}');
   }
   const names=['live-state.json','observer-state.json','era-summary.md','era-summary.meta.json'] as const;
   const authoredBytes=names.map(name=>readFileSync(join(f.memory,name)));
   const liveBefore=readFileSync(localPath(ws,f.memory,'live-state.json'));
   const provenanceBefore=readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'));
   const observer=await refreshDerivedMemoryState(ws,f.memory,'observer-state.json');
   expect(observer.state).toMatchObject({reflectionThreshold:10,unprocessedObservationCount:6,unprocessedObservationChars:42,lastReflectionAt:'2026-05-10T12:00:00Z'});
   expect(readFileSync(localPath(ws,f.memory,'live-state.json'))).toEqual(liveBefore);
   const summary=cause==='unchanged'?'newer local compressed era':cause==='authored-change'?'changed authored era':'authored era';
   const level=cause==='unchanged'?3:cause==='authored-change'?1:2;
   const date=cause==='unchanged'?'2026-05-10':cause==='authored-change'?'2026-05-07':'2026-05-04';
   expect(observer.eraSummary).toBe(summary);expect(observer.eraMeta).toMatchObject({level,coverageLatestReflectionDate:date});
   const provenance=readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'));
   expect(JSON.parse(provenance.toString())).toEqual(observer.sourceHashes);
   expect(provenance.equals(provenanceBefore)).toBe(cause!=='authored-change');
   const snapshot=()=>readdirSync(f.root,{recursive:true}).map(String).sort().map(name=>{
     const path=join(f.root,name);const stat=statSync(path);
     return [name,stat.mode,stat.mtimeMs,stat.isFile()?readFileSync(path):null];
   });
   const before=snapshot();
   const coherent=(view:ReturnType<typeof readDerivedMemoryState>)=>{
     expect(view.eraChanged).toBe(false);expect(view.eraSummary).toBe(summary);
     expect(view.eraMeta).toMatchObject({level,coverageLatestReflectionDate:date});
     expect(view.state).toMatchObject({...retained,eraCompressionLevel:level,eraCoverageThroughReflectionDate:date});
   };
   coherent(readDerivedMemoryState(ws,f.memory,'live-state.json'));
   expect(snapshot()).toEqual(before);
   const refreshed=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');coherent(refreshed);
   const reread=readDerivedMemoryState(ws,f.memory,'live-state.json');coherent(reread);expect(reread).toEqual(refreshed);
   expect(JSON.parse(readFileSync(localPath(ws,f.memory,'live-state.json'),'utf8'))).toEqual(refreshed.state);
   expect(readFileSync(localPath(ws,f.memory,'era-summary.md'),'utf8')).toBe(summary);
   expect(JSON.parse(readFileSync(localPath(ws,f.memory,'era-summary.meta.json'),'utf8'))).toMatchObject({level,coverageLatestReflectionDate:date});
   expect(readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'))).toEqual(provenance);
   expect(names.map(name=>readFileSync(join(f.memory,name)))).toEqual(authoredBytes);
 });
 it('older local states adopt the authored target without erasing their reduction',()=>{
   seed(f);const ws=f.ws();f.putPath(localPath(ws,f.memory,'live-state.json'),'{"hotReflectionCount":2}');expect(readDerivedMemoryState(ws,f.memory,'live-state.json').state.hotReflectionCount).toBe(2);
 });
 it('same-mtime authored edits invalidate era by hash; read-only does not repair',async()=>{
   seed(f);const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');const eraPath=join(f.memory,'era-summary.md');const time=statSync(eraPath);f.put('era-summary.md','edited era');utimesSync(eraPath,time.atime,time.mtime);
   const before=readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'));const view=readDerivedMemoryState(ws,f.memory,'live-state.json');expect(view.eraChanged).toBe(true);expect(view.eraSummary).toBe('edited era');expect(view.warnings).toHaveLength(1);expect(readFileSync(localPath(ws,f.memory,'era-authored-provenance.json'))).toEqual(before);
   expect((await refreshDerivedMemoryState(ws,f.memory,'live-state.json')).eraChanged).toBe(false);
 });
 it('empty and missing authored era have different hashes and deletion removes only derived copies',async()=>{
   seed(f);const ws=f.ws();const original=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');f.put('era-summary.md','');const empty=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');expect(empty.sourceHashes['era-summary.md']).not.toBe(original.sourceHashes['era-summary.md']);
   unlinkSync(join(f.memory,'era-summary.md'));const missing=await refreshDerivedMemoryState(ws,f.memory,'live-state.json');expect(missing.sourceHashes['era-summary.md']).toBeNull();expect(fs.existsSync(localPath(ws,f.memory,'era-summary.md'))).toBe(false);expect(missing.state.eraCoverageThroughReflectionDate).toBeNull();expect(fs.existsSync(join(f.memory,'era-summary.meta.json'))).toBe(true);
 });
 it.each(['null','[]','{','{"hotReflectionCount":-1}'])('present invalid local state %s is never first use',(data)=>{
   seed(f);const ws=f.ws();f.putPath(localPath(ws,f.memory,'live-state.json'),data);expect(errorCode(()=>readDerivedMemoryState(ws,f.memory,'live-state.json'))).toBe('WORKSPACE_STATE_INVALID');
 });
 it('malformed provenance refuses before any mutation',async()=>{
   seed(f);const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');const path=localPath(ws,f.memory,'era-authored-provenance.json');f.putPath(path,'{"era-summary.md":"invalid"}');
   const before=readFileSync(localPath(ws,f.memory,'live-state.json'));await expect(refreshDerivedMemoryState(ws,f.memory,'live-state.json')).rejects.toMatchObject({code:'WORKSPACE_STATE_INVALID'});expect(readFileSync(localPath(ws,f.memory,'live-state.json'))).toEqual(before);expect(readFileSync(path,'utf8')).toBe('{"era-summary.md":"invalid"}');
 });
 it('dangling local state/provenance and escaping authored era fail before first-use defaults',()=>{
   seed(f);const ws=f.ws();const path=localPath(ws,f.memory,'live-state.json');mkdirSync(dirname(path),{recursive:true});symlinkSync('missing',path);
   expect(errorCode(()=>readDerivedMemoryState(ws,f.memory,'live-state.json'))).toBe('PATH_DANGLING');unlinkSync(path);symlinkSync('missing',localPath(ws,f.memory,'era-authored-provenance.json'));expect(errorCode(()=>readDerivedMemoryState(ws,f.memory,'live-state.json'))).toBe('PATH_DANGLING');
   unlinkSync(localPath(ws,f.memory,'era-authored-provenance.json'));unlinkSync(join(f.memory,'era-summary.md'));const outside=f.putPath(join(f.root,'brain','outside.md'),'not memory');symlinkSync(outside,join(f.memory,'era-summary.md'));expect(errorCode(()=>readDerivedMemoryState(ws,f.memory,'live-state.json'))).toBe('WRITE_OUTSIDE_WORKSPACE');
 });
 it.each(['{"level":4}','{"level":true}','{"coverageLatestReflectionDate":"2026-02-30"}'])('invalid era metadata %s refuses',data=>{seed(f);f.put('era-summary.meta.json',data);expect(errorCode(()=>readDerivedMemoryState(f.ws(),f.memory,'live-state.json'))).toBe('WORKSPACE_STATE_INVALID');});
 it('observer authored configuration overrides disposable counters and removed config disappears',()=>{
   f.put('observer-state.json','{"reflectionThreshold":10}');f.put('observations/2026-05-06.md','🐦 bird');const ws=f.ws();let view=readDerivedMemoryState(ws,f.memory,'observer-state.json');expect(view.state).toMatchObject({reflectionThreshold:10,unprocessedObservationCount:1,unprocessedObservationChars:6});
   f.putPath(localPath(ws,f.memory,'observer-state.json'),'{"reflectionThreshold":3,"oldMaxAgeMs":8,"unprocessedObservationCount":2}');view=readDerivedMemoryState(ws,f.memory,'observer-state.json');expect(view.state.reflectionThreshold).toBe(10);expect(view.state.unprocessedObservationCount).toBe(2);expect(view.state.oldMaxAgeMs).toBeUndefined();
 });
 it('failed partial refresh leaves no matching provenance and authored bytes untouched',async()=>{
   seed(f);const ws=f.ws();await refreshDerivedMemoryState(ws,f.memory,'live-state.json');f.put('era-summary.md','new authored era');const oldRename=fs.renameSync;
   vi.spyOn(fs,'renameSync').mockImplementation(((a:fs.PathLike,b:fs.PathLike)=>{if(String(b).endsWith('/era-summary.meta.json'))throw Object.assign(new Error('failed rename'),{code:'EIO'});oldRename(a,b);}) as typeof fs.renameSync);syncBuiltinESMExports();
   await expect(refreshDerivedMemoryState(ws,f.memory,'live-state.json')).rejects.toMatchObject({code:'EIO'});expect(fs.existsSync(localPath(ws,f.memory,'era-authored-provenance.json'))).toBe(false);expect(readFileSync(join(f.memory,'era-summary.md'),'utf8')).toBe('new authored era');
   expect(readDerivedMemoryState(ws,f.memory,'live-state.json').eraChanged).toBe(true);
 });
 it('path lookup grants no write and unknown leaves refuse',()=>{
   const ws=f.ws();expect(derivedMemoryPaths(f.memory,'live-state.json',ws).requested).toBe(localPath(ws,f.memory,'live-state.json'));expect(fs.existsSync(ws.paths.local)).toBe(false);expect(errorCode(()=>derivedMemoryPaths(f.memory,'arbitrary.txt',ws))).toBe('WORKSPACE_STATE_INVALID');
 });
});

it('legacy derived path lookup is platform independent',()=>{
 expect(derivedMemoryPaths('/fixture/memory','live-state.json').resolved).toBe('/fixture/memory/live-state.json');
});
