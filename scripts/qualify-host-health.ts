import { resolve } from "node:path";
import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_CHECK_REQUIREMENTS, describeHostSourceEvolution } from "@grokbox/runtime-kernel/host-health";
import { captureHostSourceWindow } from "../packages/box-runtime/src/internal/io/host-source-window.node.mjs";
import { captureVerificationSource } from "./verification-source.mjs";
import { verificationSignals } from "./verification-child.mjs";
import { inspectHostHealthSources } from "../packages/box-runtime/src/internal/roots/host-health.runtime.ts";
import { HOST_RECIPE } from "../packages/box-runtime/src/internal/host/source-recipes.ts";
import { NATIVE_CHECKPOINT_PAIR, nativeCheckpointPair } from "../packages/box-runtime/src/internal/host/native-checkpoint-pair.ts";
import { transformUnchecked, preflightProfileRecipe, type SlicePatch } from "../packages/box-runtime/src/internal/host/profile.ts";
/** Explicit development qualification, NOT a runtime updater or Host loader.
 * Reads named files, applies the existing exact TS program only in memory and
 * sends immutable copies to the SAME packaged verifier as the Server. No raw
 * source, native credentials, profile publication or Bot/model RPC occurs. */
const args=process.argv.slice(2),values=new Map<string,string>();
for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!k||!v||!['--source','--worker','--profile','--binary-directory','--candidate-recipe','--reference-host-sha','--reference-worker-sha'].includes(k)||values.has(k))throw Error('invalid_qualification_arguments');values.set(k,k==='--candidate-recipe'||k.startsWith('--reference-')?v:resolve(v));}
const candidateRecipe=values.get('--candidate-recipe');
if(candidateRecipe!==undefined&&!['core','current-state'].includes(candidateRecipe)||candidateRecipe!==undefined&&values.has('--profile'))throw Error('candidate_recipe_requires_no_profile');
if(!values.has('--source')||!values.has('--worker')||!values.has('--binary-directory'))throw Error('qualification_requires_explicit_inputs');
const explicitReference=values.has('--reference-host-sha')||values.has('--reference-worker-sha');
if(explicitReference&&['--reference-host-sha','--reference-worker-sha'].some(key=>!/^[a-f0-9]{64}$/.test(values.get(key)??'')))throw Error('reference_requires_exact_host_worker_digests');
// A caller-supplied comparison never changes the independent native ABI pin.
const reference=explicitReference?{host:values.get('--reference-host-sha')!,worker:values.get('--reference-worker-sha')!}:NATIVE_CHECKPOINT_PAIR;
const cancellation=verificationSignals();
let window:Awaited<ReturnType<typeof captureHostSourceWindow>>|null=null;
try {
 const began=performance.now(),inputs=captureVerificationSource(resolve(import.meta.dir,'..'));
 if(!inputs.ok)throw Error('qualification_inputs_unavailable');
 window=await captureHostSourceWindow({source:values.get('--source')!,worker:values.get('--worker')!,profile:values.get('--profile')??null},
  {verificationSource:inputs.sha256,recipe:sha256Text(canonicalJson(HOST_RECIPE)),checks:sha256Text(canonicalJson(HOST_CHECK_REQUIREMENTS)),candidateSelection:sha256Text(candidateRecipe??'selected-profile'),reference:sha256Text(canonicalJson({host:reference.host,worker:reference.worker}))},{signal:cancellation.signal});
 const {artifacts:a,analysis,proposal}=await inspectHostHealthSources(window.paths,values.get('--binary-directory')!,cancellation.signal,candidateRecipe as 'core'|'current-state'|undefined);
 const text=new TextDecoder('utf-8',{fatal:true}).decode(a.source);
 const maintained=HOST_RECIPE;
 const groups=[['core',maintained.core],['checkpoint',maintained.checkpoint],['current-state',maintained.currentState]] as const;
 const diagnostic=groups.map(([name,slices])=>{
  let partial=text;
  const rows=slices.map(slice=>{const r=transformUnchecked(partial,[slice]);if(r.ok){partial=r.source;return {id:slice.id,state:'matched'};}return {id:slice.id,state:'mismatch',code:r.code};});
  return {name,total:rows.length,matched:rows.filter(r=>r.state==='matched').length,failures:rows.filter(r=>r.state==='mismatch'),meaning:'sequential-diagnostic-skips-failures-not-applicable-profile'};
 });
 const full=preflightProfileRecipe(text,groups.flatMap(([,slices])=>[...slices]) as SlicePatch[],'read-only-diagnostic');
 if(!await a.current())throw Error('qualification_source_changed');
 const afterInputs=captureVerificationSource(resolve(import.meta.dir,'..'));
 if(!afterInputs.ok||afterInputs.sha256!==inputs.sha256)throw Error('qualification_inputs_changed');
 const covered=new Set<string>(HOST_CHECK_REQUIREMENTS.flatMap(check=>[...check.slices]));
 const failed=analysis.checks.filter(check=>check.state==='violated').map(({id,revision,code})=>({id,revision,code}));
 const unsupported=analysis.checks.filter(check=>check.state==='unsupported').map(({id,revision,code})=>({id,revision,code}));
 console.log(JSON.stringify({scope:'fixed-private-disk-static-only',window:window.receipt,freshness:await window.freshness(),
  qualificationKey:sha256Text(canonicalJson([window.receipt.key,analysis.buildId,analysis.schemaDigest,a.candidate?sha256Bytes(a.candidate):null,a.profileDigest])),
  referenceOrigin:explicitReference?'caller-supplied-comparison-not-qualification':'maintained-native-pair',sourceSha:a.sourceSha,sourceBytes:a.source.length,workerSha:a.workerSha,workerBytes:a.worker.length,
  selectedProfile:a.profileDigest,candidateOrigin:proposal?'maintained-recipe':a.profileDigest?'selected-profile':'none',proposal,
  selectedApplicability:a.applicability,authoringRecipe:maintained.id,
  completeCurrentRecipe:full.ok?{state:'applicable-not-reviewed'}:{state:'mismatch',code:full.code,sliceId:full.sliceId??null},diagnostic,
  checkpointPair:nativeCheckpointPair(a.sourceSha,a.workerSha)?'same-pinned-pair':'unreviewed-pair',
  sourceEvolution:describeHostSourceEvolution(reference,{host:a.sourceSha,worker:a.workerSha},full.ok?'applicable-not-reviewed':'mismatch',{
   recipeFailure:full.ok?null:{code:full.code,sliceId:full.sliceId??null},
   semantics:{state:failed.length?'failed':unsupported.length?'incomplete':'passed',failed,unsupported},
   uncoveredSlices:groups.flatMap(([,slices])=>[...slices]).map(slice=>slice.id).filter(id=>!covered.has(id))}),
  analysis,verificationSource:inputs,wallMs:Math.round(performance.now()-began),nativeExecuted:false,profilePublished:false,loadedProven:false,qualified:false},null,2));
} catch(error) {console.error(JSON.stringify({ok:false,code:typeof (error as any)?.code==='string'?(error as any).code:'qualification-unavailable',nativeExecuted:false,qualified:false}));process.exitCode=1;}
finally {try {await window?.dispose();} finally {cancellation.dispose();}}
