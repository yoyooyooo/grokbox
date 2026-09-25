import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { gunzipSync } from "node:zlib";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { projectHostHealth, projectHostRuntimeEvidence, projectHostWitnessEvidence, validStaticAnalysis, projectHostSourceWindow, type HostSourceWindow, type HostRuntimeEvidence, type HostWitnessEvidence, type HostHealthEvidence, type StaticAnalysis } from "@grokbox/runtime-kernel/host-health";
import { assertSafeDirectory } from "./config-layout.node.ts";
import { join } from "node:path";
import { CONTRACT_SLICE_NAMES } from "./contracts.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { boundedText, count, isRecord, observeJson, observeText, type ObservationState } from "./observation.node.ts";
import { hostBundlesDir, reviewedProfilePath } from "./paths.ts";
import { extractContractSlices, sliceHashes, type PatchProfile, type SlicePatch } from "../host/profile.ts";
import {
  ENVELOPE_WINDOWS_FILE,
  encodeEnvelopeWindows,
  envelopeProfileShape,
  envelopeWindowsFromRecipe,
} from "../ops/host-seam/envelope-windows.ts";

export const HOST_BUNDLE_KEEP = 16;
export const HOST_BUNDLE_OBSERVATION_LIMIT = 32;
const SHA = /^[a-f0-9]{64}$/;
const SOURCE_NAME = "source";

export type HostBundleMeta = {
  sourceSha: string;
  bytes: number;
  observedAt: string;
  matchedProfileId?: string;
};

export type HostBundlePatchImpact = {
  slice: (typeof CONTRACT_SLICE_NAMES)[number];
  status: "unchanged" | "drifted" | "missing" | "appeared";
  review: "none" | "re-review";
};

/** YELLOW: driftedSlices/patchImpact are the 4 contract windows only. Envelope green is envelopeDrift.
 * retain may persist envelope-windows.json from a 19-slice reviewed recipe even when the pin SHA
 * does not match this generation; never invent without reviewed. */
export type HostBundleDiff = {
  previousSha: string;
  previousBytes: number;
  currentBytes: number;
  previousLines: number;
  currentLines: number;
  addedLines: number;
  removedLines: number;
  hunks: number;
  driftedSlices: string[];
  patchImpact: HostBundlePatchImpact[];
};

export type HostBundleRetainResult = {
  sourceSha: string;
  retained: "new" | "existing";
  meta: HostBundleMeta;
  diff: HostBundleDiff | null;
};

export type HostBundlesObservation = {
  state: ObservationState | "partial";
  headState: ObservationState;
  head: string | null;
  generations: Array<{
    sourceSha: string;
    state: ObservationState;
    metadata: HostBundleMeta | null;
    diff: HostBundleDiff | null;
  }>;
  truncated: boolean;
  invalidEntries: number;
};

export function parseHostBundleMeta(value: unknown): HostBundleMeta {
  if (!isRecord(value) || typeof value.sourceSha !== "string" || !SHA.test(value.sourceSha) ||
    !count(value.bytes) || !boundedText(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) ||
    (value.matchedProfileId !== undefined && !boundedText(value.matchedProfileId, 128))) {
    throw new Error("invalid host-bundle metadata");
  }
  return {
    sourceSha: value.sourceSha,
    bytes: value.bytes,
    observedAt: value.observedAt,
    ...(value.matchedProfileId ? { matchedProfileId: value.matchedProfileId as string } : {}),
  };
}

