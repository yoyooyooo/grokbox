import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, normalizeJobStart, type JobView, type JobPolicyView, type JobLogPage, type JobCancelReceipt } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime, useConsole } from "../components/ui.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";
import { localOperations, rememberOperation, markOperation, operationSearch, jobLocalState, type LocalOperation } from "../lib/operations.ts";
export const Route=createFileRoute("/_console/jobs")({
  validateSearch:(s:Record<string,unknown>):{selected?:string;cursor?:string}=>({selected:boundedSearch(s.selected,128),cursor:boundedSearch(s.cursor,256)}),
  loaderDeps:({search})=>search,
  loader:async({context,deps})=>{
    const api=context.services.client(context.bootstrap.binding),read=context.bootstrap.session!.capabilities.includes("jobs.read");
    return {policy:read?await readView(api.jobPolicy()):denied<JobPolicyView>(),
      list:read?await readView(api.jobs({limit:20,cursor:deps.cursor})):null,
      selected:read&&deps.selected?await readView(api.job(deps.selected)):null};
  },component:Jobs,
});
function Jobs(){
  const data=Route.useLoaderData(),search=Route.useSearch(),router=useRouter();
  return <><Heading eyebrow="SERVICE-OWNED EXECUTION" title="Jobs">Run explicit OS work under the installed policy. Closing a page or CLI does not cancel an admitted Job.</Heading>
    <Card title="Execution policy"><ErrorNotice error={viewError(data.policy)}/>{data.policy.data&&<><p><Badge>{data.policy.data.state}</Badge> · Literal argv, named working roots and bounded output.</p>
      <dl><dt>Executable aliases</dt><dd>{data.policy.data.executables.join(", ")||"None configured"}</dd><dt>Working roots</dt><dd>{data.policy.data.roots.join(", ")||"None configured"}</dd><dt>Shell</dt><dd>{data.policy.data.shellAllowed?"Separately authorized":"Not configured"}</dd></dl>
      <p className="field-note">An allowed executable is not a filesystem sandbox. External effects cannot be rolled back by cancellation. Policy changes require a new service acquisition before new work.</p></>}</Card>
    {data.policy.data&&<JobComposer policy={data.policy.data}/>}
    <Card title="Retained Jobs"><div className="actions"><button onClick={()=>router.invalidate()}>Refresh Jobs</button></div>{data.list&&<ErrorNotice error={viewError(data.list)}/>}
      {data.list?.data&&(!data.list.data.jobs.length?<Empty>No Jobs retained for this principal.</Empty>:<><div className="table-wrap"><table><thead><tr><th>Job</th><th>State</th><th>Command</th><th>Created</th></tr></thead><tbody>{data.list.data.jobs.map(j=><tr key={j.jobRef}><td><Link to="/jobs" search={{...search,selected:j.jobRef}}><code>{j.requestId}</code></Link></td><td><Badge tone={j.state==="unknown"?"warn":"neutral"}>{j.state}</Badge></td><td>{j.command.executable} · {j.command.argumentCount} arguments</td><td><SourceTime at={j.createdAt}/></td></tr>)}</tbody></table></div>
        {data.list.data.nextCursor&&<Link to="/jobs" search={{...search,cursor:data.list.data.nextCursor}}>Next Jobs →</Link>}</>)}
    </Card>
    {data.selected&&<ErrorNotice error={viewError(data.selected)}/>}{data.selected?.data&&<JobDetails key={data.selected.data.jobRef} job={data.selected.data}/>}
  </>;
}
function JobComposer({policy}:{policy:JobPolicyView}){
  const {services,bootstrap}=useConsole(),router=useRouter(),busy=useRef(false),scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId};
  const [body,setBody]=useState(()=>JSON.stringify({argv:["node","-e","process.stdout.write('Hello')"],runTimeoutMs:5000},null,2));
  const [expected,setExpected]=useState(policy.revision),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<unknown>();
  const [ready,setReady]=useState(false),[unresolved,setUnresolved]=useState<LocalOperation>(),[locator,setLocator]=useState<LocalOperation>(),[result,setResult]=useState<JobView>();
  const canStart=bootstrap.session!.capabilities.includes("jobs.start"),canRead=bootstrap.session!.capabilities.includes("operations.read");
  const sync=()=>{const rows=localOperations(localStorage,scope);setUnresolved(rows.find(r=>r.command==="job-start"&&["unknown","awaiting-response"].includes(r.state)));setReady(true);return rows;};
  useEffect(()=>{const read=()=>{try{sync();}catch(e){setError(e);setReady(false);}};read();window.addEventListener("storage",read);return()=>window.removeEventListener("storage",read);},[scope.installationId,scope.principalId]);
  async function review(){if(busy.current)return;busy.current=true;setPending(true);setError(undefined);try{const current=(await services.client(bootstrap.binding).jobPolicy()).data;if(current.state!=="ready")throw new ManagementClientError("source_unavailable","Job policy is not ready.");setExpected(current.revision);setConfirmed(false);await router.invalidate();}catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function recover(){if(!unresolved||busy.current)return;busy.current=true;setPending(true);setError(undefined);try{const j=(await services.client(bootstrap.binding).jobOperation(unresolved.requestId)).data;markOperation(localStorage,unresolved,jobLocalState(j.state));setLocator(unresolved);setResult(j);sync();await router.invalidate();}catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function submit(e:FormEvent){
    e.preventDefault();if(!ready||busy.current||!confirmed||!canStart||policy.state!=="ready")return;
    busy.current=true;setPending(true);setError(undefined);let row:LocalOperation|undefined;
    try{
      if(sync().some(r=>r.command==="job-start"&&["unknown","awaiting-response"].includes(r.state)))return;
      const raw=JSON.parse(body);if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).some(k=>!["argv","environment","cwd","runTimeoutMs","output","shell"].includes(k)))throw new ManagementClientError("invalid_input","Declare only Job input fields; policy and request identity come from this reviewed action.");
      const r=normalizeJobStart({...raw,requestId:crypto.randomUUID(),expectedRevision:expected,confirmed:true}),api=await services.prepareWrite(bootstrap.binding,scope.principalId);
      row=rememberOperation(localStorage,scope,r);setLocator(row);sync();const j=(await api.startJob(r)).data;setResult(j);markOperation(localStorage,row,jobLocalState(j.state));setConfirmed(false);sync();await router.invalidate();
    }catch(failure){if(row){markOperation(localStorage,row,failure instanceof ManagementClientError&&failure.reply&&failure.code!=="operation_unknown"?"refused":"unknown");sync();}setError(failure);}
    finally{busy.current=false;setPending(false);}
  }
  return <Card title="Start a Job"><div data-testid="job-composer"><ErrorNotice error={error}/><p className="field-note">Review this service policy, declare literal arguments, then confirm OS execution. No shell is inferred from punctuation.</p>
    <button onClick={review} disabled={pending}>Review current Job policy</button><p className="revision"><code>{expected??"No reviewed policy"}</code></p>
    {unresolved&&<div className="notice" role="status"><strong>Original Job needs recovery</strong><p>Only its identity was saved. Refreshing does not resubmit the command.</p><button onClick={recover} disabled={pending||!canRead}>Recover original Job</button><Link to="/operations" search={operationSearch(unresolved)}>Inspect original Job request</Link></div>}
    <form onSubmit={submit}><fieldset disabled={!ready||pending||!canStart||!!unresolved||policy.state!=="ready"}><label htmlFor="job-input">Job input (JSON)</label><textarea id="job-input" rows={7} value={body} onChange={e=>setBody(e.target.value)} maxLength={40000} spellCheck={false}/>
      <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I authorize this OS Job and its external effects.</label><button type="submit" className="primary" disabled={!confirmed||!expected}>Start Job</button></fieldset></form>
    {result&&<div className="notice" data-testid="job-submission"><strong>Original Job recorded</strong><p>{result.state}. A recorded admission is not successful execution.</p><Link to="/jobs" search={{selected:result.jobRef}}>Inspect Job</Link></div>}
    {locator&&<Link to="/operations" search={operationSearch(locator)}>View Job request receipt</Link>}</div></Card>;
}
function JobDetails({job}:{job:JobView}){
  const {services,bootstrap}=useConsole(),router=useRouter(),busy=useRef(false),scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId};
  const [logs,setLogs]=useState<JobLogPage>(),[cancel,setCancel]=useState<JobCancelReceipt>(),[error,setError]=useState<unknown>(),[pending,setPending]=useState(false),[confirmed,setConfirmed]=useState(false),[original,setOriginal]=useState<LocalOperation>();
  const caps=bootstrap.session!.capabilities;
  useEffect(()=>{try{setOriginal(localOperations(localStorage,scope).find(r=>r.command==="job-cancel"&&r.target===job.jobRef));}catch(e){setError(e);}},[job.jobRef,scope.installationId,scope.principalId]);
  async function output(){if(busy.current)return;busy.current=true;setPending(true);try{setLogs((await services.client(bootstrap.binding).jobLogs(job.jobRef,{offset:logs&&!logs.complete?logs.nextOffset:0})).data);setError(undefined);}catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function change(recovery:boolean){
    if(busy.current||!recovery&&!confirmed)return;busy.current=true;setPending(true);setError(undefined);let row=original;let observed:JobCancelReceipt|undefined;
    try{
      const api=recovery?services.client(bootstrap.binding):await services.prepareWrite(bootstrap.binding,scope.principalId);
      if(!recovery){const prior=localOperations(localStorage,scope).find(r=>r.command==="job-cancel"&&r.target===job.jobRef);if(prior){setOriginal(prior);return;}const r={jobRef:job.jobRef,requestId:crypto.randomUUID(),confirmed:true as const};row=rememberOperation(localStorage,scope,r);setOriginal(row);observed=(await api.cancelJob(r)).data;setCancel(observed);}
      else if(row){observed=(await api.jobCancellation(job.jobRef,row.requestId)).data;setCancel(observed);}
      if(row&&observed)markOperation(localStorage,row,observed.state==="unknown"?"unknown":"recorded");setConfirmed(false);await router.invalidate();
    }catch(failure){if(row)markOperation(localStorage,row,failure instanceof ManagementClientError&&failure.reply&&failure.code!=="operation_unknown"?"refused":"unknown");setError(failure);}finally{busy.current=false;setPending(false);}
  }
  return <Card title="Job observation"><div data-testid="job-detail"><Badge tone={job.state==="unknown"?"warn":"neutral"}>{job.state}</Badge><p className="revision"><code>{job.jobRef}</code></p><dl><dt>Observed by</dt><dd>{job.observation}</dd><dt>Exit</dt><dd>{job.exitCode??job.signal??"Not observed"}</dd><dt>Reason</dt><dd>{job.reason??"None recorded"}</dd><dt>Output</dt><dd>{job.logs.bytes} bytes · {job.logs.truncated?"truncated":"not truncated"}</dd></dl>
    <ErrorNotice error={error}/><div className="actions"><button onClick={()=>router.invalidate()}>Refresh Job observation</button><button onClick={output} disabled={pending||!caps.includes("jobs.logs.read")}>{logs&&!logs.complete?"Next output page":"Read Job output"}</button></div>
    {logs&&<pre data-testid="job-output">{logs.events.map(e=>{try{return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(atob(e.contentBase64),c=>c.charCodeAt(0)));}catch{return `[${e.stream} binary base64: ${e.contentBase64}]`;}}).join("")}</pre>}
    <p className="field-note">Output is untrusted data. Cancellation addresses only an owned process group and does not reverse files, network requests or other external effects.</p>
    {original?<><button onClick={()=>change(true)} disabled={pending||!caps.includes("operations.read")}>Recover original cancellation</button><Link to="/operations" search={operationSearch(original)}>View cancellation receipt</Link></>:<><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={pending||!caps.includes("jobs.cancel")||!["queued","running"].includes(job.state)||job.observation!=="current-service"}/>I authorize cancellation of this Job.</label><button onClick={()=>change(false)} disabled={pending||!confirmed||!caps.includes("jobs.cancel")||!["queued","running"].includes(job.state)}>Cancel Job</button></>}
    {cancel&&<p data-testid="job-cancellation">{cancel.state}: target {cancel.job.state}; external effects are not reverted.</p>}
  </div></Card>;
}
