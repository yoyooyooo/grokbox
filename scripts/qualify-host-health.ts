import { resolve } from "node:path";
import { inspectHostHealthSources } from "../packages/box-runtime/src/internal/roots/host-health.runtime.ts";
import { LIVE_SLICE_PATCHES } from "../packages/box-runtime/src/internal/host/live-slices.ts";
import { NATIVE_CHECKPOINT_HOST_SLICES } from "../packages/box-runtime/src/internal/host/native-checkpoint-slices.ts";
import { NATIVE_CURRENT_STATE_SLICES } from "../packages/box-runtime/src/internal/host/native-current-state-slices.ts";
import { hostRecipeForSourceSha } from "../packages/box-runtime/src/internal/host/source-recipes.ts";
import { NATIVE_CHECKPOINT_PAIR } from "../packages/box-runtime/src/internal/host/native-checkpoint-pair.ts";
import { transformUnchecked, preflightProfileRecipe, type SlicePatch } from "../packages/box-runtime/src/internal/host/profile.ts";
/** Explicit development qualification, NOT a runtime updater or Host loader.
 * Reads named files, applies the existing exact TS program only in memory and
 * sends immutable copies to the SAME packaged verifier as the Server. No raw
 * source, native credentials, profile publication or Bot/model RPC occurs. */
const args=process.argv.slice(2),values=new Map<string,string>();
for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!k||!v||!['--source','--worker','--profile','--binary-directory','--candidate-recipe'].includes(k)||values.has(k))throw Error('invalid_qualification_arguments');values.set(k,k==='--candidate-recipe'?v:resolve(v));}
const candidateRecipe=values.get('--candidate-recipe');
if(candidateRecipe!==undefined&&!['core','current-state'].includes(candidateRecipe)||candidateRecipe!==undefined&&values.has('--profile'))throw Error('candidate_recipe_requires_no_profile');
if(!values.has('--source')||!values.has('--worker')||!values.has('--binary-directory'))throw Error('qualification_requires_explicit_inputs');
try {
 const began=performance.now();
 const {artifacts:a,analysis,proposal}=await inspectHostHealthSources({source:values.get('--source')!,worker:values.get('--worker')!,profile:values.get('--profile')??null},values.get('--binary-directory')!,undefined,candidateRecipe as 'core'|'current-state'|undefined);
 const text=new TextDecoder('utf-8',{fatal:true}).decode(a.source);
 const maintained=hostRecipeForSourceSha(a.sourceSha);
 const groups=[['core',maintained.core],['checkpoint',maintained.checkpoint],['current-state',maintained.currentState]] as const;
 const legacy=preflightProfileRecipe(text,[...LIVE_SLICE_PATCHES,...NATIVE_CHECKPOINT_HOST_SLICES,...NATIVE_CURRENT_STATE_SLICES],'original-recipe-diagnostic');
 const diagnostic=groups.map(([name,slices])=>{
  let partial=text;
  const rows=slices.map(slice=>{const r=transformUnchecked(partial,[slice]);if(r.ok){partial=r.source;return {id:slice.id,state:'matched'};}return {id:slice.id,state:'mismatch',code:r.code};});
  return {name,total:rows.length,matched:rows.filter(r=>r.state==='matched').length,failures:rows.filter(r=>r.state==='mismatch'),meaning:'sequential-diagnostic-skips-failures-not-applicable-profile'};
 });
 const full=preflightProfileRecipe(text,groups.flatMap(([,slices])=>[...slices]) as SlicePatch[],'read-only-diagnostic');
 if(!await a.current())throw Error('qualification_source_changed');
 console.log(JSON.stringify({scope:'disk-static-only',sourceSha:a.sourceSha,sourceBytes:a.source.length,workerSha:a.workerSha,workerBytes:a.worker.length,
  selectedProfile:a.profileDigest,candidateOrigin:proposal?'maintained-recipe':a.profileDigest?'selected-profile':'none',proposal,
  selectedApplicability:a.applicability,authoringRecipe:maintained.id,
  originalRecipe:legacy.ok?{state:'applicable-not-reviewed'}:{state:'mismatch',code:legacy.code,sliceId:legacy.sliceId??null},
  completeCurrentRecipe:full.ok?{state:'applicable-not-reviewed'}:{state:'mismatch',code:full.code,sliceId:full.sliceId??null},diagnostic,
  checkpointPair:a.sourceSha===NATIVE_CHECKPOINT_PAIR.host&&a.workerSha===NATIVE_CHECKPOINT_PAIR.worker?'same-pinned-pair':'unreviewed-pair',
  legacyMemoryRpcTextPresent:text.includes('getAgentMemories'),rpcEvidence:'text-presence-only',
  analysis,wallMs:Math.round(performance.now()-began),nativeExecuted:false,profilePublished:false,loadedProven:false,qualified:false},null,2));
} catch(error) {console.error(JSON.stringify({ok:false,code:typeof (error as any)?.code==='string'?(error as any).code:'qualification-unavailable',nativeExecuted:false,qualified:false}));process.exitCode=1;}
