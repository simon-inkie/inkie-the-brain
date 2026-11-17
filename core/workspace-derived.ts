import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type Workspace, resolveWorkspaceWrite } from './workspace.js';
import { derivedMemoryPaths } from './derived-state.js';
import { entryExists, fail, readHeldSync } from './workspace-fs.js';
import { readWorkspaceBytesSync, readWorkspaceMemoryBytes, writeWorkspaceDerived, removeWorkspaceDerived } from './workspace-read.js';
import { readMemoryNotes } from './workspace-memory.js';
export type StateKind='live-state.json'|'observer-state.json';
type State=Record<string,unknown>;
const ERA_NAMES=['era-summary.md','era-summary.meta.json'] as const;
type Hashes=Record<typeof ERA_NAMES[number],string|null>;
export interface DerivedMemoryView {state:State; eraSummary:string|null; eraMeta:State|null; sourceHashes:Hashes; eraChanged:boolean; warnings:string[]}
function object(bytes:Buffer,label:string):State {
  let value:unknown; try {value=JSON.parse(bytes.toString('utf8'));} catch {fail('WORKSPACE_STATE_INVALID',`${label} must be valid JSON`);}
  if (!value || typeof value!=='object' || Array.isArray(value)) fail('WORKSPACE_STATE_INVALID',`${label} must be an object`);
  return value as State;
}
function validateDate(value:unknown):void {
  if (value===undefined || value===null) return;
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value)
    fail('WORKSPACE_STATE_INVALID','invalid era coverage date');
}
function validateState(state:State):void {
  for (const [key,value] of Object.entries(state)) {
    if (/(?:Threshold|MaxAgeMs|MinGapMs)$/.test(key) || /(?:Count|Chars)$/.test(key) || key==='configuredHotReflectionCount')
      if (typeof value!=='number' || !Number.isFinite(value) || value<0 || !Number.isSafeInteger(value)) fail('WORKSPACE_STATE_INVALID','invalid state counter or configuration');
  }
  for (const key of ['eraCompressionLevel','maxEraCompressionLevel']) if (state[key]!==undefined && (!Number.isInteger(state[key]) || Number(state[key])<0 || Number(state[key])>3)) fail('WORKSPACE_STATE_INVALID','invalid era level');
  for (const [key,value] of Object.entries(state)) if (/At$/.test(key) && value!==null && (typeof value!=='string' || !Number.isFinite(Date.parse(value))))
    fail('WORKSPACE_STATE_INVALID','invalid state timestamp');
  validateDate(state.eraCoverageThroughReflectionDate);
}
function authored(ws:Workspace,memory:string,name:string):Buffer|null {
  const requested=join(memory,name); resolveWorkspaceWrite(ws,requested,{within:memory});
  return entryExists(requested)?readWorkspaceMemoryBytes(ws,memory,name,2*1024*1024):null;
}
function local(ws:Workspace,memory:string,name:string):Buffer|null {
  const {requested}=derivedMemoryPaths(memory,name,ws);
  return entryExists(requested)?readHeldSync(requested,p=>resolveWorkspaceWrite(ws,p,{within:ws.localBrain}),2*1024*1024):null;
}
function eraInputs(ws:Workspace,memory:string) {
  const bytes=Object.fromEntries(ERA_NAMES.map(n=>[n,authored(ws,memory,n)])) as Record<typeof ERA_NAMES[number],Buffer|null>;
  const hashes=Object.fromEntries(ERA_NAMES.map(n=>[n,bytes[n]===null?null:createHash('sha256').update(bytes[n]!).digest('hex')])) as Hashes;
  const meta=bytes['era-summary.meta.json']===null?null:object(bytes['era-summary.meta.json']!,'authored era metadata');
  if (meta) {validateDate(meta.coverageLatestReflectionDate); const level=meta.level??0; if (!Number.isInteger(level)||Number(level)<0||Number(level)>3) fail('WORKSPACE_STATE_INVALID','invalid authored era level');}
  const provBytes=local(ws,memory,'era-authored-provenance.json'); const previous=provBytes===null?null:object(provBytes,'era provenance');
  if (previous && (Object.keys(previous).length!==2 || ERA_NAMES.some(n=>previous[n]!==null && (typeof previous[n]!=='string'||!/^[a-f0-9]{64}$/.test(previous[n] as string))))) fail('WORKSPACE_STATE_INVALID','invalid era provenance hashes');
  const localEra=local(ws,memory,'era-summary.md'); const localMetaBytes=local(ws,memory,'era-summary.meta.json');
  const localMeta=localMetaBytes===null?null:object(localMetaBytes,'local era metadata');
  if (localMeta) {validateDate(localMeta.coverageLatestReflectionDate);if (!Number.isInteger(localMeta.level??0)||Number(localMeta.level??0)<0||Number(localMeta.level??0)>3) fail('WORKSPACE_STATE_INVALID','invalid local era level');}
  // An absent provenance with leftover local era is a stale generation, never
  // proof of current coverage. Present malformed provenance is always an error.
  const changed=previous===null || ERA_NAMES.some(n=>previous[n]!==hashes[n]);
  return {bytes,hashes,changed,meta,localEra,localMeta};
}
export function readDerivedMemoryState(ws:Workspace,memoryDir:string,kind:StateKind):DerivedMemoryView {
  if (kind!=='live-state.json'&&kind!=='observer-state.json') fail('WORKSPACE_STATE_INVALID','unsupported state kind');
  const memory=resolveWorkspaceWrite(ws,memoryDir,{within:ws.paths.silos});
  const truthBytes=authored(ws,memory,kind); const currentBytes=local(ws,memory,kind);
  const truth=truthBytes===null?{}:object(truthBytes,'authored state'); const current=currentBytes===null?null:object(currentBytes,'local state');
  validateState(truth); if (current) validateState(current);
  const era=eraInputs(ws,memory); let state:State;
  if (kind==='observer-state.json') {
    const config=Object.fromEntries(Object.entries(truth).filter(([k])=>/(?:Threshold|MaxAgeMs|MinGapMs)$/.test(k)));
    const notes=readMemoryNotes(ws,memory); const latest=Math.max(0,...notes.reflections.map(n=>n.mtimeMs)); const pending=notes.observations.filter(n=>n.mtimeMs>latest);
    const runtime=Object.fromEntries(Object.entries(current??{}).filter(([k])=>!/(?:Threshold|MaxAgeMs|MinGapMs)$/.test(k)));
    state={unprocessedObservationCount:pending.length,unprocessedObservationChars:pending.reduce((n,p)=>n+Array.from(p.text).length,0),...runtime,...config};
  } else {
    const configKeys=['softBudgetChars','hardBudgetChars','minHotReflectionCount','maxEraCompressionLevel'];
    const config={softBudgetChars:80000,hardBudgetChars:120000,minHotReflectionCount:1,maxEraCompressionLevel:3,...Object.fromEntries(Object.entries(truth).filter(([k])=>configKeys.includes(k)))};
    const configuredHot=truth.hotReflectionCount??3;
    if (Number(config.softBudgetChars)>Number(config.hardBudgetChars) || Number(config.minHotReflectionCount)>Number(configuredHot))
      fail('WORKSPACE_STATE_INVALID','authored budgets or hot target conflict');
    let effective=current?.hotReflectionCount??configuredHot;
    if (current && (current.configuredHotReflectionCount??configuredHot)!==configuredHot) effective=configuredHot;
    effective=Math.max(Number(config.minHotReflectionCount),Math.min(Number(configuredHot),Number(effective)));
    state={eraCompressionLevel:0,eraCoverageThroughReflectionDate:null,lastRebuildAt:null,lastBlockCharCount:0,...current,...config,configuredHotReflectionCount:configuredHot,hotReflectionCount:effective};
    if (era.changed || current===null || era.localEra===null) {
      state.eraCompressionLevel=era.bytes['era-summary.md']!==null?era.meta?.level??0:0;
      state.eraCoverageThroughReflectionDate=era.bytes['era-summary.md']!==null?era.meta?.coverageLatestReflectionDate??null:null;
    }
  }
  validateState(state);
  return {state,eraSummary:(era.changed?era.bytes['era-summary.md']:era.localEra??era.bytes['era-summary.md'])?.toString('utf8')??null,
    eraMeta:era.changed?era.meta:era.localMeta??era.meta,sourceHashes:era.hashes,eraChanged:era.changed,warnings:era.changed&&current!==null?['Authored era changed; stale derived era ignored']:[]};
}
/** Refresh only disposable files. Source hashes are rechecked before publishing
 * provenance. A partial refresh has no matching receipt and cannot be promoted.
 * No active pointer CAS, managed reset or success timestamp is provided here. */
