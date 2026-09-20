import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { readView, denied, viewError } from "../lib/views.ts";
import type { HostHealthView } from "@grokbox/client";

export const Route=createFileRoute("/_console/host-health")({
 loader:({context})=>context.bootstrap.session?.capabilities.includes("system.read")
  ? readView(context.services.client(context.bootstrap.binding).hostHealth()) : denied<HostHealthView>(),
 component:HostHealth,
});
function HostHealth(){
 const view=Route.useLoaderData(),router=useRouter(),health=view.data,evidence=health?.latest,runtime=health?.runtime,receipt=runtime?.receipt,witness=health?.witness,handles=witness?.snapshot;
 return <><Heading eyebrow="HOST COMPATIBILITY" title="Host patch health">Disk candidates, static checks and the running Host are separate facts. This page reads retained observations; refreshing never adopts a profile, restarts a Host or calls a model.</Heading>
 <ErrorNotice error={viewError(view)}/>
 <div className="toolbar"><button onClick={()=>router.invalidate()}>Refresh health observations</button><Link to="/incidents" search={{}}>Inspect persistent incidents</Link></div>
 {health&&<><Card title="Observer and delivery coverage"><dl data-testid="host-health-observer">
 <dt>Background owner</dt><dd>{health.owner}</dd><dt>Process state</dt><dd><Badge>{health.state}</Badge> · {health.reason}</dd>
 <dt>Source last checked</dt><dd>{health.observedAtMs===null?"Not observed":<SourceTime at={health.observedAtMs}/>} </dd><dt>Last attempt</dt><dd>{health.lastAttemptAtMs===null?"Not attempted":<SourceTime at={health.lastAttemptAtMs}/>} </dd>
 <dt>Change observation</dt><dd>{health.watch}</dd><dt>Completed evidence intake</dt><dd>{health.intake}</dd><dt>Analysis attempts</dt><dd>{health.analyses}</dd>
 <dt>Notification coverage</dt><dd>Local-only. No independent external delivery is claimed.</dd></dl>
 <p className="muted">A running observer is not proof that a patch works. An unavailable database or analyzer remains visible; existing receiver authorization is never relaxed to deliver a health warning.</p></Card>
 <Card title="Selected Host launch"><div data-testid="host-health-runtime"><dl>
 <dt>Compilation observation</dt><dd><Badge tone={receipt&&(receipt.patch==="refused"||receipt.nativeCompilation==="threw")?"warn":"neutral"}>{runtime?.state??"not-observed"}</Badge></dd>
 <dt>Process identity</dt><dd>{runtime?.process??"not-checked"}</dd><dt>Process checked at</dt><dd>{runtime?<SourceTime at={runtime.observedAtMs}/>:"Not observed"}</dd><dt>Runtime evidence intake</dt><dd>{health.runtimeIntake}</dd>
 {receipt&&<><dt>Original module evaluation</dt><dd>{receipt.nativeCompilation} · {receipt.code}</dd><dt>Patch application</dt><dd>{receipt.patch}</dd><dt>Original process</dt><dd>PID {receipt.pid} · start {receipt.start}</dd><dt>Evaluated source</dt><dd><code>{receipt.sourceSha}</code></dd>
 <dt>Relation to observed disk source</dt><dd>{evidence?.sourceSha?evidence.sourceSha===receipt.sourceSha?"Same observed bytes":"Different generations; existing execution is not stopped":"Disk source not observed"}</dd><dt>Compilation receipt</dt><dd><code>{receipt.observationId}</code></dd></>}
 <dt>Handler evidence</dt><dd>{witness?.state??"not-observed"}; exact scope below</dd><dt>Exercised behavior</dt><dd>{handles?.events.length?"Recorded boundaries only":"not-exercised"}</dd><dt>Overall qualification</dt><dd>Not established</dd></dl>
 <p className="muted">This is the selected launch marker, not a census of every Host. A successful module evaluation and matching sampled process identity do not prove native handler attachment, successful recovery or permission to run. A historical or missing marker cannot certify the current process.</p></div></Card>
 <Card title="Native handle witness"><div data-testid="host-health-witness"><dl><dt>Metadata challenge</dt><dd><Badge>{witness?.state??"not-observed"}</Badge> · {witness?.reason??"not-requested"}</dd><dt>Observed at</dt><dd>{witness?<SourceTime at={witness.observedAtMs}/>:"Not sampled"}</dd></dl>
 {handles&&<><div className="table-wrap"><table><thead><tr><th>Capability</th><th>Registered references</th><th>Missing dependencies</th></tr></thead><tbody>{handles.capabilities.filter(r=>r.required).map(r=><tr key={r.id}><td>{r.id}</td><td><Badge tone={r.handles!=="present"?"warn":"neutral"}>{r.handles}</Badge></td><td>{r.missingSlices.join(", ")||"None recorded"}</td></tr>)}</tbody></table></div>
 <details><summary>Other capability and slice coverage</summary><p className="muted">Not required by this mode or selected profile: {handles.capabilities.filter(r=>!r.required).map(r=>r.id).join(", ")||"None"}. Untracked slices: {handles.untrackedSlices.join(", ")||"None"}.</p></details></>}
 <p className="muted">A fresh challenge crossed the native status wrapper and checked the original function references. This is not proof that every native consumer uses them, or that a model or recovery succeeded. Missing or replaced references never grant repair authority.</p></div></Card>
 <Card title="Recorded execution boundaries"><div data-testid="host-health-witness-events">
 {!handles?<Empty>No verified current boundary window. A missing metadata read does not erase retained incident evidence.</Empty>:!handles.events.length?<Empty>No execution boundary observed. No business or model call is started to fill this gap.</Empty>:<><p className="muted">Showing {Math.min(8,handles.events.length)} of {handles.events.length} retained events; {handles.eventsDropped} earlier events omitted by the bounded Host window.</p><div className="table-wrap"><table><thead><tr><th>Capability / boundary</th><th>Result</th><th>Observed</th></tr></thead><tbody>{handles.events.slice(-8).map(e=><tr key={e.sequence}><td>{e.capability} · {e.stage}</td><td>{e.outcome}</td><td><SourceTime at={e.atMs}/></td></tr>)}</tbody></table></div></>}
 <p className="muted">Trigger opportunities are not independently observed here. A zero count cannot prove bypass, and a recognized failure predicate cannot prove that its caller stopped retrying. Correlated boundary records are not whole-path qualification.</p></div></Card>
 {!evidence?<Card title="Candidate evidence"><Empty>No candidate evidence has been retained. Disabled intent is not a repaired Host.</Empty></Card>:<>
 <Card title="Disk candidate compatibility"><div data-testid="host-health-candidate"><Badge tone={health.assessment==="blocked"?"warn":"neutral"}>{health.assessment}</Badge><dl>
 <dt>Source set</dt><dd>{evidence.sourceState}</dd><dt>Exact production recipe</dt><dd>{evidence.applicability}</dd><dt>Static analysis</dt><dd>{evidence.analysis}</dd>
 <dt>Host / worker qualification</dt><dd>{evidence.companionQualification}</dd><dt>Detector detail</dt><dd>{evidence.detectorCode??"No detector error recorded"}</dd>
 <dt>Evidence time</dt><dd><SourceTime at={Date.parse(evidence.at)}/></dd><dt>Evidence sequence</dt><dd>{evidence.sourceSequence}</dd>
 </dl><p className="notice">Candidate failure does not prove that an already-running Host has failed. No running process or model execution is stopped by this observer.</p></div></Card>
 <Card title="Required static checks"><div className="table-wrap"><table><thead><tr><th>Check</th><th>Recorded result</th></tr></thead><tbody>{evidence.requiredChecks.map(id=><tr key={id}><td><code>{id}</code></td><td>{evidence.failedChecks.includes(id)?"Violated":evidence.unsupportedChecks.includes(id)?"Unsupported":evidence.analysis==="passed"?"Passed within its declared scope":"Not established"}</td></tr>)}</tbody></table></div>
 <p className="muted">These are finite binding and control-flow checks, not whole-program execution proof. Source text and AST nodes are never loaded into this page.</p>
 <details><summary>Uncovered recipe slices ({evidence.uncoveredSlices.length})</summary>{evidence.uncoveredSlices.length?<p className="muted">{evidence.uncoveredSlices.join(", ")}</p>:<p>No uncovered slices recorded in this recipe. This does not supply missing runtime evidence.</p>}</details></Card>
 <Card title="Exact evidence identities"><details><summary>Inspect source and checker digests</summary><dl>
 <dt>Source set</dt><dd><code>{evidence.sourceSet??"Unavailable"}</code></dd><dt>Host source</dt><dd><code>{evidence.sourceSha??"Unavailable"}</code></dd><dt>Worker source</dt><dd><code>{evidence.workerSha??"Unavailable"}</code></dd><dt>Reviewed profile</dt><dd><code>{evidence.profileDigest??"Unavailable"}</code></dd><dt>Transformed candidate</dt><dd><code>{evidence.candidateSha??"No exact candidate"}</code></dd><dt>Checker build</dt><dd><code>{evidence.checkerBuildId??"Unavailable"}</code></dd><dt>Evidence</dt><dd><code>{evidence.eventId}</code></dd>
 </dl></details></Card></>}
 </>}
 </>;
}
