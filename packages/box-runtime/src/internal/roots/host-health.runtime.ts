import { Effect, Fiber, ManagedRuntime } from "effect";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOST_HEALTH_CONTRACT, HOST_CHECK_REQUIREMENTS, hostHealthSummary, type HostHealthEvidence, type HostRuntimeObservation, type HostRuntimeEvidence, type HostWitnessObservation, type HostWitnessEvidence, type StaticAnalysis } from "@grokbox/runtime-kernel/host-health";
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
import { applyPatchProfile, preflightProfileRecipe } from "../host/profile.ts";
import { acquireAdvisoryGate, type AdvisoryGate } from "../io/advisory-gate.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
export type HostHealthStatus = { owner:"management-server"; state:"starting"|"disabled"|"running"|"blocked"|"stopped"; reason:string;
  observedAtMs:number|null; lastAttemptAtMs:number|null; assessment:"blocked"|"unknown"|"degraded"; latest:HostHealthEvidence|null;
  intake:"not-observed"|"committed"|"unavailable"|"gap"; runtime:HostRuntimeObservation|null; witness:HostWitnessObservation|null; runtimeIntake:"not-observed"|"committed"|"unavailable"|"gap"; watch:"active"|"backstop-only"; analyses:number; qualified:false; executionAuthority:false };
