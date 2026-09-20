import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type NotificationSettingsView, type ReceiverList, type NotificationList, type RoutineList, type RoutineBlueprint } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, useConsole } from "../components/ui.tsx";
import { SetupFeedback, useSetupAction } from "../components/setup-action.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route=createFileRoute("/_console/notification-setup")({
  validateSearch:(search:Record<string,unknown>):{routine?:string}=>({routine:boundedSearch(search.routine,240)}),
  loaderDeps:({search})=>search,
  loader:async({context})=>{
    const api=context.services.client(context.bootstrap.binding),caps=context.bootstrap.session!.capabilities;
    const settings=caps.includes("notifications.read")?await readView(api.notificationSettings()):denied<NotificationSettingsView>();
    const target=settings.data?.targets.find(row=>row.alias===settings.data!.selectedAlias);
    const [receivers,database,routines,blueprint]=await Promise.all([
      caps.includes("notifications.read")?readView(api.receivers()):Promise.resolve(denied<ReceiverList>()),
      caps.includes("notifications.read")?readView(api.notifications({limit:1})):Promise.resolve(denied<NotificationList>()),
      target?.botRef?(caps.includes("routines.read")?readView(api.routines(target.botRef)):Promise.resolve(denied<RoutineList>())):Promise.resolve(null),
      target?.routineKey&&target?.botRef?readView(api.notificationBlueprint(target.alias)):Promise.resolve(null),
    ]);
    return {settings,receivers,database,routines,blueprint,target};
  },component:Setup,
});
function SettingsForm({view,action}:{view:NotificationSettingsView;action:ReturnType<typeof useSetupAction>}){
  const {bootstrap,services}=useConsole(),router=useRouter(),target=view.targets.find(t=>t.alias===view.selectedAlias);
  const [alias,setAlias]=useState(view.selectedAlias),[bot,setBot]=useState(target?.botRef??""),[key,setKey]=useState(target?.routineKey??"ops-notice");
  const [mode,setMode]=useState(view.mode),[budget,setBudget]=useState(String(view.installationBudget)),[targetBudget,setTargetBudget]=useState(String(target?.targetBudget??view.installationBudget));
  const [expected,setExpected]=useState(view.revision),[confirm,setConfirm]=useState(false),[error,setError]=useState<unknown>();
  const writable=bootstrap.session!.capabilities.includes("notifications.write");
  async function submit(event:FormEvent){event.preventDefault();if(!confirm)return;const result=await action.submit({action:"settings",requestId:crypto.randomUUID(),confirmed:true,expectedRevision:expected,
    settings:{alias,botRef:bot,routineKey:key,mode,installationBudget:Number(budget),targetBudget:Number(targetBudget)}});if(result?.state==="succeeded")setExpected(String(result.revision));}
  async function refresh(){try{const result=(await services.client(bootstrap.binding).notificationSettings()).data;setExpected(result.revision);await router.invalidate();setError(undefined);}catch(f){setError(f);}}
  return <Card title="1 · Target and budgets"><ErrorNotice error={error}/><form onSubmit={submit}><fieldset disabled={!writable||action.blocked}>
    <label htmlFor="setup-alias">Receiver alias</label><input id="setup-alias" value={alias} onChange={e=>setAlias(e.target.value)} required maxLength={32}/>
    <label htmlFor="setup-bot">Bot UUID or scoped reference</label><input id="setup-bot" value={bot} onChange={e=>setBot(e.target.value)} required maxLength={80} spellCheck={false}/>
    <label htmlFor="setup-key">Managed Routine key</label><input id="setup-key" value={key} onChange={e=>setKey(e.target.value)} required maxLength={64}/>
    <label htmlFor="setup-mode">Notification policy</label><select id="setup-mode" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="actionable-user">Allow explicitly authorized notifications</option><option value="off">Off</option></select>
    <label htmlFor="setup-budget">Installation daily wake limit</label><input id="setup-budget" type="number" min={0} max={1000} value={budget} onChange={e=>setBudget(e.target.value)} required/>
    <label htmlFor="setup-target-budget">Target daily wake limit</label><input id="setup-target-budget" type="number" min={0} max={1000} value={targetBudget} onChange={e=>setTargetBudget(e.target.value)} required/>
    <label><input id="setup-settings-consent" type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>I confirm this target and budget configuration. Automatic delivery still needs its separate receiver permission.</label>
    <button className="primary" type="submit" disabled={!confirm}>Save notification settings</button>
  </fieldset></form><p className="revision">Draft revision <code>{expected}</code></p><button disabled={action.pending} onClick={refresh}>Read latest settings revision, keep draft</button>
    {(!view.opsEnabled||view.advancedRouting) && <p className="notice">Additional system policy is blocking or enabling advanced routing. This form preserves those settings instead of silently overriding them.</p>}
    <p className="field-note">No native call, key request or notification is made by saving these settings. Other targets and system settings are preserved.</p></Card>;
}
function Setup(){
  const data=Route.useLoaderData(),search=Route.useSearch(),navigate=useNavigate({from:Route.fullPath}),router=useRouter(),{bootstrap}=useConsole(),action=useSetupAction();
  const [routineConsent,setRoutineConsent]=useState(false),[bindingConsent,setBindingConsent]=useState(false);
  const selected=data.routines?.data?.routines.find(r=>r.routineRef===search.routine),binding=data.receivers.data?.receivers.find(r=>r.alias===data.target?.alias);
  const canRoutine=bootstrap.session!.capabilities.includes("routines.write"),canBind=bootstrap.session!.capabilities.includes("notifications.bind");
  async function create(){if(!data.blueprint?.data||!data.target?.botRef||!routineConsent)return;
    const result=await action.submit({action:"apply",blueprint:data.blueprint.data,botRef:data.target.botRef,expectedRevision:null,confirmed:true,requestId:crypto.randomUUID()});
    if(result?.resultRef)void navigate({search:{routine:result.resultRef}});}
  async function change(kind:"enable"|"disable"|"delete"){if(!selected||!routineConsent)return;await action.submit({action:kind,routineRef:selected.routineRef,expectedRevision:selected.revision,confirmed:true,requestId:crypto.randomUUID()});}
  async function bind(){if(!selected||!data.target||!data.database.data||!bindingConsent)return;await action.submit({action:"bind",routineRef:selected.routineRef,expectedRevision:selected.revision,alias:data.target.alias,
    databaseId:data.database.data.databaseId,expectedBindingRevision:binding?.revision??0,confirmed:true,requestId:crypto.randomUUID()});}
  return <><Heading eyebrow="EXPLICIT FIRST SETUP" title="Notification setup">Configure a target, prepare a disabled Routine, store its private binding, then enable the native Routine. Automatic permission and optional testing stay separate.</Heading>
    <p><Link to="/notifications" search={{}}>← Notification management</Link></p><SetupFeedback action={action} selected={selected}/><ErrorNotice error={viewError(data.settings)}/>
    {data.settings.data&&<SettingsForm view={data.settings.data} action={action}/>}
    <Card title="2 · Native Routine"><p className="field-note">Only the configured Bot is queried. Native definitions remain authoritative; returned-window absence is not proof of global deletion.</p>
      {data.routines&&<ErrorNotice error={viewError(data.routines)}/>} {data.blueprint&&<ErrorNotice error={viewError(data.blueprint)}/>}
      {!data.target?.botRef?<Empty>Save a configured Bot first.</Empty>:<>
        <p><code>{data.target.botRef}</code></p><label htmlFor="setup-routine">Exact native Routine</label><select id="setup-routine" value={selected?.routineRef??""} onChange={e=>void navigate({search:{routine:e.target.value||undefined}})}>
          <option value="">Select a returned Routine</option>{data.routines?.data?.routines.map(r=><option key={r.id} value={r.routineRef}>{r.name} · {r.id} · {r.enabled?"enabled":"disabled"}</option>)}</select>
        <label><input id="setup-routine-consent" type="checkbox" checked={routineConsent} onChange={e=>setRoutineConsent(e.target.checked)}/>I confirm the native definition change. Enabling a native schedule can allow future native runs.</label>
        <div className="actions"><button disabled={!canRoutine||action.blocked||!routineConsent||!data.blueprint?.data} onClick={create}>Create disabled reminder Routine</button>
          <button disabled={!canRoutine||action.blocked||!routineConsent||!selected||selected.enabled||!selected.mutable} onClick={()=>change("enable")}>Enable selected native Routine</button>
          <button disabled={!canRoutine||action.blocked||!routineConsent||!selected||!selected.enabled||!selected.mutable} onClick={()=>change("disable")}>Disable selected native Routine</button>
          <button className="danger-button" disabled={!canRoutine||action.blocked||!routineConsent||!selected||!selected.mutable} onClick={()=>change("delete")}>Delete selected native Routine</button></div>
        {selected&&<p className="revision"><Badge>{selected.enabled?"enabled":"disabled"}</Badge> <code>{selected.routineRef}</code><br/>Revision <code>{selected.revision}</code></p>}
        <button disabled={action.pending} onClick={()=>router.invalidate()}>Refresh native definitions</button>
        {data.blueprint?.data&&<details><summary>Fixed reminder definition</summary><pre>{JSON.stringify(data.blueprint.data,null,2)}</pre></details>}
      </>}
    </Card>
    <Card title="3 · Private pairing"><ErrorNotice error={viewError(data.receivers)}/><ErrorNotice error={viewError(data.database)}/>
      <p>Pair a disabled, managed Routine. The native key is stored inside the private owner and never returned to this page. Pairing does not enable a Routine or authorize delivery.</p>
      <label><input id="setup-binding-consent" type="checkbox" checked={bindingConsent} onChange={e=>setBindingConsent(e.target.checked)}/>I authorize one native credential request for this exact target and private local storage.</label>
      <div className="actions"><button disabled={!canBind||action.blocked||!bindingConsent||!selected||selected.enabled||!data.database.data||!data.target||!!binding&&binding.state!=="unbound"} onClick={bind}>Bind selected disabled Routine</button>
      {binding&&<Link to="/notifications" search={{selected:binding.receiverRef}}>Continue to receiver permission and optional test →</Link>}</div>
      {binding&&<p>Binding <Badge>{binding.state}</Badge> · revision {binding.revision}<br/><code>{binding.receiverRef}</code></p>}
      {selected?.enabled&&!binding&&<p className="notice">The selected Routine is enabled. Disable it explicitly before first pairing; this page will not do so automatically.</p>}
      <p className="field-note">Once paired, explicitly enable the native Routine above. Then verify and enable the receiver on the notification page. A test is optional, never an activation prerequisite.</p>
    </Card></>;
}
