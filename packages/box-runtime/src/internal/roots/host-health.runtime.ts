import { Effect, Fiber, ManagedRuntime } from "effect";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { describeHostSourceChange, type HostSourceChange, describeHostSourceEvolution, type NativeSourceIdentity, HOST_HEALTH_CONTRACT, HOST_CHECK_REQUIREMENTS, hostHealthSummary, type HostHealthEvidence, type HostRuntimeObservation, type HostRuntimeEvidence, type HostWitnessObservation, type HostWitnessEvidence, type StaticAnalysis } from "@grokbox/runtime-kernel/host-health";
import { canonicalJson, sha256Text, sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { HostVerifier } from "../ops/host-health/verifier.port.ts";
import { hostVerifierLayer } from "../io/host-verifier/client.node.ts";
import { VerifierFailure } from "../io/host-verifier/stdio.node.ts";
import { readHostArtifacts, HostSourceFailure, type HostArtifactPaths, type HostArtifacts } from "../io/host-artifact-source.node.ts";
import { readHostHealthJournal, retainHostHealthEvidence, acknowledgeHostHealthEvidence, type HostHealthJournal, readHostRuntimeJournal, retainHostRuntimeEvidence, acknowledgeHostRuntimeEvidence, type HostRuntimeJournal } from "../io/provenance.node.ts";
import { observeHostCompilation, type CompilationReadPorts } from "../io/host-compilation.node.ts";
import { observeHostWitness, type HostWitnessRead, type HostWitnessReadCursor } from "../io/host-witness.node.ts";
import { ephemeralRuntimeRoot } from "../io/ephemeral.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout, assertSafeDirectory } from "../io/config-layout.node.ts";
import { reviewedProfilePath } from "../io/paths.ts";
import { LIVE_HOST_BUNDLE } from "../host/live-slices.ts";
import { HOST_RECIPE } from "../host/source-recipes.ts";
import { NATIVE_CHECKPOINT_PAIR } from "../host/native-checkpoint-pair.ts";
import { applyPatchProfile, preflightProfileRecipe } from "../host/profile.ts";
import { acquireAdvisoryGate, type AdvisoryGate } from "../io/advisory-gate.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { captureHostSourceWindow, retainedHostSourceWindow, readHostSourceEvidencePins } from "../io/host-source-change.node.ts";
import { hostSourceEpisodeId, pruneHostSourceEvidence } from "../io/provenance.node.ts";
export type HostHealthStatus = { owner:"management-server"; state:"starting"|"disabled"|"running"|"blocked"|"stopped"; reason:string;
  observedAtMs:number|null; lastAttemptAtMs:number|null; assessment:"blocked"|"unknown"|"degraded"; latest:HostHealthEvidence|null;
  intake:"not-observed"|"committed"|"unavailable"|"gap"; runtime:HostRuntimeObservation|null; witness:HostWitnessObservation|null; runtimeIntake:"not-observed"|"committed"|"unavailable"|"gap"; watch:"active"|"backstop-only"; analyses:number; qualified:false; executionAuthority:false };
export type HostHealthTestPorts = { enabled?:boolean; observationEnabled?:()=>boolean|Promise<boolean>; paths?:HostArtifactPaths; binaryDirectory?:string; pollMs?:number; backstopMs?:number;
  afterRetain?:()=>Promise<void>; onSpawn?:(pid:number)=>void; beforeAnalyze?:(sourceSet:string)=>Promise<void>;
  runtime?: CompilationReadPorts & { runRoot?:string; afterRetain?:()=>Promise<void> }; witnessPollMs?:number; afterWitnessRetain?:()=>Promise<void> };
const local = <A>(work:()=>Promise<A>) => Effect.uninterruptible(Effect.tryPromise({try:work,catch:e=>e}));
const analyzeArtifacts=(a:HostArtifacts)=>Effect.gen(function*(){const verifier=yield* HostVerifier;return yield* verifier.analyze({jobId:randomUUID(),attemptId:randomUUID(),checks:HOST_CHECK_REQUIREMENTS.map(c=>({id:c.id,revision:c.revision})),
  artifacts:[{role:"source",bytes:a.source},...(a.candidate?[{role:"candidate" as const,bytes:a.candidate}]:[]),{role:"companion",bytes:a.worker}]});});
/** Explicit qualification consumes the same analysis program, not a second
 * checker. No provenance/OBS/config publication or native execution occurs. */
export async function inspectHostHealthSources(paths:HostArtifactPaths,binaryDirectory:string,signal?:AbortSignal,candidateRecipe?:"core"|"current-state"){
  if (candidateRecipe !== undefined && (paths.profile !== null || !["core", "current-state"].includes(candidateRecipe))) throw new HostSourceFailure("invalid-profile");
  let artifacts=await readHostArtifacts(paths,signal);
  let proposal: { recipeId:string; capability:"core"|"current-state"; profileDigest:string|null; reviewed:false; published:false } | null = null;
  if (candidateRecipe) {
    const recipe=HOST_RECIPE, slices=candidateRecipe==="core"?recipe.core:[...recipe.core,...recipe.checkpoint,...recipe.currentState];
    const text=new TextDecoder("utf-8",{fatal:true}).decode(artifacts.source),result=preflightProfileRecipe(text,slices,recipe.id);
    // Explicit static authoring inspection only. The same TS transformer builds
    // the actual candidate, but nothing is published or promoted to a profile.
    const applied=result.ok?applyPatchProfile(text,result.profile):null;
    if(result.ok&&!applied?.ok)throw new HostSourceFailure("invalid-profile");
    proposal={recipeId:recipe.id,capability:candidateRecipe,profileDigest:result.ok?sha256Text(canonicalJson(result.profile)):null,reviewed:false,published:false};
    artifacts={...artifacts,candidate:applied?.ok?Buffer.from(applied.source):null,applicability:result.ok?"exact":"mismatch",failureCode:result.ok?null:result.code,sliceId:result.ok?null:result.sliceId??null};
  }
  const runtime=ManagedRuntime.make(hostVerifierLayer({directory:binaryDirectory}));
  try {const analysis=await runtime.runPromise(analyzeArtifacts(artifacts),signal?{signal}:undefined);
    if(!await artifacts.current())throw new HostSourceFailure("source-changed");return {artifacts,analysis,proposal};
  } finally {await runtime.dispose();}
}
/** Installation sensing and static computation share one Server owner, not the
 * Bot roster. The two lanes never hold a database transaction across analysis.
 * Reports certify immutable inputs only; no loaded/use authority is inferred. */
export function startHostHealth(input:{root:string;installationId:string;enabled?:boolean;observationEnabled?:()=>boolean|Promise<boolean>;readWitness?:HostWitnessRead}, ports:HostHealthTestPorts={}) {
  const paths=ports.paths??{source:LIVE_HOST_BUNDLE,worker:join(dirname(LIVE_HOST_BUNDLE),"agent-isolation/agent-store-worker.cjs"),profile:reviewedProfilePath(input.root)};
  const pollMs=ports.pollMs??1000, backstopMs=ports.backstopMs??180000;
  if(!Number.isSafeInteger(pollMs)||pollMs<10||pollMs>30000||!Number.isSafeInteger(backstopMs)||backstopMs<pollMs||backstopMs>600000) throw Error("invalid-health-period");
  const witnessPollMs = ports.witnessPollMs ?? 10000;
  if (!Number.isSafeInteger(witnessPollMs) || witnessPollMs < 10 || witnessPollMs > 60000) throw Error("invalid-witness-period");
  const runtime=ManagedRuntime.make(hostVerifierLayer({directory:ports.binaryDirectory,onSpawn:ports.onSpawn}));
  const controller=new AbortController();
  let observationController=new AbortController();
  let gate:AdvisoryGate|null=null, watchers:FSWatcher[]=[], dirty=true, lastHashAt=0, closed=false, enabled=false;
  let generation=0, currentKey:string|null=null, analyzedKey:string|null=null, retryAt=0, failures=0;
  let retirementUnavailable=false;
  type Pending={artifacts:HostArtifacts;generation:number;key:string;buildId:string|null;reference:NativeSourceIdentity;change:HostSourceChange;controller:AbortController};
  let pending:Pending|null=null, active:Pending|null=null;
  const cache=new Map<string,StaticAnalysis>();
  const orderedRecipe=[...HOST_RECIPE.core,...HOST_RECIPE.checkpoint,...HOST_RECIPE.currentState];
  const recipeSha=sha256Text(canonicalJson(orderedRecipe));
  const analysisKey=(sourceSet:string,buildId:string|null)=>canonicalJson([HOST_HEALTH_CONTRACT,sourceSet,buildId,recipeSha,HOST_CHECK_REQUIREMENTS]);
  const recipeCache=new Map<string,ReturnType<typeof preflightProfileRecipe>>();
  function evolution(a:HostArtifacts,analysis:StaticAnalysis|null,reference:NativeSourceIdentity){
    let recipe=recipeCache.get(a.sourceSha);
    if(!recipe){recipe=preflightProfileRecipe(new TextDecoder('utf-8',{fatal:true}).decode(a.source),orderedRecipe,HOST_RECIPE.id);
      recipeCache.set(a.sourceSha,recipe);while(recipeCache.size>4)recipeCache.delete(recipeCache.keys().next().value!);}
    const failed=analysis?.checks.filter(c=>c.state==='violated').map(({id,revision,code})=>({id,revision,code}))??[];
    const unsupported=analysis?.checks.filter(c=>c.state==='unsupported').map(({id,revision,code})=>({id,revision,code}))??[];
    const covered=new Set<string>(HOST_CHECK_REQUIREMENTS.flatMap(c=>[...c.slices]));
    return describeHostSourceEvolution(reference,{host:a.sourceSha,worker:a.workerSha},recipe.ok?'applicable-not-reviewed':'mismatch',{
      recipeFailure:recipe.ok?null:{code:recipe.code,sliceId:recipe.sliceId??null},
      semantics:analysis?{state:failed.length?'failed':unsupported.length?'incomplete':'passed',failed,unsupported}:undefined,
      uncoveredSlices:orderedRecipe.map(s=>s.id).filter(id=>!covered.has(id))});
  }
  let runtimeRoot=ports.runtime?.runRoot??ephemeralRuntimeRoot(), runtimeKey:string|null=null;
  let witnessKey: string | null = null, previousWitness: HostWitnessReadCursor | undefined;
  // Current in-memory observations can lead the serialized durable writer.
  // One lane completing intake cannot certify another lane's queued change.
  let observedRuntimeKey: string | null = null, observedWitnessKey: string | null = null;
  let writes:Promise<unknown>=Promise.resolve();
  const serial=<A>(work:()=>Promise<A>):Promise<A>=>{const next=writes.then(work);writes=next.catch(()=>undefined);return next;};
  let status:HostHealthStatus={owner:"management-server",state:"starting",reason:"not-observed",observedAtMs:null,lastAttemptAtMs:null,assessment:"unknown",latest:null,
    intake:"not-observed",runtime:null,witness:null,runtimeIntake:"not-observed",watch:"backstop-only",analyses:0,qualified:false,executionAuthority:false};
  const sourceInstanceId=sha256Text(canonicalJson(["host-health",input.installationId]));
  async function intake(journal:HostHealthJournal|null) {
    if(!journal){status={...status,intake:"not-observed"};return;}
    try {
      const monitor=openMonitorStore(input.root), snapshot=await monitor.snapshot();
      if(!snapshot.collectorEpoch||!snapshot.collectorRecordedRunning) throw Error("observation-inactive");
      let cursor=(await monitor.evidenceCursor(sourceInstanceId))?.cursor??null;
      // Retained receipts can repair an independently restored OBS projection.
      // Every original event ID/sequence remains unchanged, including after ack.
      for(const row of journal.receipts) {
        const sequence=row.event.sourceSequence;
        if(cursor!==null&&Number(cursor)>=sequence) continue;
        const result=await monitor.ingestEvidence({epoch:snapshot.collectorEpoch,sourceKey:sourceInstanceId,expectedCursor:cursor,nextCursor:String(sequence),events:[row.event],atMs:Date.now(),
          ...(cursor===null&&sequence>0?{gap:"retention"}:{})});
        if(result.storagePressure||result.retirementSkipped||result.conflicts){status={...status,intake:"gap"};return;}
        cursor=String(sequence);
        if(sequence>journal.acknowledgedThrough){await acknowledgeHostHealthEvidence(input.root,input.installationId,sequence);journal.acknowledgedThrough=sequence;}
      }
      status={...status,intake:"committed"};
    } catch {status={...status,intake:"unavailable"};}
  }
  async function replay(){await serial(async()=>intake(await readHostHealthJournal(input.root,input.installationId)));}
  async function retireEvidence(journal:HostHealthJournal) {
    try {
      await pruneHostSourceEvidence(input.root,journal,[active?.change.before?.evidenceRef,active?.change.after?.evidenceRef,
        pending?.change.before?.evidenceRef,pending?.change.after?.evidenceRef],()=>readHostSourceEvidencePins(input.root));
      retirementUnavailable=false;
    } catch { retirementUnavailable=true; }
  }
  function publish(a:HostArtifacts|null, analysis:StaticAnalysis|null, code:string|null, phase:HostHealthEvidence["analysis"], expectedGeneration:number,reference:NativeSourceIdentity=NATIVE_CHECKPOINT_PAIR, change?:HostSourceChange) {
    return serial(async()=>{
      if(closed||!enabled)return false;
      let current=expectedGeneration===generation&&(!a||await a.current());
      // Pending/gap evidence must describe the current observation. A complete
      // immutable result may arrive late, but can only be retained as history.
      if(!current&&(!a||!analysis))return false;
      if(!current)dirty=true;
      const journal=await readHostHealthJournal(input.root,input.installationId), sequence=journal?.nextSequence??0;
      // A previous commit may have outlived an intake/cleanup failure. Replay it
      // before needing another journal slot; never strand committed evidence.
      await intake(journal);
      const covered=new Set<string>(HOST_CHECK_REQUIREMENTS.flatMap(c=>[...c.slices]));
      let transition = change;
      if (!transition) {
        const latest = journal?.receipts.slice().reverse().find(row => row.event.sourceState !== "snapshot")?.event.sourceChange;
        const prior = journal?.receipts.slice().reverse().find(row => row.event.sourceState === "stable" && row.event.sourceChange?.after)?.event.sourceChange?.after ?? null;
        const before = prior ? await retainedHostSourceWindow(input.root, prior) : null;
        const selectedRecipeSha = a ? sha256Text(canonicalJson(a.profile?.slices ?? orderedRecipe)) : null;
        // An exact restart/retry keeps the original transition and its before
        // side; it must not invent A->A or re-dispatch A->B under a fresh ID.
        if (latest && (a ? latest.after?.sourceSet === a.sourceSet && latest.after.recipeSha === selectedRecipeSha : latest.after === null)) {
          transition = { ...latest, before: latest.before ? await retainedHostSourceWindow(input.root, latest.before) : null,
            after: latest.after ? await retainedHostSourceWindow(input.root, latest.after) : null };
        } else {
          const after = a ? await captureHostSourceWindow(input.root, a, orderedRecipe) : null;
          transition = describeHostSourceChange({ episodeId: hostSourceEpisodeId(input.installationId, sequence, before, after), before, after });
        }
      }
      // Retry only the current AFTER side, with every immutable digest/window
      // checked. This adds a new observation; it never edits earlier evidence or
      // substitutes changed current bytes for an unavailable historical source.
      if(a&&transition.after&&!transition.after.evidenceRef&&transition.after.sourceSet===a.sourceSet) {
        const recovered=await captureHostSourceWindow(input.root,a,orderedRecipe);
        if(canonicalJson({...recovered,evidenceRef:null})===canonicalJson({...transition.after,evidenceRef:null}))
          transition={...transition,after:recovered};
      }
      // Private attachment I/O may span another disk update or policy change.
      // Recheck the original immutable window before publishing it as current.
      current = current && expectedGeneration === generation && (!a || await a.current());
      if (closed || !enabled || !current && (!a || !analysis)) return false;
      if (!current) dirty = true;
      const running = status.runtime?.state === "current" ? status.runtime.receipt : null;
      const sourceChange = describeHostSourceChange({ ...transition, staticViolation: phase === "violated",
        running: running ? { observationId: running.observationId, sourceSha: running.sourceSha, candidateSha: running.candidateSha } : null });
      const event:HostHealthEvidence={name:"host_patch_health",schemaVersion:1,eventId:randomUUID(),at:new Date().toISOString(),installationId:input.installationId,contractRevision:HOST_HEALTH_CONTRACT,
        sourceInstanceId,sourceSequence:sequence,sourceState:a?(current?"stable":"snapshot"):code==="source-changed"?"changed":"unavailable",sourceSet:a?.sourceSet??null,sourceSha:a?.sourceSha??null,
        workerSha:a?.workerSha??null,profileDigest:a?.profileDigest??null,candidateSha:a?.candidate?sha256Bytes(a.candidate):null,checkerBuildId:analysis?.buildId??null,
        companionQualification:a?.companionQualification??"not-required",applicability:a?.applicability??"profile-unavailable",analysis:phase,
        requiredChecks:HOST_CHECK_REQUIREMENTS.map(c=>c.id),failedChecks:analysis?.checks.filter(c=>c.state==="violated").map(c=>c.id)??[],
        unsupportedChecks:analysis?.checks.filter(c=>c.state==="unsupported").map(c=>c.id)??[],uncoveredSlices:a?.profile?.slices.map(s=>s.id).filter(id=>!covered.has(id))??[],
        loaded:"not-observed",attachment:"not-observed",exercised:"not-exercised",notificationCoverage:"local-only",detectorCode:code,qualified:false,
        ...(a?{recipeSha,sourceEvolution:evolution(a,analysis,reference)}:{}), sourceChange};
      const next=await retainHostHealthEvidence(input.root,input.installationId,sequence,{event,analysis});
      if(current)status={...status,latest:event,assessment:hostHealthSummary(event),intake:"not-observed"};
      await ports.afterRetain?.(); await intake(next);
      // Housekeeping cannot withhold an already committed observation from OBS.
      await retireEvidence(next); return true;
    });
  }
  const runtimeSource=sha256Text(canonicalJson(["host-runtime",input.installationId]));
  async function runtimeIntake(journal:HostRuntimeJournal|null) {
    if(!journal){status={...status,runtimeIntake:"not-observed"};return;}
    try {
      const monitor=openMonitorStore(input.root), snapshot=await monitor.snapshot();
      if(!snapshot.collectorEpoch||!snapshot.collectorRecordedRunning)throw Error("observation-inactive");
      let cursor=(await monitor.evidenceCursor(runtimeSource))?.cursor??null;
      for(const row of journal.receipts){
        const sequence=row.event.sourceSequence;if(cursor!==null&&Number(cursor)>=sequence)continue;
        const result=await monitor.ingestEvidence({epoch:snapshot.collectorEpoch,sourceKey:runtimeSource,expectedCursor:cursor,nextCursor:String(sequence),events:[row.event],atMs:Date.now(),
          ...(cursor===null&&sequence>0?{gap:"retention"}:{})});
        if(result.storagePressure||result.retirementSkipped||result.conflicts){status={...status,runtimeIntake:"gap"};return;}
        cursor=String(sequence);
        if(sequence>journal.acknowledgedThrough){await acknowledgeHostRuntimeEvidence(input.root,input.installationId,sequence);journal.acknowledgedThrough=sequence;}
      }
      status={...status,runtimeIntake:enabled && runtimeKey===observedRuntimeKey && witnessKey===observedWitnessKey?"committed":"not-observed"};
    }catch{status={...status,runtimeIntake:"unavailable"};}
  }
  async function tickRuntime() {
    if(closed||!enabled||!gate)return;
    const selectedRoot=runtimeRoot, observationSignal=observationController.signal;
    const observation=await observeHostCompilation(input.root,selectedRoot,paths.source,ports.runtime);
    if(closed||!enabled||observationSignal.aborted||selectedRoot!==runtimeRoot)return;
    const key=canonicalJson([selectedRoot,observation.state,observation.process,observation.receipt]);
    observedRuntimeKey=key;
    if(observation.state!==status.runtime?.state || observation.receipt?.observationId!==status.runtime?.receipt?.observationId) observedWitnessKey=null;
    status={...status,runtime:observation,
      // Preserve detector failures as well as positive samples while the same
      // launch is selected. A fast marker tick cannot erase an invalid reply.
      witness:observation.state===status.runtime?.state&&observation.receipt?.observationId===status.runtime?.receipt?.observationId?status.witness:null,
      ...(key!==runtimeKey?{runtimeIntake:"not-observed" as const}:{})};
    await serial(async()=>{
      if(closed||!enabled||observationSignal.aborted||selectedRoot!==runtimeRoot)return;
      let journal=await readHostRuntimeJournal(input.root,input.installationId);
      // First observation after a Server restart is fresh process evidence,
      // even if immutable compilation bytes match the retained receipt.
      if(key!==runtimeKey){
        const event:HostRuntimeEvidence={name:"host_runtime_health",schemaVersion:1,eventId:randomUUID(),at:new Date().toISOString(),installationId:input.installationId,
          sourceInstanceId:runtimeSource,sourceSequence:journal?.nextSequence??0,observation};
        journal=await retainHostRuntimeEvidence(input.root,input.installationId,event);
        runtimeKey=key;status={...status,runtimeIntake:"not-observed"};await ports.runtime?.afterRetain?.();
      }
      await runtimeIntake(journal);
    });
  }
  async function tickWitness() {
    if (closed || !enabled || !gate) return;
    const selectedRoot = runtimeRoot, observedGeneration = generation, compilation = status.runtime, observationSignal=observationController.signal;
    const selectedLaunch = canonicalJson([compilation?.state ?? null, compilation?.receipt ?? null]);
    const stillSelected = () => !observationSignal.aborted && selectedRoot === runtimeRoot && observedGeneration === generation
      && selectedLaunch === canonicalJson([status.runtime?.state ?? null, status.runtime?.receipt ?? null]);
    const observation = await observeHostWitness({ root: input.root, runRoot: selectedRoot, target: paths.source,
      compilation, read: input.readWitness, previous: previousWitness, inspect: ports.runtime }, AbortSignal.any([controller.signal,observationSignal]));
    if (closed || !enabled || !stillSelected()) return;
    if (observation.snapshot) previousWitness = { observationId: observation.snapshot.compilation.observationId, sequence: observation.snapshot.sequence,
      eventTotal: observation.snapshot.eventsDropped + observation.snapshot.events.length, leaseOpportunity: observation.snapshot.leaseOpportunity };
    const s = observation.snapshot;
    // Challenge/sequence/heartbeat are read freshness, not new business evidence.
    const key = canonicalJson([selectedRoot, observation.state, observation.reason, s ? [s.version, s.compilation, s.capabilities, s.events, s.eventsDropped, s.untrackedSlices, s.leaseOpportunity] : null]);
    observedWitnessKey = key;
    status = { ...status, witness: observation, ...(key !== witnessKey ? { runtimeIntake: "not-observed" as const } : {}) };
    await serial(async () => {
      if (closed || !enabled || !stillSelected()) return;
      let journal = await readHostRuntimeJournal(input.root, input.installationId);
      if (key !== witnessKey) {
        const event: HostWitnessEvidence = { name: "host_capability_health", schemaVersion: 1, eventId: randomUUID(), at: new Date().toISOString(),
          installationId: input.installationId, sourceInstanceId: runtimeSource, sourceSequence: journal?.nextSequence ?? 0, observation };
        journal = await retainHostRuntimeEvidence(input.root, input.installationId, event); witnessKey = key;
        await ports.afterWitnessRetain?.();
      }
      await runtimeIntake(journal);
    });
  }
  async function pauseObservation(state:"disabled"|"blocked", reason:string) {
    if(enabled){generation++;currentKey=null;analyzedKey=null;}
    enabled=false;observationController.abort();pending?.controller.abort();active?.controller.abort();pending=null;dirty=true;
    runtimeKey=null;witnessKey=null;observedRuntimeKey=null;observedWitnessKey=null;
    for(const watcher of watchers)watcher.close();watchers=[];
    await serial(async()=>{await gate?.release();gate=null;});
    status={...status,state,reason,runtime:null,witness:null,runtimeIntake:"not-observed",watch:"backstop-only"};
  }
  async function tick() {
    if(closed) return;
    // Observation is NOT execution intent or notification permission. The
    // Server owns public configuration; an invalid read fails closed here.
    let config;
    try {
      config=input.enabled===false?null:(await openConfigStore(rootConfigLayout(input.root)).read()).document;
      const observe = config ? await (input.observationEnabled ?? ports.observationEnabled ?? (()=>true))() : false;
      if(typeof observe !== "boolean")throw Error("invalid-observation-policy");
      if(!observe){await pauseObservation("disabled","observation-disabled");return;}
    } catch {await pauseObservation("blocked","observation-config-unavailable");return;}
    if(!config)return;
    if(observationController.signal.aborted)observationController=new AbortController();
    enabled=true;
    runtimeRoot=ports.runtime?.runRoot??config.daemon?.observation?.runRoot??ephemeralRuntimeRoot();
    if(!gate) {
      await assertSafeDirectory(input.root);await assertSafeDirectory(join(input.root,"state"),true);
      gate=await acquireAdvisoryGate(join(input.root,"state","host-health-producer.gate"));
      if(!gate){status={...status,state:"blocked",reason:"competing-owner"};return;}
      const journal=await readHostHealthJournal(input.root,input.installationId);
      status={...status,latest:journal?.receipts.slice().reverse().find(row=>row.event.sourceState!=="snapshot")?.event??null};
      for(const row of journal?.receipts??[]){
        if(row.analysis&&row.event.sourceSet&&row.event.recipeSha===recipeSha)cache.set(analysisKey(row.event.sourceSet,row.analysis.buildId),row.analysis);
      }
      await serial(()=>intake(journal));
      for(const dir of new Set(Object.values(paths).filter((p):p is string=>p!==null).map(dirname))) {
        try {const watcher=watch(dir,()=>{dirty=true;});watcher.on("error",()=>{status={...status,watch:"backstop-only"};dirty=true;});watchers.push(watcher);} catch {}
      }
      status={...status,watch:watchers.length===new Set(Object.values(paths).filter((p):p is string=>p!==null).map(dirname)).size?"active":"backstop-only"};
    }
    const now=Date.now();
    if(now<retryAt||!dirty&&now-lastHashAt<backstopMs){await replay();return;}
    dirty=false;status={...status,lastAttemptAtMs:now};
    let a:HostArtifacts;
    try {a=await readHostArtifacts(paths,controller.signal);} catch(error) {
      const code=error instanceof HostSourceFailure?error.code:"source-unavailable", key=`gap:${code}`;
      pending=null;analyzedKey=null;
      if(key!==currentKey){currentKey=key;generation++;await publish(null,null,code,"unavailable",generation);}
      status={...status,state:"blocked",reason:code,assessment:"unknown"};
      dirty=true;retryAt=now+Math.min(30000,Math.max(pollMs,250)*2**Math.min(failures++,6));await replay();return;
    }
    lastHashAt=now;status={...status,observedAtMs:now};
    let buildId:string|null=null;
    try {buildId=(await runtime.runPromise(Effect.gen(function*(){const verifier=yield* HostVerifier;return yield* verifier.identity();}),{signal:controller.signal})).buildId;} catch {}
    const key=analysisKey(a.sourceSet,buildId);
    if(currentKey!==key){currentKey=key;generation++;analyzedKey=null;}
    if(analyzedKey===key){
      await replay();
      if(retirementUnavailable)await serial(async()=>{const journal=await readHostHealthJournal(input.root,input.installationId);if(journal)await retireEvidence(journal);});
      status={...status,state:"running",reason:retirementUnavailable?"evidence-retirement-unavailable":"observed"};return;
    }
    if(active?.key===key){pending=null;return;}
    if(pending?.key===key)return;
    // Exact failure is retained and indexed BEFORE slow parsing or a failed
    // verifier handshake. It cannot be erased by that later analysis failure.
    const previous=status.latest;
    const reference=previous?.sourceSha&&previous.workerSha?{host:previous.sourceSha,worker:previous.workerSha}:NATIVE_CHECKPOINT_PAIR;
    if(!await publish(a,null,a.failureCode,"pending",generation,reference))return;
    pending={artifacts:a,generation,key,buildId,reference,change:status.latest!.sourceChange!,controller:new AbortController()};status={...status,state:"running",reason:"analysis-queued"};
  }
  async function analyzePending() {
    if(closed||!enabled||!pending) return;
    const job=pending;pending=null;
    if(job.key!==currentKey)return;
    active=job;const a=job.artifacts;
    let analysis=cache.get(job.key)??null, code:string|null=null;
    try {
      if(!analysis) {
        await ports.beforeAnalyze?.(a.sourceSet);
        status={...status,analyses:status.analyses+1};
        analysis=await runtime.runPromise(analyzeArtifacts(a),{signal:AbortSignal.any([controller.signal,job.controller.signal])});
        if(analysis.buildId!==job.buildId) throw new VerifierFailure("build-changed");
        cache.set(job.key,analysis);while(cache.size>64)cache.delete(cache.keys().next().value!);
      }
    } catch(error){analysis=null;code=error instanceof VerifierFailure?error.code:"analysis-unavailable";}
    if(closed||!enabled||job.controller.signal.aborted) {active=null;return;}
    const phase=analysis===null?"unavailable":analysis.artifacts.some(s=>!s.valid)||analysis.checks.some(c=>c.state==="violated")?"violated":analysis.checks.some(c=>c.state!=="passed")?"unsupported":"passed";
    try { if(!await publish(a,analysis,code,phase,job.generation,job.reference,job.change)){dirty=true;return;} }
    finally { active=null; }
    if(job.generation!==generation||!await a.current()){dirty=true;return;}
    const attachmentReady=!!status.latest?.sourceChange?.after?.evidenceRef;
    if(analysis&&attachmentReady){analyzedKey=job.key;retryAt=0;failures=0;}
    else {dirty=true;retryAt=Date.now()+Math.min(30000,Math.max(pollMs,250)*2**Math.min(failures++,6));}
    status={...status,state:"running",reason:retirementUnavailable?"evidence-retirement-unavailable":!attachmentReady?"evidence-unavailable"
      :a.applicability==="mismatch"?"recipe-mismatch":analysis?"observed":"analysis-unavailable"};
  }
  const lane=(work:()=>Promise<void>, interval=pollMs)=>Effect.forever(Effect.gen(function*(){
    yield* local(work).pipe(Effect.catch(()=>Effect.sync(()=>{status={...status,state:"blocked",reason:"source-or-provenance-unavailable"};retryAt=Date.now()+Math.max(pollMs,1000);dirty=true;})));
    yield* Effect.sleep(interval);
  }));
  const fiber=runtime.runFork(Effect.scoped(Effect.gen(function*(){yield* lane(tick).pipe(Effect.forkScoped);yield* lane(analyzePending).pipe(Effect.forkScoped);
    yield* lane(async()=>{try{await tickRuntime();}catch{status={...status,runtimeIntake:"unavailable"};}}).pipe(Effect.forkScoped);
    yield* lane(async()=>{try{await tickWitness();}catch{status={...status,witness:{state:"unavailable",reason:"read-unavailable",observedAtMs:Date.now(),snapshot:null,qualified:false},runtimeIntake:"unavailable"};}},witnessPollMs).pipe(Effect.forkScoped);
    yield* Effect.never;})));
  let closePromise:Promise<void>|undefined;
  return {status:()=>{
    const value=structuredClone(status);
    if(value.witness?.state==="current"&&(closed||Date.now()-value.witness.observedAtMs>witnessPollMs+5000||Date.now()<value.witness.observedAtMs))
      value.witness={state:"unavailable",reason:"read-unavailable",observedAtMs:value.witness.observedAtMs,snapshot:null,qualified:false};
    return value;
  },refresh:()=>{dirty=true;retryAt=0;},close:()=>closePromise??=(async()=>{
    closed=true;controller.abort();for(const w of watchers)w.close();watchers=[];
    await Effect.runPromise(Fiber.interrupt(fiber));await runtime.dispose();await writes;await gate?.release();gate=null;status={...status,state:"stopped",reason:"stopped"};
  })()};
}
