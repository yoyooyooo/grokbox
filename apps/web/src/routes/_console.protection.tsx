import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import type { ProtectionOverview, ProtectionBotView, ProtectionSnapshotList, ProtectionSnapshot, ProtectionHandover } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { ProtectionEditor } from "../components/protection-editor.tsx";
import { readView, viewError, boundedSearch, denied } from "../lib/views.ts";

export const Route=createFileRoute("/_console/protection")({
  validateSearch:(v:Record<string,unknown>):{bot?:string;snapshot?:string;handover?:string}=>({bot:boundedSearch(v.bot,160),snapshot:boundedSearch(v.snapshot,200),handover:boundedSearch(v.handover,200)}),
  loaderDeps:({search})=>search,
  loader:async({context,deps})=>{
    if(!context.bootstrap.session!.capabilities.includes("protection.read"))return {overview:denied<ProtectionOverview>(),bot:null,snapshots:null,snapshot:null,handover:null};
    const api=context.services.client(context.bootstrap.binding);
    const [overview,bot,snapshots,snapshot,handover]=await Promise.all([readView(api.protection()),deps.bot?readView(api.botProtection(deps.bot)):null,
      deps.bot?readView(api.protectionSnapshots(deps.bot,20)):null,deps.snapshot?readView(api.protectionSnapshot(deps.snapshot)):null,deps.handover?readView(api.protectionHandover(deps.handover)):null]);
    return {overview,bot,snapshots,snapshot,handover};
  },component:Protection,
});
function Protection(){
  const data=Route.useLoaderData(),search=Route.useSearch(),view=data.overview.data,router=useRouter(),navigate=useNavigate({from:Route.fullPath});
  const [selection,setSelection]=useState(search.bot??"");
  function select(event:FormEvent){event.preventDefault();if(selection.trim())void navigate({search:{bot:selection.trim()}});}
  return <><Heading eyebrow="PROTECTION & CONTINUITY" title="Bot protection">Keep observation, recovery material and successor duties distinct. A source gap is not ownership loss, and a usable successor is not proof that the old Bot can be retired.</Heading>
    <ErrorNotice error={viewError(data.overview)}/>
    {view&&<>
      <Card title="Background protection"><div data-testid="protection-worker"><dl><dt>Owner</dt><dd>{view.worker.owner}</dd><dt>Process state</dt><dd><Badge tone={view.worker.state==="blocked"?"warn":"neutral"}>{view.worker.state}</Badge> <code>{view.worker.reason}</code></dd>
        <dt>Discovery coverage</dt><dd>{view.worker.discoveryCoverage} · {view.worker.targets} protected targets / {view.worker.rosterSize} observed candidates</dd>
        <dt>Last scope observation</dt><dd>{view.worker.scopeObservedAtMs===null?"Not observed":<SourceTime at={view.worker.scopeObservedAtMs}/>} </dd><dt>Retained recovery store</dt><dd>{view.store}</dd>
        <dt>Native execution / boot installation</dt><dd>not proven / not proven</dd></dl></div>
        {view.store==="unavailable"&&<p className="notice danger" role="alert">Recovery history is unavailable. It has not been recreated or treated as an empty healthy store.</p>}
        {view.worker.discoveryCoverage==="creation-pending"&&<p className="notice">New default enrollment is paused while a native creation is unassociated. Existing protected subjects remain distinct.</p>}
        <div className="actions"><button onClick={()=>router.invalidate()}>Refresh protection observations</button></div>
      </Card>
      <Card title="Protected identities"><form className="toolbar" onSubmit={select}><label htmlFor="protected-bot">Original Bot UUID or reference</label><input id="protected-bot" value={selection} onChange={e=>setSelection(e.target.value)} maxLength={160} required/><button type="submit">Inspect Bot protection</button></form>
        {view.subjects.length?<div className="table-wrap"><table><thead><tr><th>Original Bot</th><th>Current protected identity</th><th>Last ownership observation</th><th>Recovery material</th><th>Progress</th></tr></thead><tbody>{view.subjects.map(row=><tr key={row.botRef}>
          <td><Link to="/protection" search={{bot:row.botRef}}><code>{row.botRef}</code></Link></td><td><code>{row.currentBotRef}</code><small className="block muted">Generation {row.generation}</small></td>
          <td><Badge tone={row.ownership==="gap"?"warn":"neutral"}>{row.ownership??"not-observed"}</Badge><small className="block muted">{row.freshness} · {row.observedAtMs===null?"Not observed":<SourceTime at={row.observedAtMs}/>} </small></td>
          <td>{row.lastSnapshotRef?<Link to="/protection" search={{bot:row.botRef,snapshot:row.lastSnapshotRef}}>Inspect retained snapshot</Link>:"No saved snapshot"}</td>
          <td>{row.lastAction??"No advancement observed"}{row.pendingHandoverRef&&<Link className="block" to="/protection" search={{bot:row.botRef,handover:row.pendingHandoverRef}}>Inspect handover</Link>}
            {row.handoverRefs.filter(ref=>ref!==row.pendingHandoverRef).map(ref=><Link key={ref} className="block" to="/protection" search={{bot:row.botRef,handover:ref}}>Inspect successor handover</Link>)}
            {row.handoverHistoryTruncated&&<small className="block muted">Only the latest 16 handover links are shown; the underlying records were not erased.</small>}
          </td>
        </tr>)}</tbody></table></div>:<Empty>{view.store==="unavailable"?"Protected identity history cannot be read.":"No retained protected subjects yet. Default enrollment requires fresh, owned Box evidence; explicit policy exclusions remain in force."}</Empty>}
        {view.hasMore&&<p className="notice">This view is bounded; additional retained subjects are not included.</p>}
        <p className="field-note">These are retained observations, not present execution authority. Temporal-only Bots are not automatically enrolled as Box-owned.</p>
      </Card>
      <ProtectionEditor key="system" view={view}/>
    </>}
    {data.bot&&<ErrorNotice error={viewError(data.bot)}/>}
    {data.bot?.data&&<><ProtectionEditor key={data.bot.data.botRef} view={data.bot.data}/><Card title="This Bot's retained state">
      <p><code>{data.bot.data.botRef}</code> · policy source: {data.bot.data.policySource}</p>
      {data.bot.data.subject?<dl><dt>Current identity</dt><dd><code>{data.bot.data.subject.currentBotRef}</code></dd><dt>Ownership loss</dt><dd>{data.bot.data.subject.lossId??"No open loss condition recorded"}</dd>
        <dt>Routine pause</dt><dd>{data.bot.data.subject.pause?`${data.bot.data.subject.pause.complete?"Completed observations":"Incomplete"}; ${data.bot.data.subject.pause.remaining} remaining, ${data.bot.data.subject.pause.failed} unavailable`:"Not performed"}</dd>
        <dt>Event export</dt><dd>{data.bot.data.subject.eventExportPending?"Pending; not delivery proof":"No pending export"} · {data.bot.data.subject.eventExportDropped} changes exceeded the retained export backlog</dd></dl>:<Empty>No protection observation is retained for this exact Bot. Its configuration alone does not prove adoption.</Empty>}
    </Card></>}
    {data.snapshots&&<Card title="Retained snapshot metadata"><ErrorNotice error={viewError(data.snapshots)}/>
      {data.snapshots.data&&!data.snapshots.data.snapshots.length&&<Empty>No retained snapshots for this exact Bot.</Empty>}
      {data.snapshots.data?.snapshots.map(s=><div className="receipt" key={s.snapshotRef}><Link to="/protection" search={{...search,snapshot:s.snapshotRef}}><code>{s.snapshotRef}</code></Link><p>{s.quality} · {s.state} · <SourceTime at={s.capturedAtMs}/></p></div>)}
      {data.snapshots.data?.hasMore&&<p className="notice">Only the newest 20 metadata records are shown. Older retained records are not erased.</p>}
    </Card>}
    {data.snapshot&&<Card title="Snapshot metadata"><ErrorNotice error={viewError(data.snapshot)}/>{data.snapshot.data&&<div data-testid="protection-snapshot"><dl>
      <dt>Reference</dt><dd><code>{data.snapshot.data.snapshotRef}</code></dd><dt>Quality</dt><dd>{data.snapshot.data.quality}</dd><dt>Stored revision</dt><dd><code>{data.snapshot.data.revision}</code></dd><dt>State</dt><dd>{data.snapshot.data.state}</dd></dl>
      <p>Private content is not loaded by this view. A stored material hash does not prove that native import or a resumed turn succeeded.</p></div>}</Card>}
    {data.handover&&<Card title="Successor and handover"><ErrorNotice error={viewError(data.handover)}/>{data.handover.data&&<div data-testid="protection-handover"><dl>
      <dt>Source Bot</dt><dd><code>{data.handover.data.sourceBotRef??"not-recorded"}</code></dd><dt>Target Bot</dt><dd><code>{data.handover.data.targetBotRef??"unassociated"}</code></dd><dt>Recorded phase</dt><dd>{data.handover.data.phase}</dd>
      <dt>Duties</dt><dd>{data.handover.data.complete} complete · {data.handover.data.remaining} remaining · {data.handover.data.unknown} unknown</dd></dl>
      <div className="table-wrap"><table><thead><tr><th>Step</th><th>Recorded state</th></tr></thead><tbody>{data.handover.data.steps.map(s=><tr key={s.step}><td>{s.step}</td><td>{s.state}</td></tr>)}</tbody></table></div>
      {data.handover.data.duties.length>0&&<div className="table-wrap"><table><thead><tr><th>Duty</th><th>State</th><th>Evidence recorded</th></tr></thead><tbody>{data.handover.data.duties.map(d=><tr key={d.itemId}><td>{d.kind}</td><td>{d.state}</td><td>{d.evidenceRecorded?"yes, not independently reverified":"no"}</td></tr>)}</tbody></table></div>}
      <p className="notice">Current target usability and retirement eligibility are not proven by this history. This view does not execute a task, retry an unknown effect or delete a Bot.</p>
    </div>}</Card>}
  </>;
}