export type HostHealthTestPorts = { enabled?:boolean; paths?:HostArtifactPaths; binaryDirectory?:string; pollMs?:number; backstopMs?:number;
  afterRetain?:()=>Promise<void>; onSpawn?:(pid:number)=>void;
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
export function startHostHealth(input:{root:string;installationId:string;enabled?:boolean;readWitness?:HostWitnessRead}, ports:HostHealthTestPorts={}) {
  const paths=ports.paths??{source:LIVE_HOST_BUNDLE,worker:join(dirname(LIVE_HOST_BUNDLE),"agent-isolation/agent-store-worker.cjs"),profile:reviewedProfilePath(input.root)};
  const pollMs=ports.pollMs??1000, backstopMs=ports.backstopMs??180000;
  if(!Number.isSafeInteger(pollMs)||pollMs<10||pollMs>30000||!Number.isSafeInteger(backstopMs)||backstopMs<pollMs||backstopMs>600000) throw Error("invalid-health-period");
  const witnessPollMs = ports.witnessPollMs ?? 10000;
  if (!Number.isSafeInteger(witnessPollMs) || witnessPollMs < 10 || witnessPollMs > 60000) throw Error("invalid-witness-period");
  const runtime=ManagedRuntime.make(hostVerifierLayer({directory:ports.binaryDirectory,onSpawn:ports.onSpawn}));
  const controller=new AbortController();
  let gate:AdvisoryGate|null=null, watchers:FSWatcher[]=[], dirty=true, lastHashAt=0, closed=false, enabled=false;
  let generation=0, currentKey:string|null=null, analyzedKey:string|null=null, retryAt=0, failures=0;
  type Pending={artifacts:HostArtifacts;generation:number;key:string;buildId:string|null};
  let pending:Pending|null=null, active:Pending|null=null;
  const cache=new Map<string,StaticAnalysis>();
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
  function publish(a:HostArtifacts|null, analysis:StaticAnalysis|null, code:string|null, phase:HostHealthEvidence["analysis"], expectedGeneration:number) {
    return serial(async()=>{
      if(closed||!enabled||expectedGeneration!==generation||a&&!await a.current()) return false;
      const journal=await readHostHealthJournal(input.root,input.installationId), sequence=journal?.nextSequence??0;
      const covered=new Set<string>(HOST_CHECK_REQUIREMENTS.flatMap(c=>[...c.slices]));
      const event:HostHealthEvidence={name:"host_patch_health",schemaVersion:1,eventId:randomUUID(),at:new Date().toISOString(),installationId:input.installationId,contractRevision:HOST_HEALTH_CONTRACT,
        sourceInstanceId,sourceSequence:sequence,sourceState:a?"stable":code==="source-changed"?"changed":"unavailable",sourceSet:a?.sourceSet??null,sourceSha:a?.sourceSha??null,
        workerSha:a?.workerSha??null,profileDigest:a?.profileDigest??null,candidateSha:a?.candidate?sha256Bytes(a.candidate):null,checkerBuildId:analysis?.buildId??null,
        companionQualification:a?.companionQualification??"not-required",applicability:a?.applicability??"profile-unavailable",analysis:phase,
        requiredChecks:HOST_CHECK_REQUIREMENTS.map(c=>c.id),failedChecks:analysis?.checks.filter(c=>c.state==="violated").map(c=>c.id)??[],
        unsupportedChecks:analysis?.checks.filter(c=>c.state==="unsupported").map(c=>c.id)??[],uncoveredSlices:a?.profile?.slices.map(s=>s.id).filter(id=>!covered.has(id))??[],
        loaded:"not-observed",attachment:"not-observed",exercised:"not-exercised",notificationCoverage:"local-only",detectorCode:code,qualified:false};
      const next=await retainHostHealthEvidence(input.root,input.installationId,sequence,{event,analysis});
      status={...status,latest:event,assessment:hostHealthSummary(event),intake:"not-observed"};
      await ports.afterRetain?.(); await intake(next); return true;
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
    const selectedRoot=runtimeRoot, observation=await observeHostCompilation(input.root,selectedRoot,paths.source,ports.runtime);
    if(closed||!enabled||selectedRoot!==runtimeRoot)return;
    const key=canonicalJson([selectedRoot,observation.state,observation.process,observation.receipt]);
    observedRuntimeKey=key;
    if(observation.state!==status.runtime?.state || observation.receipt?.observationId!==status.runtime?.receipt?.observationId) observedWitnessKey=null;
    status={...status,runtime:observation,
      // Preserve detector failures as well as positive samples while the same
      // launch is selected. A fast marker tick cannot erase an invalid reply.
      witness:observation.state===status.runtime?.state&&observation.receipt?.observationId===status.runtime?.receipt?.observationId?status.witness:null,
      ...(key!==runtimeKey?{runtimeIntake:"not-observed" as const}:{})};
    await serial(async()=>{
      if(closed||!enabled||selectedRoot!==runtimeRoot)return;
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
    const selectedRoot = runtimeRoot, observedGeneration = generation, compilation = status.runtime;
    const selectedLaunch = canonicalJson([compilation?.state ?? null, compilation?.receipt ?? null]);
    const stillSelected = () => selectedRoot === runtimeRoot && observedGeneration === generation
      && selectedLaunch === canonicalJson([status.runtime?.state ?? null, status.runtime?.receipt ?? null]);
    const observation = await observeHostWitness({ root: input.root, runRoot: selectedRoot, target: paths.source,
      compilation, read: input.readWitness, previous: previousWitness, inspect: ports.runtime }, controller.signal);
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
  async function tick() {
    if(closed) return;
    const config=input.enabled===false?null:(await openConfigStore(rootConfigLayout(input.root)).read()).document;
    if(!config||!config.runtime?.desiredMode||config.runtime.desiredMode==="disabled") {
      if(enabled){generation++;currentKey=null;analyzedKey=null;}
      enabled=false;pending=null;dirty=true;runtimeKey=null;witnessKey=null;observedRuntimeKey=null;observedWitnessKey=null;status={...status,state:"disabled",reason:"intent-disabled",runtime:null,witness:null,runtimeIntake:"not-observed"};return;
    }
    enabled=true;
    runtimeRoot=ports.runtime?.runRoot??config.daemon?.observation?.runRoot??ephemeralRuntimeRoot();
    if(!gate) {
      await assertSafeDirectory(input.root);await assertSafeDirectory(join(input.root,"state"),true);
      gate=await acquireAdvisoryGate(join(input.root,"state","host-health-producer.gate"));
      if(!gate){status={...status,state:"blocked",reason:"competing-owner"};return;}
      const journal=await readHostHealthJournal(input.root,input.installationId);
      status={...status,latest:journal?.receipts.at(-1)?.event??null};await serial(()=>intake(journal));
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
    const key=canonicalJson([HOST_HEALTH_CONTRACT,a.sourceSet,buildId]);
    if(currentKey!==key){currentKey=key;generation++;}
    if(analyzedKey===key){status={...status,state:"running",reason:"observed"};await replay();return;}
    if(active?.key===key&&active.generation===generation||pending?.key===key) return;
    // Exact failure is retained and indexed BEFORE slow parsing or a failed
    // verifier handshake. It cannot be erased by that later analysis failure.
    await publish(a,null,a.failureCode,"pending",generation);
    pending={artifacts:a,generation,key,buildId};status={...status,state:"running",reason:"analysis-queued"};
  }
  async function analyzePending() {
    if(closed||!enabled||!pending) return;
    const job=pending;pending=null;active=job;const a=job.artifacts;
    let analysis=cache.get(job.key)??null, code:string|null=null;
    try {
      if(!analysis) {
        status={...status,analyses:status.analyses+1};
        analysis=await runtime.runPromise(analyzeArtifacts(a),{signal:controller.signal});
        if(analysis.buildId!==job.buildId) throw new VerifierFailure("build-changed");
        cache.set(job.key,analysis);while(cache.size>4)cache.delete(cache.keys().next().value!);
      }
    } catch(error){analysis=null;code=error instanceof VerifierFailure?error.code:"analysis-unavailable";} finally {active=null;}
    if(closed||!enabled) return;
    if(job.generation!==generation||!await a.current()){dirty=true;return;}
    const phase=analysis===null?"unavailable":analysis.artifacts.some(s=>!s.valid)||analysis.checks.some(c=>c.state==="violated")?"violated":analysis.checks.some(c=>c.state!=="passed")?"unsupported":"passed";
    if(!await publish(a,analysis,code,phase,job.generation)){dirty=true;return;}
    if(analysis){analyzedKey=job.key;retryAt=0;failures=0;}
    else {dirty=true;retryAt=Date.now()+Math.min(30000,Math.max(pollMs,250)*2**Math.min(failures++,6));}
    status={...status,state:"running",reason:a.applicability==="mismatch"?"recipe-mismatch":analysis?"observed":"analysis-unavailable"};
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
  },refresh:()=>{dirty=true;analyzedKey=null;retryAt=0;cache.clear();},close:()=>closePromise??=(async()=>{
    closed=true;controller.abort();for(const w of watchers)w.close();watchers=[];
    await Effect.runPromise(Fiber.interrupt(fiber));await runtime.dispose();await writes;await gate?.release();gate=null;status={...status,state:"stopped",reason:"stopped"};
  })()};
}
