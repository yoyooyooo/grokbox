import { useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, type SetupRequest, type SetupOperation, type PublicRoutine } from "@grokbox/client";
import { localOperations, rememberOperation, markOperation, operationSearch, type LocalOperation } from "../lib/operations.ts";
import { Card, ErrorNotice, useConsole } from "./ui.tsx";

export function useSetupAction() {
  const {bootstrap,services}=useConsole(),router=useRouter(),busy=useRef(false);
  const scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId};
  const [ready,setReady]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<unknown>();
  const [unsettled,setUnsettled]=useState<LocalOperation[]>([]),[receipt,setReceipt]=useState<SetupOperation>(),[locator,setLocator]=useState<LocalOperation>();
  function readLocal(){try{setUnsettled(localOperations(localStorage,scope).filter(r=>r.setupKind && ["unknown","awaiting-response"].includes(r.state)));setReady(true);}catch(f){setError(f);setReady(false);}}
  useEffect(()=>{readLocal();window.addEventListener("storage",readLocal);return()=>window.removeEventListener("storage",readLocal);},[scope.installationId,scope.principalId]);
  async function submit(request:SetupRequest):Promise<SetupOperation|undefined>{
    if(busy.current||!ready)return;
    busy.current=true;setPending(true);setError(undefined);setReceipt(undefined);let row:LocalOperation|undefined;
    try{
      if(localOperations(localStorage,scope).some(r=>r.setupKind && ["unknown","awaiting-response"].includes(r.state)))throw new ManagementClientError("operation_unknown","Resolve the retained setup operation before creating another setup request.");
      const api=await services.prepareWrite(bootstrap.binding,scope.principalId);
      row=rememberOperation(localStorage,scope,request);setLocator(row);readLocal();
      const result=(await api.changeSetup(request)).data;markOperation(localStorage,row,result.state);setReceipt(result);await router.invalidate();return result;
    }catch(f){if(row)markOperation(localStorage,row,f instanceof ManagementClientError && f.reply && f.code!=="operation_unknown"?"refused":"unknown");setError(f);}
    finally{readLocal();busy.current=false;setPending(false);}
  }
  async function recover(row:LocalOperation,selected?:PublicRoutine){
    if(busy.current||!row.setupKind||!row.setupScope)return;
    busy.current=true;setPending(true);setError(undefined);
    try{
      const api=selected?await services.prepareWrite(bootstrap.binding,scope.principalId):services.client(bootstrap.binding);
      const result=selected?(await api.changeSetup({action:"reconcile",routineRef:selected.routineRef,expectedRevision:selected.revision,requestId:row.requestId,confirmed:true})).data
        :(await api.setupOperation(row.setupKind,row.setupScope,row.requestId)).data;
      markOperation(localStorage,row,result.state);setReceipt(result);setLocator(row);await router.invalidate();
    }catch(f){setError(f);}finally{readLocal();busy.current=false;setPending(false);}
  }
  return {ready,pending,error,unsettled,receipt,locator,submit,recover,blocked:!ready||pending||unsettled.length>0};
}
export function SetupFeedback({action,selected}:{action:ReturnType<typeof useSetupAction>;selected?:PublicRoutine}){
  const {bootstrap}=useConsole();
  return <><ErrorNotice error={action.error}/>{action.unsettled.length>0 && <Card title="Unresolved setup"><p>A retained request has an uncertain result. Refreshing does not create permission to repeat it.</p>
    {action.unsettled.map(row=><div key={row.requestId} className="notice"><code>{row.requestId}</code><p>{row.command} · {row.target}</p><div className="actions"><button disabled={action.pending} onClick={()=>action.recover(row)}>Query original setup operation</button>
      <Link to="/operations" search={operationSearch(row)}>Open recovery record</Link>
      {row.command==="setup-apply" && selected && selected.botRef.endsWith(`:${row.setupScope}`) && !selected.enabled && bootstrap.session!.capabilities.includes("routines.write") && <button disabled={action.pending} onClick={()=>action.recover(row,selected)}>Reconcile selected disabled Routine</button>}</div></div>)}</Card>}
    {action.receipt && <div className="notice" role="status" data-testid="setup-result"><strong>Setup result: {action.receipt.state}</strong><p>{action.receipt.evidence}</p>{action.receipt.resultRef && <code>{action.receipt.resultRef}</code>}<p>No automatic permission was granted and no webhook was invoked by this setup action.</p></div>}
    {action.locator && <p><Link to="/operations" search={operationSearch(action.locator)}>View setup receipt</Link></p>}</>;
}
