import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { projectControlEvent } from "./journal.node.ts";
import { eventsPath } from "./paths.ts";
import { inspectJournalSegments, isJournalSegmentHeader, type JournalSegmentEntry } from "../host/journal-segments.node.ts";
export type JournalCursor={version:1;device:string;inode:string;offset:number;anchorLength:number;anchorHash:string;boundaryLength?:number;boundaryHash?:string;skipping:boolean};
const BATCH_BYTES=256*1024,LINE_BYTES=64*1024,BATCH_LINES=512;
function parse(cursor:string|null):JournalCursor|null{
 if(cursor===null)return null;
 const v=JSON.parse(cursor);if(v===null)return null;if(v.version!==1||typeof v.device!=="string"||typeof v.inode!=="string"||!Number.isSafeInteger(v.offset)||v.offset<0||!Number.isSafeInteger(v.anchorLength)||v.anchorLength<0||v.anchorLength>64||typeof v.anchorHash!=="string"||typeof v.skipping!=="boolean")throw Error("journal_cursor_invalid");
 if((v.boundaryLength!==undefined||v.boundaryHash!==undefined)&&(!Number.isSafeInteger(v.boundaryLength)||v.boundaryLength<0||v.boundaryLength>64||v.boundaryLength>v.offset||typeof v.boundaryHash!=="string"||!/^[a-f0-9]{64}$/.test(v.boundaryHash)))throw Error("journal_cursor_invalid");return v;
}
/** Read forward, bounded per batch. Caller commits nextCursor atomically with
 * indexed facts. Partial trailing lines are not acknowledged or invented. */
async function readSingleJournalBatch(path:string,previous:string|null,expected?:JournalSegmentEntry){
 const saved=parse(previous),gaps:string[]=[];
 let handle;
 try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(e){return {events:[] as unknown[],nextCursor:previous,hasMore:false,gap:e&&typeof e==="object"&&"code"in e&&e.code==="ENOENT"?"missing":"unavailable",readBytes:0};}
 try{
  const stat=await handle.stat();if(!stat.isFile())return {events:[] as unknown[],nextCursor:previous,hasMore:false,gap:"unsafe_file",readBytes:0};
  if(expected&&(String(stat.dev)!==expected.device||String(stat.ino)!==expected.inode||(expected.sealed&&stat.size!==expected.bytes)))return {events:[] as unknown[],nextCursor:previous,hasMore:false,gap:"segment_changed",readBytes:0};
  const device=String(stat.dev),inode=String(stat.ino);let offset=saved?.offset??0,skipping=saved?.skipping??false;
  let anchorLength=saved&&saved.device===device&&saved.inode===inode&&saved.anchorLength>0?Math.min(saved.anchorLength,stat.size):Math.min(64,stat.size);
  const anchor=Buffer.alloc(anchorLength);await handle.read(anchor,0,anchor.length,0);const anchorHash=sha256Text(anchor.toString("hex"));
  if(saved&&(saved.device!==device||saved.inode!==inode)){offset=0;skipping=false;gaps.push("rotated");}
  else if(saved&&(stat.size<offset||(saved.anchorLength>0&&saved.anchorHash!==anchorHash))){offset=0;skipping=false;gaps.push("rewritten");}
  else if(saved&&saved.boundaryLength!==undefined){
   const boundary=Buffer.alloc(saved.boundaryLength);await handle.read(boundary,0,boundary.length,offset-boundary.length);
   if(sha256Text(boundary.toString("hex"))!==saved.boundaryHash){offset=0;skipping=false;gaps.push("rewritten");}
  }
  const data=Buffer.alloc(Math.min(BATCH_BYTES,Math.max(0,stat.size-offset))),read=await handle.read(data,0,data.length,offset),bytes=data.subarray(0,read.bytesRead);
  const events:unknown[]=[];let consumed=0,lines=0;
  for(let start=0;start<bytes.length;){
   const end=bytes.indexOf(10,start);
   if(end<0){if(bytes.length-start>LINE_BYTES||skipping){consumed=bytes.length;skipping=true;gaps.push("oversized_line");}break;}
   const line=bytes.subarray(start,end);consumed=end+1;start=end+1;
   if(skipping){skipping=false;gaps.push("oversized_line");continue;}
   if(line.length>LINE_BYTES){gaps.push("oversized_line");continue;}
   if(line.length){try{const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(line));if(raw?.name==="journal_retention"){gaps.push("retention");}else if(isJournalSegmentHeader(raw)){/* segment identity is metadata, not an event */}else{const event=projectControlEvent(raw);if(event)events.push(event);else gaps.push("unsupported_schema");}}catch{gaps.push("malformed_line");}}
   if(++lines>=BATCH_LINES)break;
  }
  const after=await handle.stat();if(after.size<stat.size)return {events:[] as unknown[],nextCursor:previous,hasMore:true,gap:"changed_during_read",readBytes:read.bytesRead};
  const nextOffset=offset+consumed,boundaryLength=Math.min(64,nextOffset),boundary=Buffer.alloc(boundaryLength);
  await handle.read(boundary,0,boundary.length,nextOffset-boundaryLength);
  const next:JournalCursor={version:1,device,inode,offset:nextOffset,anchorLength,anchorHash,boundaryLength,boundaryHash:sha256Text(boundary.toString("hex")),skipping};
  return {events,nextCursor:JSON.stringify(next),hasMore:consumed>0&&offset+consumed<stat.size,gap:gaps.length?[...new Set(gaps)].join(","):undefined,readBytes:read.bytesRead};
 }finally{await handle.close();}
}