/** YELLOW: driftedSlices/patchImpact remain the 4 legacy contract windows. Envelope comparison is envelopeDrift. */
export function parseHostBundleDiff(value: unknown): HostBundleDiff {
  if (!isRecord(value) || typeof value.previousSha !== "string" || !SHA.test(value.previousSha) ||
    !count(value.previousBytes) || !count(value.currentBytes) ||
    !count(value.previousLines) || !count(value.currentLines) ||
    !count(value.addedLines) || !count(value.removedLines) || !count(value.hunks) ||
    !Array.isArray(value.driftedSlices) || value.driftedSlices.length > CONTRACT_SLICE_NAMES.length ||
    !value.driftedSlices.every((key) => (CONTRACT_SLICE_NAMES as readonly unknown[]).includes(key)) ||
    !Array.isArray(value.patchImpact) || value.patchImpact.length > CONTRACT_SLICE_NAMES.length) {
    throw new Error("invalid host-bundle diff");
  }
  const patchImpact = value.patchImpact.map((row) => {
    if (!isRecord(row) || !(CONTRACT_SLICE_NAMES as readonly unknown[]).includes(row.slice) ||
      !["unchanged", "drifted", "missing", "appeared"].includes(String(row.status)) ||
      (row.review !== "none" && row.review !== "re-review")) {
      throw new Error("invalid host-bundle diff");
    }
    return {
      slice: row.slice as HostBundlePatchImpact["slice"],
      status: row.status as HostBundlePatchImpact["status"],
      review: row.review as HostBundlePatchImpact["review"],
    };
  });
  return {
    previousSha: value.previousSha,
    previousBytes: value.previousBytes,
    currentBytes: value.currentBytes,
    previousLines: value.previousLines as number,
    currentLines: value.currentLines as number,
    addedLines: value.addedLines as number,
    removedLines: value.removedLines as number,
    hunks: value.hunks as number,
    driftedSlices: [...value.driftedSlices as string[]],
    patchImpact,
  };
}

function generationDir(root: string, sha: string): string {
  return join(hostBundlesDir(root), "generations", sha);
}

function sourcePath(root: string, sha: string): string {
  return join(generationDir(root, sha), SOURCE_NAME);
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeProtected(path: string, body: string | Uint8Array): Promise<void> {
  await writeFile(path, body, { mode: 0o600, flag: "wx" });
}

export function hostSourceEpisodeId(installationId: string, sequence: number, before: HostSourceWindow | null, after: HostSourceWindow | null): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId)
    || !Number.isSafeInteger(sequence) || sequence < 0) throw Error("invalid-source-episode");
  return sha256Text(canonicalJson(["host-source-change-v1", installationId, sequence, before?.sourceSet ?? null, after?.sourceSet ?? null, after?.recipeSha ?? null]));
}
export type HostSourcePrivateEvidence = {
  version: 1; window: HostSourceWindow; recipe: readonly SlicePatch[];
  windows: { id: string; sha256: string | null; window: { startByte: number; endByte: number; text: string } | null }[];
  sourceGzip: string; worker: string;
};
export const HOST_SOURCE_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
export const HOST_SOURCE_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024;
const HOST_SOURCE_EVIDENCE_MAX_FILES = 68;
export function hostSourceEvidenceBytes(value: HostSourcePrivateEvidence): Buffer {
  if (typeof value.sourceGzip !== "string" || value.sourceGzip.length > HOST_SOURCE_EVIDENCE_MAX_BYTES) throw Error("source-evidence-invalid");
  return gunzipSync(Buffer.from(value.sourceGzip, "base64"), { maxOutputLength: 64 * 1024 * 1024 });
}
function sourceEvidenceValid(v: HostSourcePrivateEvidence): boolean {
  const w = projectHostSourceWindow(v?.window);
  let source: Buffer;
  try { source = hostSourceEvidenceBytes(v); } catch { return false; }
  return v?.version === 1 && !!w && sha256Text(source.toString("utf8")) === w.sourceSha && w.evidenceRef === null && typeof v.worker === "string" && sha256Text(v.worker) === w.workerSha
    && Array.isArray(v.recipe) && sha256Text(canonicalJson(v.recipe)) === w.recipeSha && Array.isArray(v.windows)
    && v.windows.length === w.slices.length && v.windows.every((s, i) => s.id === w.slices[i]!.id && s.sha256 === w.slices[i]!.sha256
      && (s.window === null ? s.sha256 === null : typeof s.window.text === "string" && Number.isSafeInteger(s.window.startByte) && s.window.startByte >= 0
        && s.window.endByte === s.window.startByte + Buffer.byteLength(s.window.text) && sha256Text(s.window.text) === s.sha256
        && source.subarray(s.window.startByte, s.window.endByte).toString("utf8") === s.window.text));
}
/** Private, content-addressed attachments of the EXISTING provenance journal.
 * No source text/path is placed in OBS, CLI, Web, comments or notifications. */
