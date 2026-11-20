import { basename, dirname, join, resolve } from 'node:path';
import { closeSync } from 'node:fs';
import { resolveWorkspaceWrite, resolveWorkspaceRead, workspaceAgentPaths, type Workspace } from './workspace.js';
import { entryExists, fail, checkByteLimit, openHeldSync, readHeldSync, readHeldFileSync, listHeldSync } from './workspace-fs.js';
import { readWorkspaceTextSync, readWorkspaceMemoryBytes } from './workspace-read.js';
import { readDerivedMemoryState } from './workspace-derived.js';
export function resolveWorkspaceMemoryDir(ws:Workspace,projectDir:string,env:NodeJS.ProcessEnv=ws.env):string {
  const project=resolve(projectDir);
  const confine=(p:string)=>{if (p.startsWith('~')) fail('WRITE_OUTSIDE_WORKSPACE','HOME expansion is unavailable'); return resolveWorkspaceWrite(ws,p,{within:ws.paths.silos});};
  const name=env.AGENT_NAME?.trim();
  if (name && /^[a-z0-9][a-z0-9-]*$/i.test(name)) return confine(workspaceAgentPaths(ws,name).memoryDir);
  if (name) console.warn('[workspace] invalid AGENT_NAME; trying remaining memory tiers');
  const local=join(project,'memory');
  // Authorise the project before probing it. External pointers are read-only.
  resolveWorkspaceRead(ws,project);
  if (entryExists(local)) {
    const target=confine(local); const {fd}=openHeldSync(local,p=>confine(p),true);
    closeSync(fd); return target;
  }
  const pointer=join(project,'.the-brain','memory_root');
  resolveWorkspaceRead(ws,pointer);
  if (entryExists(pointer)) {
    const raw=readWorkspaceTextSync(ws,pointer,4096).trim();
    if (!raw) fail('WORKSPACE_MEMORY_POINTER_INVALID','present memory pointer must be nonblank');
    return confine(raw);
  }
  if (env.BRAIN_MEMORY_DIR?.trim()) return confine(env.BRAIN_MEMORY_DIR.trim());
  return confine(join(ws.paths.silos,basename(project),'memory'));
}
export interface MemoryNote {name:string; text:string; mtimeMs:number; bytes:number}
export function readMemoryNotes(ws:Workspace,memoryDir:string,maxInputBytes=2*1024*1024):{reflections:MemoryNote[];observations:MemoryNote[]} {
  checkByteLimit(maxInputBytes);
  const memory=resolveWorkspaceWrite(ws,memoryDir,{within:ws.paths.silos}); let used=0;
  const readZone=(zone:string):MemoryNote[]=>{
    const requested=join(memory,zone); const authorise=(p:string)=>resolveWorkspaceWrite(ws,p,{within:memory});
    authorise(requested); if (!entryExists(requested)) return [];
    return listHeldSync(requested,authorise).filter(n=>n.endsWith('.md')).map(name=>{
      const file=join(requested,name);
      const {bytes,info}=readHeldFileSync(file,authorise,Math.max(1,maxInputBytes-used)); used+=bytes.length;
      if (used>maxInputBytes) fail('WORKSPACE_INPUT_LIMIT','total note input exceeds limit');
      return {name:basename(name,'.md'),text:bytes.toString('utf8'),mtimeMs:info.mtimeMs,bytes:bytes.length};
    });
  };
  return {reflections:readZone('reflections'),observations:readZone('observations')};
}
/** Read-only context. Cached gists are explicitly marked; no receipt/state is
 * truncated, persisted or acknowledged. No model or inbox operation occurs. */
export async function renderWorkspaceMemory(ws:Workspace,memoryDir:string,opts:{cached?:boolean;maxOutputBytes?:number}={}):Promise<string> {
  const limit=opts.maxOutputBytes??(opts.cached?9500:2*1024*1024); checkByteLimit(limit);
  const memory=resolveWorkspaceWrite(ws,memoryDir,{within:ws.paths.silos});
  const view=readDerivedMemoryState(ws,memory,'live-state.json');
  for (const warning of view.warnings) console.warn('[workspace] '+warning);
  const notes=readMemoryNotes(ws,memory);
  const era=view.eraSummary??'';
  if (!notes.reflections.length && !notes.observations.length && !era) {
    const authored=join(dirname(memory),'MEMORY.md'); resolveWorkspaceWrite(ws,authored,{within:ws.paths.silos});
    if (entryExists(authored)) {
      const text=readHeldSync(authored,p=>resolveWorkspaceWrite(ws,p,{within:ws.paths.silos}),limit).toString('utf8');
      if (Buffer.byteLength(text)>limit) fail('WORKSPACE_OUTPUT_LIMIT','context exceeds output byte limit');
      return text;
    }
  }
  const hot=Number(view.state.hotReflectionCount); const recent=hot?notes.reflections.slice(-hot):[];
  const latest=Math.max(0,...notes.reflections.map(n=>n.mtimeMs));
  const pending=notes.observations.filter(n=>n.mtimeMs>latest);
  const gist=(note:MemoryNote)=>{const chars=Array.from(note.text); return opts.cached&&chars.length>500?chars.slice(0,500).join('')+'\n[...gist truncated, full body via recall]':note.text;};
  const section=(n:MemoryNote)=>`#### ${n.name}\n\n${gist(n)}\n`;
  const parts=['<!-- IO_LIVE_START -->','## 🧠 Live Observation Context','',
    '> Read-only workspace context. Edit authored reflections or era summary to change it.',
    ...(opts.cached?[]:[`> Current time: ${new Date().toISOString()}`]),
    `> era level=${view.state.eraCompressionLevel} · hot K=${hot} · elders=${notes.reflections.length-recent.length} · unprocessed=${pending.length}`,'',
    `### Era Summary (compressed, level ${view.state.eraCompressionLevel})`,'',era||'_Era summary not yet built._','',
    `### Recent Reflections (last ${recent.length})`,'',...recent.map(section),
    '### Unprocessed Observations','',...(pending.length?pending.map(n=>`#### ${n.name}\n\n${n.text}\n`):['_No new observations since the last reflection._']),
    '<!-- IO_LIVE_END -->',''];
  const outputBytes=parts.reduce((total,part)=>total+Buffer.byteLength(part),Math.max(0,parts.length-1));
  if (outputBytes>limit) fail('WORKSPACE_OUTPUT_LIMIT','context exceeds output byte limit');
  return parts.join('\n');
}
