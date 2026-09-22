import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, normalizeDesktopPrune, normalizeDesktopPolicy, type DesktopView, type DesktopOperation, type DesktopPolicyReceipt } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime, useConsole } from "../components/ui.tsx";
import { denied, readView, viewError } from "../lib/views.ts";
import { localOperations, rememberOperation, markOperation, operationSearch, type LocalOperation } from "../lib/operations.ts";
export const Route=createFileRoute("/_console/desktop")({
  loader:({context})=>context.bootstrap.session!.capabilities.includes("desktop.read")?readView(context.services.client(context.bootstrap.binding).desktop()):Promise.resolve(denied<DesktopView>()),
  component:Desktop,
});
function Desktop(){const data=Route.useLoaderData();return <><Heading eyebrow="LOCAL DESKTOP OBSERVATION" title="Desktop">Review exact display instances before reclaim. A quiet snapshot is not an atomic lease; stopping a fork can remove its browser profile.</Heading>
  <ErrorNotice error={viewError(data)}/>{data.data&&<DesktopControls view={data.data}/>}</>;}
function DesktopControls({view}:{view:DesktopView}){
  const {services,bootstrap}=useConsole(),router=useRouter(),busy=useRef(false),caps=bootstrap.session!.capabilities;
  const scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId};
  const [review,setReview]=useState(view),[expectedConfig,setExpectedConfig]=useState(view.configRevision),[keep,setKeep]=useState(JSON.stringify(view.keepAgentIds,null,2));
  const [automatic,setAutomatic]=useState(view.automatic),[idle,setIdle]=useState(String(view.minIdleMs)),[action,setAction]=useState<"keep"|"idle-reclaim">("keep");
  const [pruneConfirm,setPruneConfirm]=useState(false),[policyConfirm,setPolicyConfirm]=useState(false),[pending,setPending]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState<unknown>();
  const [rows,setRows]=useState<LocalOperation[]>([]),[locator,setLocator]=useState<LocalOperation>(),[receipt,setReceipt]=useState<DesktopOperation|DesktopPolicyReceipt>();
  const readLocal=()=>{try{setRows(localOperations(localStorage,scope).filter(r=>r.command==="desktop-prune"||r.command==="desktop-policy"));setReady(true);}catch(e){setReady(false);setError(e);}};
  useEffect(()=>{readLocal();window.addEventListener("storage",readLocal);return()=>window.removeEventListener("storage",readLocal);},[scope.installationId,scope.principalId]);
  const unknown=rows.filter(r=>["unknown","awaiting-response"].includes(r.state)),pruneUnknown=unknown.find(r=>r.command==="desktop-prune"),policyUnknown=unknown.find(r=>r.command==="desktop-policy");
  async function client(){return services.prepareWrite(bootstrap.binding,scope.principalId);}
  async function refresh(){if(busy.current)return;busy.current=true;setPending(true);setError(undefined);try{const current=(await services.client(bootstrap.binding).desktop()).data;setReview(current);setExpectedConfig(current.configRevision);setPruneConfirm(false);setPolicyConfirm(false);}catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function recover(row:LocalOperation){if(busy.current)return;busy.current=true;setPending(true);setError(undefined);try{const api=services.client(bootstrap.binding),value=(await(row.command==="desktop-prune"?api.desktopOperation(row.requestId):api.desktopPolicyOperation(row.requestId))).data;setReceipt(value);setLocator(row);markOperation(localStorage,row,value.state);readLocal();}catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function submit(kind:"prune"|"policy"){
    if(busy.current||!ready||kind==="prune"&&(!pruneConfirm||pruneUnknown||!review.canPrune||!caps.includes("desktop.prune"))||kind==="policy"&&(!policyConfirm||policyUnknown||!caps.includes("desktop.write")))return;
    busy.current=true;setPending(true);setError(undefined);let local:LocalOperation|undefined;
    try{const requestId=crypto.randomUUID();
      const request=kind==="prune"?normalizeDesktopPrune({requestId,expectedRevision:review.revision,confirmed:true})
        :normalizeDesktopPolicy({requestId,expectedRevision:expectedConfig,confirmed:true,action,...(action==="keep"?{agentIds:JSON.parse(keep)}:{enabled:automatic,minIdleMs:Number(idle)})});
      const api=await client();local=rememberOperation(localStorage,scope,request);setLocator(local);readLocal();
      const value=(await(kind==="prune"?api.pruneDesktop(request):api.changeDesktopPolicy(request as Parameters<typeof api.changeDesktopPolicy>[0]))).data;
      setReceipt(value);markOperation(localStorage,local,value.state);if("revision"in value)setExpectedConfig(value.revision);setPruneConfirm(false);setPolicyConfirm(false);await router.invalidate();
    }catch(e){setError(e);if(local){const value=e instanceof ManagementClientError&&e.code==="desktop_prune_refused"?e.details?.operation as DesktopOperation|undefined:undefined;
      if(value){setReceipt(value);markOperation(localStorage,local,value.state);}else markOperation(localStorage,local,e instanceof ManagementClientError&&["invalid_input","permission_denied","revision_conflict","idempotency_conflict"].includes(e.code)?"refused":"unknown");}
    }finally{readLocal();busy.current=false;setPending(false);}
  }
  const candidates=review.displays.filter(r=>r.idle);
  return <><Card title="Current display review"><div data-testid="desktop-review"><p><Badge>{review.state}</Badge> · automatic {review.automatic?"enabled":"disabled"} · worker {view.worker}</p><SourceTime at={review.observedAtMs}/>
    <p className="field-note">Main display and installation floor are always protected. Missing source or process evidence cannot authorize reclaim. At most eight reviewed candidates are attempted per batch.</p>
    <button onClick={refresh} disabled={pending}>Refresh desktop review, keep draft</button>
    {!review.displays.length?<Empty>No verified display rows in this observation.</Empty>:<div className="table-wrap"><table><thead><tr><th>Display</th><th>Bot</th><th>Observation</th><th>Protection / reason</th></tr></thead><tbody>{review.displays.map(r=><tr key={r.agentId}><td>{r.display}</td><td><code>{r.agentId}</code></td><td>{r.lit?"Lit":"Dark"} · {r.idle?"Eligible":"Not eligible"}</td><td>{r.protected?"Protected":r.busyReason??"None observed"}</td></tr>)}</tbody></table></div>}
    <p>Reviewed eligible instances: {candidates.length}. The original plan is rechecked before each helper call.</p></div></Card>
    <ErrorNotice error={error}/>{!ready&&<p className="notice" role="alert">Local recovery storage is unavailable. No desktop action will be submitted.</p>}
    {unknown.length>0&&<Card title="Original desktop requests">{unknown.map(row=><div key={row.requestId}><code>{row.requestId}</code><p>{row.command}: unresolved; a page reload cannot authorize a replacement.</p><button onClick={()=>recover(row)} disabled={pending||!caps.includes("operations.read")}>Recover {row.command==="desktop-prune"?"desktop reclaim":"desktop policy"}</button><Link to="/operations" search={operationSearch(row)}>Inspect original request</Link></div>)}</Card>}
    <Card title="Reclaim reviewed idle desktops"><p>This action uses the installed stop-window helper, can destroy the fork's Chrome profile and does not delete a Bot. It neither enables future reclaim nor promises that external side effects are undone.</p>
      <label><input type="checkbox" checked={pruneConfirm} onChange={e=>setPruneConfirm(e.target.checked)} disabled={pending||!ready||!!pruneUnknown||!caps.includes("desktop.prune")}/>I confirm the reviewed desktop reclaim and possible browser-profile loss.</label>
      <button onClick={()=>submit("prune")} disabled={pending||!ready||!pruneConfirm||!!pruneUnknown||!review.canPrune||!caps.includes("desktop.prune")}>Reclaim reviewed desktops</button></Card>
    <Card title="Desktop policy"><form onSubmit={(e:FormEvent)=>{e.preventDefault();void submit("policy");}}><fieldset disabled={pending||!ready||!!policyUnknown||!caps.includes("desktop.write")}>
      <label htmlFor="desktop-policy-action">Policy action</label><select id="desktop-policy-action" value={action} onChange={e=>setAction(e.target.value as typeof action)}><option value="keep">Explicit protected Bot set</option><option value="idle-reclaim">Automatic idle reclaim</option></select>
      {action==="keep"?<><label htmlFor="desktop-keep">Exact protected Bot UUIDs (JSON array)</label><textarea id="desktop-keep" value={keep} onChange={e=>setKeep(e.target.value)} rows={4} spellCheck={false}/><p className="field-note">This changes the user protection set, never the installation floor or main display.</p></>:<><label><input type="checkbox" checked={automatic} onChange={e=>setAutomatic(e.target.checked)}/>Enable future automatic reclaim</label><label htmlFor="desktop-idle-ms">Minimum idle time (milliseconds)</label><input id="desktop-idle-ms" type="number" min="600000" max="86400000" value={idle} onChange={e=>setIdle(e.target.value)}/></>}
      <label><input type="checkbox" checked={policyConfirm} onChange={e=>setPolicyConfirm(e.target.checked)}/>I confirm this policy; enabling authorizes future eligible desktop helper effects.</label><button type="submit" disabled={!policyConfirm}>Apply desktop policy</button></fieldset></form>
      <p className="field-note">Draft policy and observed revision are separate. Refresh explicitly after a conflict; saving is not proof that a running consumer has adopted the policy.</p></Card>
    {receipt&&<Card title="Original desktop receipt"><div data-testid="desktop-receipt"><Badge>{receipt.state}</Badge><p><code>{receipt.requestId}</code></p>{"rows"in receipt?<><p>Recorded batch: {receipt.rows.length} instances. Bot deletion: no. Atomic seat lease: no.</p>{receipt.rows.map(r=><p key={r.display}>Display {r.display}: {r.state} · {r.observation}</p>)}</>:<p>Configuration publication: {receipt.state}. Consumer adoption is not observed by this receipt.</p>}{locator&&<Link to="/operations" search={operationSearch(locator)}>View original desktop operation</Link>}</div></Card>}
  </>;
}
