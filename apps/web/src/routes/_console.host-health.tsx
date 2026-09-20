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
 const view=Route.useLoaderData(),router=useRouter(),health=view.data,evidence=health?.latest;
 return <><Heading eyebrow="HOST COMPATIBILITY" title="Host patch health">Disk candidates, static checks and the running Host are separate facts. This page reads retained observations; refreshing never adopts a profile, restarts a Host or calls a model.</Heading>
 <ErrorNotice error={viewError(view)}/>
 <div className="toolbar"><button onClick={()=>router.invalidate()}>Refresh health observations</button><Link to="/incidents" search={{}}>Inspect persistent incidents</Link></div>
 {health&&<><Card title="Observer and delivery coverage"><dl data-testid="host-health-observer">
 <dt>Background owner</dt><dd>{health.owner}</dd><dt>Process state</dt><dd><Badge>{health.state}</Badge> · {health.reason}</dd>
 <dt>Source last checked</dt><dd>{health.observedAtMs===null?"Not observed":<SourceTime at={health.observedAtMs}/>} </dd><dt>Last attempt</dt><dd>{health.lastAttemptAtMs===null?"Not attempted":<SourceTime at={health.lastAttemptAtMs}/>} </dd>
 <dt>Change observation</dt><dd>{health.watch}</dd><dt>Completed evidence intake</dt><dd>{health.intake}</dd><dt>Analysis attempts</dt><dd>{health.analyses}</dd>
 <dt>Notification coverage</dt><dd>Local-only. No independent external delivery is claimed.</dd></dl>
 <p className="muted">A running observer is not proof that a patch works. An unavailable database or analyzer remains visible; existing receiver authorization is never relaxed to deliver a health warning.</p></Card>
 {!evidence?<Card title="Candidate evidence"><Empty>No candidate evidence has been retained. Disabled intent is not a repaired Host.</Empty></Card>:<>
 <Card title="Disk candidate compatibility"><div data-testid="host-health-candidate"><Badge tone={health.assessment==="blocked"?"warn":"neutral"}>{health.assessment}</Badge><dl>
 <dt>Source set</dt><dd>{evidence.sourceState}</dd><dt>Exact production recipe</dt><dd>{evidence.applicability}</dd><dt>Static analysis</dt><dd>{evidence.analysis}</dd>
 <dt>Host / worker qualification</dt><dd>{evidence.companionQualification}</dd><dt>Detector detail</dt><dd>{evidence.detectorCode??"No detector error recorded"}</dd>
 <dt>Evidence time</dt><dd><SourceTime at={Date.parse(evidence.at)}/></dd><dt>Evidence sequence</dt><dd>{evidence.sourceSequence}</dd>
 </dl><p className="notice">Candidate failure does not prove that an already-running Host has failed. No running process or model execution is stopped by this observer.</p></div></Card>
 <Card title="Required static checks"><div className="table-wrap"><table><thead><tr><th>Check</th><th>Recorded result</th></tr></thead><tbody>{evidence.requiredChecks.map(id=><tr key={id}><td><code>{id}</code></td><td>{evidence.failedChecks.includes(id)?"Violated":evidence.unsupportedChecks.includes(id)?"Unsupported":evidence.analysis==="passed"?"Passed within its declared scope":"Not established"}</td></tr>)}</tbody></table></div>
 <p className="muted">These are finite binding and control-flow checks, not whole-program execution proof. Source text and AST nodes are never loaded into this page.</p>
 <details><summary>Uncovered recipe slices ({evidence.uncoveredSlices.length})</summary>{evidence.uncoveredSlices.length?<p className="muted">{evidence.uncoveredSlices.join(", ")}</p>:<p>No uncovered slices recorded in this recipe. This does not supply missing runtime evidence.</p>}</details></Card>
 <Card title="Running Host evidence"><dl data-testid="host-health-runtime"><dt>Actual loaded generation</dt><dd>{evidence.loaded}</dd><dt>Handler attachment</dt><dd>{evidence.attachment}</dd><dt>Exercised behavior</dt><dd>{evidence.exercised}</dd><dt>Overall qualification</dt><dd>Not established</dd></dl><p className="muted">A source hash, a worker hash or three passing static predicates cannot establish loaded identity, native ownership, successful recovery or permission to run.</p></Card>
 <Card title="Exact evidence identities"><details><summary>Inspect source and checker digests</summary><dl>
 <dt>Source set</dt><dd><code>{evidence.sourceSet??"Unavailable"}</code></dd><dt>Host source</dt><dd><code>{evidence.sourceSha??"Unavailable"}</code></dd><dt>Worker source</dt><dd><code>{evidence.workerSha??"Unavailable"}</code></dd><dt>Reviewed profile</dt><dd><code>{evidence.profileDigest??"Unavailable"}</code></dd><dt>Transformed candidate</dt><dd><code>{evidence.candidateSha??"No exact candidate"}</code></dd><dt>Checker build</dt><dd><code>{evidence.checkerBuildId??"Unavailable"}</code></dd><dt>Evidence</dt><dd><code>{evidence.eventId}</code></dd>
 </dl></details></Card></>}
 </>}
 </>;
}
