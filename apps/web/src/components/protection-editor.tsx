import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, normalizeProtectionChange, type ProtectionBotView, type ProtectionOverview, type ProtectionOperation, type ProtectionChangeRequest, type BotProtection } from "@grokbox/client";
import { localOperations, rememberOperation, markOperation, operationSearch, type LocalOperation } from "../lib/operations.ts";
import { Card, ErrorNotice, useConsole } from "./ui.tsx";

export function ProtectionEditor({view}:{view:ProtectionBotView|ProtectionOverview}) {
  const {services,bootstrap}=useConsole(),router=useRouter(),scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId};
  const bot="botRef" in view?view.botRef:null,target=bot??`protection-system:${scope.installationId}`,apiTarget=bot??"system";
  const initial="policy" in view?view.policy:view.defaultPolicy;
  const [draft,setDraft]=useState<BotProtection>(()=>structuredClone(initial)),[enabled,setEnabled]=useState(view.enabled),[reset,setReset]=useState(false);
  const [expected,setExpected]=useState(view.revision),[consent,setConsent]=useState(false),[ready,setReady]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<unknown>();
  const [unsettled,setUnsettled]=useState<LocalOperation>(),[locator,setLocator]=useState<LocalOperation>(),[receipt,setReceipt]=useState<ProtectionOperation>();
  const busy=useRef(false),writable=bootstrap.session!.capabilities.includes("protection.write");
  const outstanding=()=>localOperations(localStorage,scope).find(row=>row.command==="protection-policy"&&row.target===target&&["awaiting-response","unknown"].includes(row.state));
  useEffect(()=>{
    const read=()=>{try{setUnsettled(outstanding());setReady(true);}catch(e){setError(e);setReady(false);}};
    read();window.addEventListener("storage",read);return()=>window.removeEventListener("storage",read);
  },[target,scope.principalId]);
  async function refresh(){
    if(busy.current)return;
    try{const client=services.client(bootstrap.binding),fresh=bot?await client.botProtection(bot):await client.protection();setExpected(fresh.data.revision);await router.invalidate();}
    catch(e){setError(e);}
  }
  async function recover(){
    if(!unsettled||busy.current)return;busy.current=true;setPending(true);setError(undefined);
    try{const result=(await services.client(bootstrap.binding).protectionOperation(apiTarget,unsettled.requestId)).data;
      markOperation(localStorage,unsettled,result.state);setReceipt(result);setLocator(unsettled);setUnsettled(outstanding());await router.invalidate();}
    catch(e){setError(e);}finally{busy.current=false;setPending(false);}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(!ready||busy.current||unsettled||!writable||!consent)return;
    busy.current=true;setPending(true);setError(undefined);setReceipt(undefined);let row:LocalOperation|undefined;
    try{
      const current=outstanding();if(current){setUnsettled(current);return;}
      const common={requestId:crypto.randomUUID(),expectedRevision:expected,confirmed:true as const};
      const input:ProtectionChangeRequest=bot?reset?{...common,action:"reset",botRef:bot}:{...common,action:"set",botRef:bot,patch:draft}:{...common,action:"system",enabled};
      const request=normalizeProtectionChange(input,scope.installationId),client=await services.prepareWrite(bootstrap.binding,scope.principalId);
      row=rememberOperation(localStorage,scope,request);setLocator(row);setUnsettled(row);
      const result=(await client.changeProtection(request)).data;markOperation(localStorage,row,result.state);setReceipt(result);
      if(result.state==="succeeded"){setUnsettled(undefined);setExpected(result.revision!);setConsent(false);}await router.invalidate();
    }catch(e){
      if(row){const refused=e instanceof ManagementClientError&&!!e.reply&&e.code!=="operation_unknown";markOperation(localStorage,row,refused?"refused":"unknown");if(refused)setUnsettled(undefined);}
      setError(e);
    }finally{busy.current=false;setPending(false);}
  }
  const patch=<K extends keyof BotProtection>(key:K,value:BotProtection[K])=>setDraft(old=>({...old,[key]:value}));
  const stem=bot?"bot-protection":"system-protection";
  return <Card title={bot?"Bot protection policy":"Installation protection"}><div data-testid={stem}><ErrorNotice error={error}/>
    <p className="field-note">{bot?"This override belongs to the original Bot reference. A successor is shown separately; this page never silently retargets an action.":"Default protection discovers freshly confirmed Box-owned Bots. Explicitly turning it off stops future background protection, not existing native tasks."}</p>
    {unsettled&&<div className="notice" role="status"><p>An earlier policy change is unresolved. Recover that request before submitting another change.</p><code>{unsettled.requestId}</code><button onClick={recover} disabled={pending}>Recover protection change</button></div>}
    <form onSubmit={submit}><fieldset disabled={!writable||pending||!ready||!!unsettled}>
      <legend>{bot?"Explicit policy override":"Background policy"}</legend>
      {bot?<><label><input type="checkbox" checked={reset} onChange={e=>setReset(e.target.checked)}/>Remove this override and return to defaults</label>
        {!reset&&<>
          <label><input type="checkbox" checked={draft.enabled} onChange={e=>patch("enabled",e.target.checked)}/>Protect this Bot</label>
          <label htmlFor="protection-mode">On confirmed ownership loss</label><select id="protection-mode" value={draft.mode} onChange={e=>patch("mode",e.target.value as BotProtection["mode"])}><option value="alert">Record and notify only</option><option value="prepare">Prepare a successor, do not activate</option><option value="auto-replace">Prepare and activate a successor</option></select>
          <label htmlFor="protection-tier">Recovery material</label><select id="protection-tier" value={draft.tier} onChange={e=>patch("tier",e.target.value as BotProtection["tier"])}><option value="observe">Observation only</option><option value="memory">Memory supplement</option><option value="resume">Best available resume material</option><option value="archive">Retained recovery archive</option></select>
          <label><input type="checkbox" checked={draft.pauseOnOwnershipLoss} onChange={e=>patch("pauseOnOwnershipLoss",e.target.checked)}/>Pause eligible Routines on confirmed loss</label>
          <details><summary>Capture and replacement limits</summary>
            <label htmlFor="protection-capture">Capture interval in milliseconds</label><input id="protection-capture" type="number" min={10000} max={86400000} value={draft.captureIntervalMs} onChange={e=>patch("captureIntervalMs",Number(e.target.value))}/>
            <label htmlFor="protection-budget">Maximum replacements per day</label><input id="protection-budget" type="number" min={0} max={16} value={draft.maxReplacementsPerDay} onChange={e=>patch("maxReplacementsPerDay",Number(e.target.value))}/>
            <label htmlFor="protection-cooldown">Replacement cooldown in milliseconds</label><input id="protection-cooldown" type="number" min={60000} max={86400000} value={draft.cooldownMs} onChange={e=>patch("cooldownMs",Number(e.target.value))}/>
            <p className="field-note">Existing handover policy is preserved. Native usability, transferred duties and safe retirement need separate evidence.</p>
          </details>
        </>}
      </>:<label><input id="system-protection-enabled" type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Enable default background protection</label>}
      <label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I confirm this protection policy change and its permitted future native effects.</label>
      <button className="primary" type="submit" disabled={!consent}>{pending?"Saving…":bot?"Save Bot protection":"Save installation protection"}</button>
    </fieldset></form>
    <p className="field-note">Draft configuration revision <code>{expected}</code></p><button disabled={pending} onClick={refresh}>Read latest protection revision, keep draft</button>
    {!writable&&<p className="field-note">This principal can read protection but cannot change its policy.</p>}
    {receipt&&<div className="notice" role="status"><strong>{receipt.state==="succeeded"?"Protection policy recorded":"Protection outcome remains unknown"}</strong><p>The configuration receipt does not prove background adoption or a native effect. Disabling or resetting does not erase stored recovery material.</p></div>}
    {locator&&<Link to="/operations" search={operationSearch(locator)}>View protection operation receipt</Link>}
  </div></Card>;
}
