import { FILE_SHA, FILE_UUID, FILE_POLICY as P, fileData, fileIdentity, fileBase64, validFileOperation,
  type FileEntry, type FileDirectory, type FileRead, type FileRootsView, type FileUpload, type FileDownload, type FileDownloadChunk, type FileChange } from "@grokbox/runtime-kernel/files";
const n=(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const ref=(v:unknown,i:string)=>{try{return fileIdentity(v,i).ref===v;}catch{return false;}};
const exact=(v:unknown,keys:string[])=>{try{return fileData(v,keys);}catch{return null;}};
export function fileRoots(v:unknown,i:string):v is FileRootsView{
  const r=exact(v,["roots","state","coverage"]);if(!r||!["ready","unconfigured","unavailable"].includes(r.state as string)||r.coverage!=="configured-named-roots"||!Array.isArray(r.roots)||r.roots.length>32)return false;
  const names=new Set<string>();
  for(const v of r.roots){const root=exact(v,["name","ref","binding","operations","externalCompareAndSwap"]);
    if(!root||typeof root.name!=="string"||names.has(root.name)||!ref(root.ref,i)||root.binding!==fileIdentity(root.ref,i).binding||root.name!==fileIdentity(root.ref,i).root||fileIdentity(root.ref,i).path!==""
      ||root.externalCompareAndSwap!==false||!Array.isArray(root.operations)||root.operations.some(o=>!["stat","list","read","download","write","mkdir","upload","remove","remove-recursive","restore"].includes(o)))return false;
    names.add(root.name);
  }
  return r.state==="ready"?r.roots.length>0:r.roots.length===0;
}
export function fileEntry(v:unknown,i:string,expectedRef?:string):v is FileEntry{
  const r=exact(v,["ref","name","kind","size","mode","modifiedAt","revision"]);
  return !!r&&ref(r.ref,i)&&(expectedRef===undefined||r.ref===expectedRef)&&typeof r.name==="string"&&r.name.length<=512&&!/[\x00-\x1f]/.test(r.name)
    &&["file","directory"].includes(r.kind as string)&&n(r.size)&&typeof r.mode==="string"&&/^0o[0-7]{3}$/.test(r.mode)
    &&typeof r.modifiedAt==="string"&&Number.isFinite(Date.parse(r.modifiedAt))&&(r.revision===null||typeof r.revision==="string"&&FILE_SHA.test(r.revision));
}
export function fileDirectory(v:unknown,i:string,target:string):v is FileDirectory{
  const r=exact(v,["ref","entries","complete","nextCursor","snapshot","contentIncluded"]);
  if(!r||r.ref!==target||typeof r.complete!=="boolean"||typeof r.snapshot!=="string"||!FILE_SHA.test(r.snapshot)||r.contentIncluded!==false||!Array.isArray(r.entries)||r.entries.length>100
    ||(r.complete?r.nextCursor!==null:typeof r.nextCursor!=="string"||r.nextCursor.split(":").length!==2||r.nextCursor.split(":")[0]!==r.snapshot||!/^[1-9][0-9]*$/.test(r.nextCursor.split(":")[1]!)))return false;
  const parent=fileIdentity(target,i),names=new Set<string>();
  for(const e of r.entries){if(!fileEntry(e,i))return false;const t=fileIdentity(e.ref,i);
    if(t.root!==parent.root||t.binding!==parent.binding||t.path!==(parent.path?`${parent.path}/`:"")+e.name||names.has(e.name))return false;names.add(e.name);}
  return true;
}
export function fileRead(v:unknown,i:string,target:string):v is FileRead{
  const r=exact(v,["ref","size","sha256","contentBase64","encoding"]);
  try{return !!r&&r.ref===target&&ref(r.ref,i)&&n(r.size,P.readBytes)&&typeof r.sha256==="string"&&FILE_SHA.test(r.sha256)&&r.encoding==="base64"&&fileBase64(r.contentBase64,P.readBytes)===r.size;}catch{return false;}
}
export function fileUpload(v:unknown,i:string,r:Extract<FileChange,{action:"upload"}>):v is FileUpload{
  const u=exact(v,["requestId","ref","generation","chunkBytes","size","sha256","chunks","operation"]);
  return !!u&&u.requestId===r.requestId&&u.ref===r.ref&&typeof u.generation==="string"&&FILE_UUID.test(u.generation)&&u.chunkBytes===P.chunkBytes&&u.size===r.size&&u.sha256===r.sha256
    &&u.chunks===Math.ceil(r.size/P.chunkBytes)&&validFileOperation(u.operation,i,r.requestId,r)&&u.operation.state==="unknown"&&u.operation.serviceGeneration===u.generation;
}
export function fileDownload(v:unknown,i:string,id:string,target:string):v is FileDownload{
  const r=exact(v,["requestId","ref","generation","size","sha256","chunkBytes","chunks"]);
  return !!r&&r.requestId===id&&r.ref===target&&ref(r.ref,i)&&typeof r.generation==="string"&&FILE_UUID.test(r.generation)&&n(r.size,P.maxBytes)
    &&typeof r.sha256==="string"&&FILE_SHA.test(r.sha256)&&r.chunkBytes===P.chunkBytes&&r.chunks===Math.ceil(r.size/P.chunkBytes);
}
export function fileDownloadChunk(v:unknown,opened:FileDownload,index:number):v is FileDownloadChunk{
  const r=exact(v,["requestId","index","bytes","contentBase64","done"]);
  try{return !!r&&r.requestId===opened.requestId&&r.index===index&&r.bytes===Math.min(P.chunkBytes,opened.size-index*P.chunkBytes)&&fileBase64(r.contentBase64,P.chunkBytes)===r.bytes&&r.done===(index===opened.chunks-1);}catch{return false;}
}
export async function verifyFileBytes(contentBase64:string,sha256:string):Promise<boolean>{
  const raw=atob(contentBase64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  const hash=new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",bytes));return Array.from(hash,n=>n.toString(16).padStart(2,"0")).join("")===sha256;
}