export async function readHostSourceEvidence(root: string, ref: string): Promise<HostSourcePrivateEvidence | null> {
  if (!SHA.test(ref)) throw Error("source-evidence-invalid");
  const directory = join(hostBundlesDir(root), "source-evidence");
  if (!await isRealDir(directory)) return null;
  await assertSafeDirectory(directory);
  const fd = await open(join(directory, `${ref}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(e => { if (e.code === "ENOENT") return null; throw e; });
  if (!fd) return null;
  try {
    const s = await fd.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > HOST_SOURCE_EVIDENCE_MAX_BYTES) throw Error("source-evidence-invalid");
    const bytes = Buffer.alloc(HOST_SOURCE_EVIDENCE_MAX_BYTES + 1); let n = 0;
    while (n < bytes.length) { const r = await fd.read(bytes, n, bytes.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
    const after = await fd.stat(), body = bytes.subarray(0, n).toString("utf8");
    if (n !== s.size || after.size !== s.size || after.ctimeMs !== s.ctimeMs || sha256Text(body) !== ref) throw Error("source-evidence-changed");
    const v = JSON.parse(body) as HostSourcePrivateEvidence;
    if (!sourceEvidenceValid(v)) throw Error("source-evidence-invalid");
    return v;
  } finally { await fd.close(); }
}
export async function retainHostSourceEvidence(root: string, value: HostSourcePrivateEvidence): Promise<string> {
  const body = canonicalJson(value), ref = sha256Text(body);
  if (Buffer.byteLength(body) > HOST_SOURCE_EVIDENCE_MAX_BYTES) throw Error("source-evidence-capacity");
  if (!sourceEvidenceValid(value)) throw Error("source-evidence-invalid");
  await assertSafeDirectory(root); await assertSafeDirectory(hostBundlesDir(root), true);
  const directory = join(hostBundlesDir(root), "source-evidence"); await assertSafeDirectory(directory, true);
  const existing = await readHostSourceEvidence(root, ref); if (existing) return ref;
  const files = await readdir(directory);
  if (files.length >= HOST_SOURCE_EVIDENCE_MAX_FILES) throw Error("source-evidence-capacity");
  let total = 0; for (const name of files) { const s = await lstat(join(directory, name)); if (!s.isFile() || s.isSymbolicLink()) throw Error("source-evidence-invalid"); total += s.size; }
  if (total + Buffer.byteLength(body) > HOST_SOURCE_EVIDENCE_TOTAL_BYTES) throw Error("source-evidence-capacity");
  const path = join(directory, `${ref}.json`), temp = join(directory, `.source-${randomUUID()}`);
  try {
    await writeProtected(temp, body);
    const fd = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); }
    await rename(temp, path);
    const dir = await open(directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    return ref;
  } finally { await rm(temp, { force: true }); }
}
/** Attachments outlive both sides of every retained transition. Unindexed
 * journal rows cannot be retired. Expired references never resolve to latest. */
export async function pruneHostSourceEvidence(root: string, journal: HostHealthJournal, extra: (string | null | undefined)[] = [],
  readPins: () => Promise<readonly string[] | null> = async () => null): Promise<boolean> {
  const keep = new Set([...extra, ...journal.receipts.flatMap(r => [r.event.sourceChange?.before?.evidenceRef, r.event.sourceChange?.after?.evidenceRef])].filter(Boolean));
  const directory = join(hostBundlesDir(root), "source-evidence"); if (!await isRealDir(directory)) return true;
  await assertSafeDirectory(directory);
  const names = await readdir(directory);
  if (!names.some(name => name.endsWith(".json") && SHA.test(name.slice(0,-5)) && !keep.has(name.slice(0,-5)))) return true;
  // OBS can outlive the rolling producer journal. Preserve pending/unknown
  // delivery evidence; an unavailable or truncated pin read forbids deletion.
  const pins = await readPins(); if (pins === null) return false;
  for (const ref of pins) keep.add(ref);
  for (const name of names) {
    const ref = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!SHA.test(ref) || keep.has(ref)) continue;
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error("source-evidence-invalid");
    await rm(path);
  }
  return true;
}

export type HostHealthRetained = { event: HostHealthEvidence; analysis: StaticAnalysis | null };
export type HostHealthJournal = { version: 1; installationId: string; nextSequence: number; acknowledgedThrough: number; receipts: HostHealthRetained[] };
const HEALTH_LIMIT = 64, HEALTH_BYTES = 1024 * 1024;
function retainedHealthValid(record:HostHealthRetained):boolean {
  const e=projectHostHealth(record?.event),a=record?.analysis;if(!e)return false;
  if(e.sourceInstanceId!==sha256Text(canonicalJson(['host-health',e.installationId])))return false;
  if(['stable','snapshot'].includes(e.sourceState)&&e.sourceSet!==sha256Text(canonicalJson([e.sourceSha,e.workerSha,e.profileDigest])))return false;
  if(a===null)return ['pending','unavailable'].includes(e.analysis)&&e.checkerBuildId===null;
  if(!validStaticAnalysis(a)||a.buildId!==e.checkerBuildId||canonicalJson(a.checks.map(c=>c.id))!==canonicalJson(e.requiredChecks))return false;
  const identities={source:e.sourceSha,candidate:e.candidateSha,companion:e.workerSha};
  if(a.artifacts.some(v=>identities[v.role]!==v.sha256)||a.artifacts.length!==Object.values(identities).filter(v=>v!==null).length)return false;
  const phase=a.artifacts.some(v=>!v.valid)||a.checks.some(c=>c.state==='violated')?'violated':a.checks.some(c=>c.state==='unsupported')?'unsupported':'passed';
  return e.analysis===phase&&canonicalJson(e.failedChecks)===canonicalJson(a.checks.filter(c=>c.state==='violated').map(c=>c.id))&&canonicalJson(e.unsupportedChecks)===canonicalJson(a.checks.filter(c=>c.state==='unsupported').map(c=>c.id));
}
/** Health receipts extend the existing private provenance owner. The one bounded
 * document is not another incident database. Unindexed receipts cannot be
 * evicted; current evidence and replay position survive a Server restart. */
export async function readHostHealthJournal(root: string, installationId: string): Promise<HostHealthJournal | null> {
  const directory=join(hostBundlesDir(root),"health"),path=join(directory,"receipts.json");
  const exists=await lstat(directory).catch(e=>{if(e.code==="ENOENT")return null;throw e;});if(!exists)return null;
  await assertSafeDirectory(directory);
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const s=await file.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0||s.size>HEALTH_BYTES)throw Error("health-receipt-invalid");
    const document=JSON.parse(await file.readFile("utf8")) as HostHealthJournal;
    if(document.version!==1||document.installationId!==installationId||!Number.isSafeInteger(document.nextSequence)||document.nextSequence<0
      ||!Number.isSafeInteger(document.acknowledgedThrough)||document.acknowledgedThrough< -1||document.acknowledgedThrough>=document.nextSequence
      ||!Array.isArray(document.receipts)||!document.receipts.length||document.receipts.length>HEALTH_LIMIT)throw Error("health-receipt-invalid");
    let previous=-1;
    for(const row of document.receipts){
      const event=projectHostHealth(row.event);if(!event||event.installationId!==installationId||event.sourceSequence<=previous||event.sourceSequence>=document.nextSequence)throw Error("health-receipt-invalid");
      if(!retainedHealthValid(row))throw Error("health-analysis-invalid");
      previous=event.sourceSequence;
    }
    if(previous!==document.nextSequence-1)throw Error("health-receipt-gap");
    return document;
  }finally{await file.close();}
}
async function publishHostHealthJournal(root:string,document:HostHealthJournal | HostRuntimeJournal, channel: "static" | "runtime" = "static"){
  const filename = "receipts.json";
  const directory=join(hostBundlesDir(root),channel === "static" ? "health" : "runtime-health"),body=canonicalJson(document)+"\n";
  if(Buffer.byteLength(body)>HEALTH_BYTES)throw Error("health-receipt-capacity");
  await assertSafeDirectory(root);await assertSafeDirectory(hostBundlesDir(root),true);
  const known=await lstat(directory).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
  const stage=known?directory:await mkdtemp(join(hostBundlesDir(root),".health-stage-"));
  await assertSafeDirectory(stage);
  const temp=join(stage,`.receipts-${randomUUID()}`);
  try{
    await writeProtected(temp,body);const fd=await open(temp,constants.O_RDONLY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}
    await rename(temp,join(stage,filename));const dir=await open(stage,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
    if(!known){await rename(stage,directory);const parent=await open(hostBundlesDir(root),constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}}
  }finally{await rm(temp,{force:true});if(!known)await rm(stage,{recursive:true,force:true});}
}
/** Caller is the installation's single health producer. expectedSequence fences
 * stale callers; the producer gate is held across read/retain/intake/ack. */
export async function retainHostHealthEvidence(root:string,installationId:string,expectedSequence:number,record:HostHealthRetained):Promise<HostHealthJournal>{
  const prior=await readHostHealthJournal(root,installationId);
  if((prior?.nextSequence??0)!==expectedSequence||record.event.sourceSequence!==expectedSequence||record.event.installationId!==installationId||!retainedHealthValid(record))throw Error("health-receipt-conflict");
  const receipts=[...(prior?.receipts??[])];
  while(receipts.length>=HEALTH_LIMIT&&receipts.length>1&&receipts[0]!.event.sourceSequence<=(prior?.acknowledgedThrough??-1))receipts.shift();
  if(receipts.length>=HEALTH_LIMIT)throw Error("health-receipt-capacity");
  const document:HostHealthJournal={version:1,installationId,nextSequence:expectedSequence+1,acknowledgedThrough:prior?.acknowledgedThrough??-1,receipts:[...receipts,record]};
  // Window summaries vary in size. Bound bytes as well as count without ever
  // deleting an unindexed receipt or the new transition's embedded before side.
  while (Buffer.byteLength(canonicalJson(document)) + 1 > HEALTH_BYTES && document.receipts.length > 1
    && document.receipts[0]!.event.sourceSequence <= document.acknowledgedThrough) document.receipts.shift();
  await publishHostHealthJournal(root,document);return document;
}
export async function acknowledgeHostHealthEvidence(root:string,installationId:string,sequence:number):Promise<void>{
  const prior=await readHostHealthJournal(root,installationId);if(!prior||sequence>=prior.nextSequence||sequence<prior.acknowledgedThrough)throw Error("health-receipt-conflict");
  if(sequence===prior.acknowledgedThrough)return;
  await publishHostHealthJournal(root,{...prior,acknowledgedThrough:sequence});
}

export type HostRuntimeJournal = { version: 1; installationId: string; nextSequence: number; acknowledgedThrough: number; receipts: Array<{ event: HostRuntimeEvidence | HostWitnessEvidence }> };
const runtimeEvidence = (v: unknown) => projectHostRuntimeEvidence(v) ?? projectHostWitnessEvidence(v);
/** Runtime observations extend this same bounded provenance owner. Their cursor
 * is independent of disk/AST evidence; an old disk pass cannot resolve a load
 * failure. The selected launch marker is the input, not another process owner. */
export async function readHostRuntimeJournal(root: string, installationId: string): Promise<HostRuntimeJournal | null> {
  const directory = join(hostBundlesDir(root), "runtime-health"), path = join(directory, "receipts.json");
  // A lost file inside an existing owner is a gap, not a fresh producer with
  // sequence zero. Reinitializing here would strand the higher OBS cursor.
  if (!await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; })) return null;
  await assertSafeDirectory(directory);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > HEALTH_BYTES) throw Error("runtime-receipt-invalid");
    const bytes = Buffer.alloc(HEALTH_BYTES + 1); let n = 0;
    while (n < bytes.length) { const result = await fd.read(bytes, n, bytes.length - n, n); if (!result.bytesRead) break; n += result.bytesRead; }
    const after = await fd.stat();
    if (n !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs) throw Error("runtime-receipt-changed");
    const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n))) as HostRuntimeJournal;
    if (document.version !== 1 || document.installationId !== installationId || !Number.isSafeInteger(document.nextSequence) || document.nextSequence < 1
      || !Number.isSafeInteger(document.acknowledgedThrough) || document.acknowledgedThrough < -1 || document.acknowledgedThrough >= document.nextSequence
      || !Array.isArray(document.receipts) || !document.receipts.length || document.receipts.length > HEALTH_LIMIT) throw Error("runtime-receipt-invalid");
    let prior = -1;
    for (const row of document.receipts) {
      const event = runtimeEvidence(row.event);
      if (!event || event.installationId !== installationId || event.sourceInstanceId !== sha256Text(canonicalJson(["host-runtime", installationId]))
        || event.sourceSequence <= prior || event.sourceSequence >= document.nextSequence) throw Error("runtime-receipt-invalid");
      prior = event.sourceSequence;
    }
    if (prior !== document.nextSequence - 1) throw Error("runtime-receipt-gap");
    return document;
  } finally { await fd.close(); }
}
export async function retainHostRuntimeEvidence(root: string, installationId: string, event: HostRuntimeEvidence | HostWitnessEvidence): Promise<HostRuntimeJournal> {
  const prior = await readHostRuntimeJournal(root, installationId);
  if (!runtimeEvidence(event) || event.installationId !== installationId || event.sourceInstanceId !== sha256Text(canonicalJson(["host-runtime", installationId]))
    || event.sourceSequence !== (prior?.nextSequence ?? 0)) throw Error("runtime-receipt-conflict");
  const receipts = [...(prior?.receipts ?? [])];
  while (receipts.length >= HEALTH_LIMIT && receipts[0]!.event.sourceSequence <= (prior?.acknowledgedThrough ?? -1)) receipts.shift();
  if (receipts.length >= HEALTH_LIMIT) throw Error("runtime-receipt-capacity");
  const document: HostRuntimeJournal = { version: 1, installationId, nextSequence: event.sourceSequence + 1, acknowledgedThrough: prior?.acknowledgedThrough ?? -1, receipts: [...receipts, { event }] };
  await publishHostHealthJournal(root, document, "runtime"); return document;
}
export async function acknowledgeHostRuntimeEvidence(root: string, installationId: string, sequence: number): Promise<void> {
  const prior = await readHostRuntimeJournal(root, installationId);
  if (!prior || sequence >= prior.nextSequence || sequence < prior.acknowledgedThrough) throw Error("runtime-receipt-conflict");
  if (sequence !== prior.acknowledgedThrough) await publishHostHealthJournal(root, { ...prior, acknowledgedThrough: sequence }, "runtime");
}

export function lineDiffStats(previous: string, current: string): Pick<HostBundleDiff,
  "previousLines" | "currentLines" | "addedLines" | "removedLines" | "hunks"> {
  const prev = previous.split("\n");
  const next = current.split("\n");
  let start = 0;
  const min = Math.min(prev.length, next.length);
  while (start < min && prev[start] === next[start]) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev -= 1;
    endNext -= 1;
  }
  const removedLines = endPrev - start;
  const addedLines = endNext - start;
  return {
    previousLines: prev.length,
    currentLines: next.length,
    addedLines,
    removedLines,
    hunks: removedLines === 0 && addedLines === 0 ? 0 : 1,
  };
}

/** YELLOW: four-window first-hit patchImpact green is not envelope green. Use envelopeDrift for the 19 independent apply windows. */
export function hostBundlePatchImpact(previous: string | null, current: string): HostBundlePatchImpact[] {
  const currentHashes = sliceHashes(extractContractSlices(current));
  const previousHashes = previous ? sliceHashes(extractContractSlices(previous)) : {};
  return CONTRACT_SLICE_NAMES.map((slice) => {
    const hasPrev = Object.hasOwn(previousHashes, slice) && previousHashes[slice]!.length > 0;
    const hasCur = Object.hasOwn(currentHashes, slice) && currentHashes[slice]!.length > 0;
    if (!hasPrev && !hasCur) return { slice, status: "missing" as const, review: "re-review" as const };
    if (!hasPrev && hasCur) return { slice, status: "appeared" as const, review: "re-review" as const };
    if (hasPrev && !hasCur) return { slice, status: "missing" as const, review: "re-review" as const };
    if (previousHashes[slice] !== currentHashes[slice]) return { slice, status: "drifted" as const, review: "re-review" as const };
    return { slice, status: "unchanged" as const, review: "none" as const };
  });
}

export function buildHostBundleDiff(previousSha: string, previous: string, current: string): HostBundleDiff {
  const stats = lineDiffStats(previous, current);
  const impact = hostBundlePatchImpact(previous, current);
  return {
    previousSha,
    previousBytes: Buffer.byteLength(previous),
    currentBytes: Buffer.byteLength(current),
    ...stats,
    // YELLOW: driftedSlices stays locked to CONTRACT_SLICE_NAMES (4). Do not add compact-register here.
    driftedSlices: impact.filter((row) => row.status === "drifted" || row.status === "missing" || row.status === "appeared")
      .map((row) => row.slice),
    patchImpact: impact,
  };
}

export async function readHostBundleHead(root: string): Promise<string | null> {
  try {
    const text = (await readFile(join(hostBundlesDir(root), "HEAD"), "utf8")).trim();
    return SHA.test(text) ? text : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readHostBundleMeta(root: string, sha: string): Promise<HostBundleMeta | null> {
  if (!SHA.test(sha)) return null;
  try {
    return parseHostBundleMeta(JSON.parse(await readFile(join(generationDir(root, sha), "meta.json"), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readHostBundleSource(root: string, sha: string): Promise<string | null> {
  return await readStoredSource(root, sha);
}

async function readStoredSource(root: string, sha: string): Promise<string | null> {
  if (!SHA.test(sha)) return null;
  try {
    const bytes = await readFile(sourcePath(root, sha));
    if (sha256Text(bytes.toString("utf8")) !== sha) return null;
    return bytes.toString("utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function durableEnvelopeRecipe(root: string): Promise<PatchProfile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(reviewedProfilePath(root), "utf8"));
    if (!isRecord(parsed)) return undefined;
    const profile = parsed as PatchProfile;
    return envelopeProfileShape(profile) ? profile : undefined;
  } catch {
    return undefined;
  }
}

async function resolveRetainEnvelopeProfile(
  root: string,
  passed?: PatchProfile,
): Promise<PatchProfile | undefined> {
  if (envelopeProfileShape(passed)) return passed;
  return await durableEnvelopeRecipe(root);
}

/** Persist envelope-windows.json from a 19-slice reviewed recipe. Pin SHA need not match. Never overwrite. */
async function writeEnvelopeWindowsFromRecipe(
  dir: string,
  source: string,
  profile: PatchProfile | undefined,
): Promise<void> {
  const windows = envelopeWindowsFromRecipe(source, profile);
  if (!windows) return;
  try {
    await writeProtected(join(dir, ENVELOPE_WINDOWS_FILE), encodeEnvelopeWindows(windows));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EEXIST") return;
    throw error;
  }
}

export async function retainHostBundle(input: {
  root: string;
  source: string;
  sourceSha: string;
  observedAt: string;
  matchedProfileId?: string;
  profile?: PatchProfile;
}): Promise<HostBundleRetainResult> {
  if (!SHA.test(input.sourceSha) || sha256Text(input.source) !== input.sourceSha) {
    throw new Error("host-bundle-sha-mismatch");
  }
  const dir = hostBundlesDir(input.root);
  const genDir = generationDir(input.root, input.sourceSha);
  const generations = join(dir, "generations");
  await mkdir(generations, { recursive: true, mode: 0o700 });
  if (await isRealDir(generations) === false) throw new Error("invalid host-bundle path");
  const envelopeProfile = await resolveRetainEnvelopeProfile(input.root, input.profile);
  const publishHead = async () => {
    const temporary = join(dir, `.HEAD-${randomUUID()}`);
    try {
      await writeProtected(temporary, `${input.sourceSha}\n`);
      await rename(temporary, join(dir, "HEAD"));
    } finally { await rm(temporary, { force: true }); }
  };
  const existingResult = async (): Promise<HostBundleRetainResult> => {
    if (!await isRealDir(genDir)) throw new Error("invalid host-bundle path");
    const stored = await readStoredSource(input.root, input.sourceSha);
    let meta: HostBundleMeta | null;
    try { meta = await readHostBundleMeta(input.root, input.sourceSha); }
    catch { throw new Error("host-bundle-bytes-mismatch"); }
    if (stored !== input.source || !meta || meta.sourceSha !== input.sourceSha || meta.bytes !== Buffer.byteLength(input.source)) {
      throw new Error("host-bundle-bytes-mismatch");
    }
    // Missing envelope golden may be filled once a 19-slice reviewed recipe exists; never overwrite.
    await writeEnvelopeWindowsFromRecipe(genDir, input.source, envelopeProfile);
    await publishHead();
    return { sourceSha: input.sourceSha, retained: "existing", meta, diff: null };
  };
  // Readers must see the complete source+metadata generation or no generation.
  // Never expose a final directory and then populate source/meta/diff incrementally.
  // envelope-windows.json is staged with a new generation when a 19-slice reviewed recipe is present
  // (pin SHA need not match this sourceSha); an existing generation may gain a missing golden once, never an overwrite.
  if (await lstat(genDir).then(() => true, (error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  })) return existingResult();
  const previousSha = await readHostBundleHead(input.root);
  const previousSource = previousSha && previousSha !== input.sourceSha ? await readStoredSource(input.root, previousSha) : null;
  const meta: HostBundleMeta = {
    sourceSha: input.sourceSha,
    bytes: Buffer.byteLength(input.source),
    observedAt: input.observedAt,
    ...(input.matchedProfileId ? { matchedProfileId: input.matchedProfileId } : {}),
  };
  const diff = previousSha && previousSource !== null && previousSha !== input.sourceSha
    ? buildHostBundleDiff(previousSha, previousSource, input.source)
    : null;
  const staging = await mkdtemp(join(generations, ".staging-"));
  try {
    await writeProtected(join(staging, SOURCE_NAME), input.source);
    await writeProtected(join(staging, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    if (diff) await writeProtected(join(staging, "diff.json"), `${JSON.stringify(diff, null, 2)}\n`);
    await writeEnvelopeWindowsFromRecipe(staging, input.source, envelopeProfile);
    try { await rename(staging, genDir); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // A concurrent publisher won. Validate its immutable complete generation;
      // corrupt/half-written existing generations are not repaired or overwritten.
      return await existingResult();
    }
    await publishHead();
    return { sourceSha: input.sourceSha, retained: "new", meta, diff };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function observeHostBundles(root: string): Promise<HostBundlesObservation> {
  const result: HostBundlesObservation = {
    state: "missing", headState: "missing", head: null, generations: [], truncated: false, invalidEntries: 0,
  };
  const dir = hostBundlesDir(root);
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return { ...result, state: "invalid", headState: "invalid" };
    const head = await observeText(join(dir, "HEAD"), 256);
    result.headState = head.state;
    if (head.state === "present") {
      if (!SHA.test(head.value.trim())) result.headState = "invalid";
      else result.head = head.value.trim();
    }
    const base = join(dir, "generations");
    const baseInfo = await lstat(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) return { ...result, state: "invalid" };
    const entries = await readdir(base, { withFileTypes: true });
    const names = entries.filter((entry) => SHA.test(entry.name) && entry.isDirectory()).map((entry) => entry.name).sort();
    result.invalidEntries = entries.filter((entry) => !entry.name.startsWith(".") && (!SHA.test(entry.name) || !entry.isDirectory())).length;
    const ordered = [...new Set([...(result.head ? [result.head] : []), ...names])];
    result.truncated = ordered.length > HOST_BUNDLE_OBSERVATION_LIMIT;
    for (const sourceSha of ordered.slice(0, HOST_BUNDLE_OBSERVATION_LIMIT)) {
      let state: ObservationState = "missing";
      let metadata: HostBundleMeta | null = null;
      let diff: HostBundleDiff | null = null;
      if (names.includes(sourceSha)) {
        const meta = await observeJson(join(base, sourceSha, "meta.json"), parseHostBundleMeta);
        state = meta.state;
        if (meta.state === "present") {
          if (meta.value.sourceSha === sourceSha) metadata = meta.value;
          else state = "invalid";
        }
        const diffRead = await observeJson(join(base, sourceSha, "diff.json"), parseHostBundleDiff);
        if (diffRead.state === "present") diff = diffRead.value;
        else if (diffRead.state === "invalid") state = "invalid";
      } else if (entries.some((entry) => entry.name === sourceSha)) state = "invalid";
      result.generations.push({ sourceSha, state, metadata, diff });
    }
    result.generations.sort((a, b) => (b.metadata?.observedAt ?? "").localeCompare(a.metadata?.observedAt ?? "") || a.sourceSha.localeCompare(b.sourceSha));
    result.state = result.headState === "present" && !result.invalidEntries && !result.truncated &&
      result.generations.every((row) => row.state === "present")
      ? "present" : result.head || result.generations.length ? "partial" : "missing";
    return result;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return { ...result, state: code === "ENOENT" ? (result.head ? "partial" : "missing") : "unavailable" };
  }
}

export const readHostBundles = observeHostBundles;

export async function pruneHostBundles(input: {
  root: string;
  liveSha: string;
  lastMatchedSha?: string | null;
}): Promise<void> {
  const base = join(hostBundlesDir(input.root), "generations");
  let names: string[] = [];
  try {
    names = await readdir(base);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const rows: Array<{ sha: string; at: string; matched: boolean }> = [];
  for (const sha of names) {
    if (!SHA.test(sha)) continue;
    const meta = await readHostBundleMeta(input.root, sha);
    rows.push({ sha, at: meta?.observedAt ?? "", matched: Boolean(meta?.matchedProfileId) });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.sha.localeCompare(b.sha));
  const latestMatched = [...rows].reverse().find((row) => row.matched)?.sha ?? null;
  const protectedSha = new Set([input.liveSha, input.lastMatchedSha, latestMatched].filter((value): value is string => Boolean(value)));
  const removable = rows.filter((row) => !protectedSha.has(row.sha));
  while (rows.length > HOST_BUNDLE_KEEP && removable.length > 0) {
    const drop = removable.shift();
    if (!drop) break;
    await rm(join(base, drop.sha), { recursive: true, force: true });
    const index = rows.findIndex((row) => row.sha === drop.sha);
    if (index >= 0) rows.splice(index, 1);
  }
}