export async function refreshDerivedMemoryState(ws:Workspace,memoryDir:string,kind:StateKind):Promise<DerivedMemoryView> {
  const memory=resolveWorkspaceWrite(ws,memoryDir,{within:ws.paths.silos}); const view=readDerivedMemoryState(ws,memory,kind);
  const snapshot=eraInputs(ws,memory);
  const path=(name:string)=>derivedMemoryPaths(memory,name,ws).requested;
  // Remove the old receipt first, so a failed replacement never certifies mixed
  // era generations. Each unlink/write remains confined and identity checked.
  const replaceEra=snapshot.changed || (snapshot.localEra===null && snapshot.bytes['era-summary.md']!==null) || (snapshot.localMeta===null && snapshot.meta!==null);
  if (replaceEra) {
    await removeWorkspaceDerived(ws,path('era-authored-provenance.json'));
    for (const name of ERA_NAMES) {
      const bytes=snapshot.bytes[name];
      if (bytes===null) await removeWorkspaceDerived(ws,path(name)); else await writeWorkspaceDerived(ws,path(name),bytes);
    }
  }
  await writeWorkspaceDerived(ws,path(kind),JSON.stringify(view.state));
  const now=eraInputs(ws,memory);
  if (ERA_NAMES.some(n=>now.hashes[n]!==view.sourceHashes[n])) fail('WORKSPACE_IDENTITY_CHANGED','authored era changed during refresh');
  await writeWorkspaceDerived(ws,path('era-authored-provenance.json'),JSON.stringify(view.sourceHashes));
  return readDerivedMemoryState(ws,memory,kind);
}
