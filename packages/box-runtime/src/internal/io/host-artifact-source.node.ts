import {constants,type Stats} from "node:fs";
import {open,lstat,type FileHandle} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {createHash} from "node:crypto";
import {canonicalJson,sha256Bytes,sha256Text} from "@grokbox/runtime-kernel/hash";
import {parseConfigJson} from "@grokbox/runtime-kernel/config";
import {NATIVE_CHECKPOINT_PAIR} from "../host/native-checkpoint-pair.ts";
import {applyPatchProfile,approvedSliceSet,MAX_APPROVED_SLICES,type PatchProfile} from "../host/profile.ts";
export class HostSourceFailure extends Error {constructor(readonly code:"source-unavailable"|"source-changed"|"invalid-profile"){super(code);}}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
export type HostArtifactPaths={source:string;worker:string;profile:string|null};
export type HostArtifacts={source:Uint8Array;worker:Uint8Array;candidate:Uint8Array|null;sourceSha:string;workerSha:string;profileDigest:string|null;
  sourceSet:string;profile:PatchProfile|null;companionQualification:"not-required"|"matched"|"unreviewed";applicability:"exact"|"mismatch"|"profile-unavailable";failureCode:string|null;sliceId:string|null;current:()=>Promise<boolean>};
/** Stable reads of one explicit installation set. Realpath aliases are not
 * accepted as new inputs; stat and digest are checked around the actual reads,
 * then the entire set is rechecked. This is not an upstream supervisor lock. */
export async function readHostArtifacts(paths:HostArtifactPaths,signal?:AbortSignal):Promise<HostArtifacts>{
  const opened:{path:string;file:FileHandle;stat:Stats;bytes:Uint8Array}[]=[];
  async function read(path:string,max:number,optional=false){
    if(!isAbsolute(path))throw new HostSourceFailure("source-unavailable");
    try{
      signal?.throwIfAborted();const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await file.stat();
      const row={path,file,stat,bytes:new Uint8Array()};opened.push(row);
      if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o022)!==0||stat.size<1||stat.size>max)throw new HostSourceFailure("source-unavailable");
      const bytes=Buffer.alloc(stat.size+1);let offset=0;
      while(offset<bytes.length){signal?.throwIfAborted();const got=await file.read(bytes,offset,bytes.length-offset,offset);if(!got.bytesRead)break;offset+=got.bytesRead;}
      if(offset!==stat.size||!same(stat,await file.stat())||!same(stat,await lstat(path)))throw new HostSourceFailure("source-changed");
      row.bytes=bytes.subarray(0,offset);return row.bytes;
    }catch(error){if(optional&&(error as any)?.code==="ENOENT")return null;throw error;}
  }
  try{
    const source=(await read(paths.source,64*1024*1024))!,worker=(await read(paths.worker,64*1024*1024))!,profileBytes=paths.profile===null?null:await read(paths.profile,1024*1024,true);
    const sourceSha=sha256Bytes(source),workerSha=sha256Bytes(worker),profileDigest=profileBytes?sha256Bytes(profileBytes):null;
    let profile:PatchProfile|null=null;
    if(profileBytes){try{
      const v=parseConfigJson(new TextDecoder("utf-8",{fatal:true}).decode(profileBytes)) as PatchProfile;
      if(!v||typeof v.profileId!=="string"||v.profileId.length>128||!Array.isArray(v.slices)||v.slices.length>MAX_APPROVED_SLICES||!approvedSliceSet(v.slices)
        ||!/^[a-f0-9]{64}$/.test(v.sourceSha256)||!/^[a-f0-9]{64}$/.test(v.transformedSourceSha256)||v.slices.some(s=>[s.startAnchor,s.endAnchor,s.find,s.replacement].some(x=>typeof x!=="string"||x.length>65536)))throw Error();
      profile=v;
    }catch{profile=null;}}
    const result=profile?applyPatchProfile(new TextDecoder("utf-8",{fatal:true}).decode(source),profile):null;
    const identities=opened.map(r=>({path:r.path,stat:r.stat,digest:sha256Bytes(r.bytes)}));
    const current=async()=>{try{
      if(profileBytes===null&&paths.profile!==null&&await lstat(paths.profile).then(()=>true,()=>false))return false;
      for(const r of identities){
        if(!same(r.stat,await lstat(r.path)))return false;
        // Millisecond stat precision can hide a same-size rewrite in the same
        // clock tick. Recheck actual bytes through a new read-only descriptor;
        // unchanged metadata alone is not an immutable-source certificate.
        const file=await open(r.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
          if(!same(r.stat,await file.stat()))return false;
          const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;
          while(offset<=r.stat.size){signal?.throwIfAborted();const n=await file.read(buffer,0,Math.min(buffer.length,r.stat.size+1-offset),offset);if(!n.bytesRead)break;offset+=n.bytesRead;hash.update(buffer.subarray(0,n.bytesRead));}
          if(offset!==r.stat.size||hash.digest("hex")!==r.digest||!same(r.stat,await file.stat())||!same(r.stat,await lstat(r.path)))return false;
        }finally{await file.close();}
      }
      return true;
    }catch{return false;}};
    if(!await current())throw new HostSourceFailure("source-changed");
    return {source,worker,sourceSha,workerSha,profileDigest,profile,
      companionQualification:profile?.slices.some(s=>s.id.startsWith("continuity-native-"))?(sourceSha===NATIVE_CHECKPOINT_PAIR.host&&workerSha===NATIVE_CHECKPOINT_PAIR.worker?"matched":"unreviewed"):"not-required",candidate:result?.ok?Buffer.from(result.source):null,
      applicability:result===null?"profile-unavailable":result.ok?"exact":"mismatch",failureCode:result&&!result.ok?result.code:profileBytes&&!profile?"invalid-profile":null,sliceId:result&&!result.ok?result.sliceId??null:null,
      sourceSet:sha256Text(canonicalJson([sourceSha,workerSha,profileDigest])),current};
  }catch(error){if(error instanceof HostSourceFailure)throw error;throw new HostSourceFailure("source-unavailable");}
  finally{await Promise.all(opened.map(r=>r.file.close()));}
}
