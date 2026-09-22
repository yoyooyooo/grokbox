import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseConfigJson } from "@grokbox/runtime-kernel/config";
import { DESKTOP_POLICY, DESKTOP_UUID, DEFAULT_MIN_IDLE_MS, displayFromEnviron, inspectDesktopProc, type DesktopWorld } from "@grokbox/runtime-kernel/desktop";
import { HostResourceError } from "./host-resource-contract.ts";
export type DesktopSourcePaths={assignments:string;agents:string;x11:string;proc:string;temporary:string};
export const DESKTOP_SOURCE_PATHS:DesktopSourcePaths={assignments:"/home/box/.sand-window-assignments.json",agents:"/home/box/agent-data/agents",x11:"/tmp/.X11-unix",proc:"/proc",temporary:"/tmp"};
const unavailable=()=>new HostResourceError("desktop_unavailable","Required desktop observations are missing, malformed or incomplete.");
const absent=(error:unknown)=>["ENOENT","ESRCH"].includes(String((error as NodeJS.ErrnoException)?.code));
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
async function bounded(path:string,max:number,regular=true):Promise<Buffer>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await file.stat();if(regular&&(!before.isFile()||before.nlink!==1||before.size>max))throw unavailable();
    const bytes=Buffer.alloc(max+1);let offset=0;
    while(offset<bytes.length){const result=await file.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;}
    if(offset>max)throw unavailable();const after=await file.stat();
    if(regular&&(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs))throw unavailable();return bytes.subarray(0,offset);
  }finally{await file.close();}
}
async function processIdentity(directory:string){const text=(await bounded(join(directory,"stat"),16384,false)).toString("utf8"),end=text.lastIndexOf(")");const id=text.slice(end+2).split(" ")[19];if(end<0||!/^\d+$/.test(id??""))throw unavailable();return id!;}
/** A finite, read-only source observation. Permission/parse failures are not an
 * empty seating table or absence of work. No source contents leave this adapter. */
export async function readDesktopWorld(nowMs:number,paths:DesktopSourcePaths=DESKTOP_SOURCE_PATHS,signal?:AbortSignal):Promise<DesktopWorld>{
  signal?.throwIfAborted();const assignmentBytes=await bounded(paths.assignments,128*1024),value=parseConfigJson(assignmentBytes.toString("utf8"));
  if(!record(value)||!record(value.assignments)||Object.keys(value.assignments).length>DESKTOP_POLICY.maxSeats)throw unavailable();
  const assignments:Record<string,number>={},names:Record<string,string>={},displayIdentities:Record<number,string>={};
  for(const [id,d]of Object.entries(value.assignments)){if(!DESKTOP_UUID.test(id)||!Number.isSafeInteger(d)||Number(d)<1||Number(d)>65535||Object.hasOwn(assignments,id.toLowerCase()))throw unavailable();assignments[id.toLowerCase()]=Number(d);}
  let complete=true;const litDisplays=new Set<number>(),displayStartedAtMs:Record<number,number>={},transcriptWrittenAtMs:Record<string,number>={},busyMarkers=new Set<number>();
  for(const display of new Set(Object.values(assignments))){signal?.throwIfAborted();try{const info=await lstat(join(paths.x11,`X${display}`));if(!info.isSocket()||info.uid!==process.getuid?.())throw unavailable();litDisplays.add(display);displayStartedAtMs[display]=Math.round(info.ctimeMs);displayIdentities[display]=sha256Text(canonicalJson([display,info.dev,info.ino,info.ctimeMs]));}catch(error){if(!absent(error))complete=false;}
    try{const info=await lstat(join(paths.temporary,`sand-monitor-busy-${display}`));if(!info.isFile()||info.isSymbolicLink())throw unavailable();if(nowMs-Math.round(info.mtimeMs)<DEFAULT_MIN_IDLE_MS)busyMarkers.add(display);}catch(error){if(!absent(error))complete=false;}
  }
  for(const id of Object.keys(assignments)){let latest:number|undefined;for(const name of ["store.db","store.db-wal","conversation-blobs.db","conversation-blobs.db-wal"]){signal?.throwIfAborted();try{const info=await lstat(join(paths.agents,id,name));if(!info.isFile()||info.isSymbolicLink())throw unavailable();latest=Math.max(latest??0,Math.round(info.mtimeMs));}catch(error){if(!absent(error))complete=false;}}
    if(latest===undefined){complete=false;transcriptWrittenAtMs[id]=nowMs;}else transcriptWrittenAtMs[id]=latest;
    try{const profile=parseConfigJson((await bounded(join(paths.agents,id,"profile.json"),32768)).toString("utf8"));if(record(profile)&&typeof profile.name==="string")names[id]=Array.from(profile.name).slice(0,128).join("");}catch{/* Optional labels have no authority. */}
  }
  const grokDisplays=new Set<number>(),taskDisplays=new Set<number>(),startWindowDisplays=new Set<number>(),entries=await readdir(paths.proc);
  if(entries.length>16384)throw unavailable();
  for(const pid of entries){if(!/^\d+$/.test(pid))continue;signal?.throwIfAborted();try{
    const directory=join(paths.proc,pid);if((await lstat(directory)).uid!==process.getuid?.())continue;
    const before=await processIdentity(directory),cmdline=(await bounded(join(directory,"cmdline"),65536,false)).toString("utf8");if(!cmdline)continue;
    const environ=(await bounded(join(directory,"environ"),65536,false)).toString("utf8");if(await processIdentity(directory)!==before){complete=false;continue;}
    const inspected=inspectDesktopProc(cmdline),display=displayFromEnviron(environ);if(inspected.startWindow!==undefined)startWindowDisplays.add(inspected.startWindow);
    if(display!==undefined){if(inspected.grok)grokDisplays.add(display);if(inspected.task)taskDisplays.add(display);}
  }catch(error){if(!absent(error))complete=false;}}
  // Do not combine an old seating/socket identity with a later process scan.
  // This is a finite before/after observation, not an atomic native seat lease.
  try{if(!assignmentBytes.equals(await bounded(paths.assignments,128*1024)))complete=false;}catch{complete=false;}
  for(const display of new Set(Object.values(assignments))){
    signal?.throwIfAborted();
    try{const info=await lstat(join(paths.x11,`X${display}`));
      if(!info.isSocket()||info.uid!==process.getuid?.()||sha256Text(canonicalJson([display,info.dev,info.ino,info.ctimeMs]))!==displayIdentities[display])complete=false;
    }catch(error){if(!absent(error)||litDisplays.has(display))complete=false;}
  }
  signal?.throwIfAborted();return {complete,displayIdentities,nowMs,assignments,names,litDisplays,displayStartedAtMs,transcriptWrittenAtMs,busyMarkers,grokDisplays,taskDisplays,startWindowDisplays};
}