type SegmentCursor = { version: 2; segmentId: string; sequence: number; completed: boolean; cursor: string };
/** A segment ID survives rename. Each batch still has the original inode,
 * boundary hash and byte budget; no cursor is advanced by a GET elsewhere. */
export type JournalBatch = { events: unknown[]; nextCursor: string | null; hasMore: boolean; readBytes: number; gap?: string; deferred?: "rotation_in_progress" };
export async function readJournalBatch(root: string, previous: string | null): Promise<JournalBatch> {
  const raw = previous === null ? null : JSON.parse(previous);
  let saved: SegmentCursor | null = null;
  if (raw?.version === 2) {
    if (typeof raw.segmentId !== "string" || !/^[a-f0-9-]{36}$/.test(raw.segmentId)
      || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || typeof raw.completed !== "boolean" || typeof raw.cursor !== "string") throw Error("journal_cursor_invalid");
    parse(raw.cursor); saved = raw;
  } else parse(previous);
  let inventory: Awaited<ReturnType<typeof inspectJournalSegments>>;
  try { inventory = await inspectJournalSegments(root); }
  catch { return { events: [] as unknown[], nextCursor: previous, hasMore: false, gap: "segment_index_unavailable", readBytes: 0 }; }
  if (inventory.mode === "legacy") {
    if (saved) return { events: [] as unknown[], nextCursor: previous, hasMore: false, gap: "segment_index_missing", readBytes: 0 };
    return readSingleJournalBatch(eventsPath(root), previous);
  }
  // The rename/create interval is a transition, not itself lost evidence or a
  // new fault. Keep the cursor, expose pending state, and try on the next tick.
  if (inventory.pending) return { events: [], nextCursor: previous, hasMore: false, readBytes: 0, deferred: "rotation_in_progress" };
  const gaps = [...inventory.gaps];
  let selected: JournalSegmentEntry | undefined, inner: string | null = null;
  if (saved) {
    selected = inventory.entries.find(e => e.id === saved!.segmentId && e.sequence === saved!.sequence);
    if (selected && !saved.completed) inner = saved.cursor;
    else {
      if (!selected) gaps.push("retired_segment");
      selected = inventory.entries.find(e => e.sequence > saved!.sequence);
    }
  } else if (raw) {
    const legacy = parse(previous)!;
    selected = inventory.entries.find(e => e.device === legacy.device && e.inode === legacy.inode);
    if (selected) inner = previous;
    else { selected = inventory.entries[0]; gaps.push("retired_segment"); }
  } else {
    selected = inventory.entries[0];
    if (inventory.retiredSegments > 0) gaps.push("retention");
  }
  if (!selected) return { events: [] as unknown[], nextCursor: previous, hasMore: false,
    gap: gaps.length ? [...new Set(gaps)].join(",") : undefined, readBytes: 0 };
  const result = await readSingleJournalBatch(selected.path, inner, selected);
  if (result.gap) gaps.push(result.gap);
  if (!result.nextCursor || ["segment_changed", "unsafe_file", "unavailable", "missing", "changed_during_read"].includes(result.gap ?? "")) {
    return { ...result, nextCursor: previous, hasMore: false, gap: [...new Set(gaps)].join(",") };
  }
  const position = parse(result.nextCursor)!;
  const completed = selected.sealed && !result.hasMore;
  if (completed && position.offset < selected.bytes) gaps.push("sealed_partial_line");
  const next: SegmentCursor = { version: 2, segmentId: selected.id, sequence: selected.sequence, cursor: result.nextCursor, completed };
  return { ...result, nextCursor: JSON.stringify(next), hasMore: result.hasMore || completed && inventory.entries.some(e => e.sequence > selected!.sequence),
    gap: gaps.length ? [...new Set(gaps)].join(",") : undefined };
}
