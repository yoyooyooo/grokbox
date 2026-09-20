import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, type MaterialRead, type MaterialOperation } from "@grokbox/client";
import { localOperations, rememberOperation, markOperation, operationSearch, type LocalOperation } from "../lib/operations.ts";
import { Badge, Card, ErrorNotice, SourceTime, useConsole } from "./ui.tsx";
export function MaterialEditor({ value }: { value: MaterialRead }) {
  const { bootstrap, services } = useConsole(), router = useRouter(), busy = useRef(false);
  const scope = { installationId:bootstrap.binding.installationId, principalId:bootstrap.session!.principalId }, doc = value.document;
  const [draft,setDraft] = useState(value.content), [revision,setRevision] = useState(doc.revision), [confirmed,setConfirmed] = useState(false);
  const [ready,setReady] = useState(false), [pending,setPending] = useState(false), [error,setError] = useState<unknown>();
  const [unsettled,setUnsettled] = useState<LocalOperation>(), [locator,setLocator] = useState<LocalOperation>(), [receipt,setReceipt] = useState<MaterialOperation>();
  const writable = doc.writable && bootstrap.session!.capabilities.includes("materials.write");
  const unresolved = () => localOperations(localStorage,scope).find(row => row.command === "material-write" && row.target === doc.ref && ["unknown","awaiting-response"].includes(row.state));
  useEffect(() => {
    const check = () => { try { setUnsettled(unresolved());setReady(true); } catch (e) { setError(e);setReady(false); } };
    check();window.addEventListener("storage",check);return () => window.removeEventListener("storage",check);
  },[doc.ref,scope.installationId,scope.principalId]);
  async function refresh() {
    if (busy.current) return;
    try { const current = (await services.client(bootstrap.binding).readMaterial(doc.ref)).data;setRevision(current.document.revision);await router.invalidate(); }
    catch(e){setError(e);}
  }
  async function recover() {
    if (!unsettled || busy.current) return;busy.current=true;setPending(true);setError(undefined);
    try { const result = (await services.client(bootstrap.binding).materialOperation(unsettled.requestId)).data;
      markOperation(localStorage,unsettled,result.state);setReceipt(result);setLocator(unsettled);setUnsettled(unresolved());await router.invalidate(); }
    catch(e){setError(e);}finally{busy.current=false;setPending(false);}
  }
  async function submit(event:FormEvent) {
    event.preventDefault();if(busy.current||!ready||!writable||unsettled||!confirmed)return;
    busy.current=true;setPending(true);setError(undefined);setReceipt(undefined);let row:LocalOperation|undefined;
    try {
      const existing=unresolved();if(existing){setUnsettled(existing);return;}
      const request={ref:doc.ref,requestId:crypto.randomUUID(),expectedRevision:revision,content:draft,confirmed:true as const};
      const api=await services.prepareWrite(bootstrap.binding,scope.principalId);
      row=rememberOperation(localStorage,scope,request);setLocator(row);setUnsettled(row);
      const result=(await api.changeMaterial(request)).data;markOperation(localStorage,row,result.state);setReceipt(result);setUnsettled(unresolved());
      if(result.state==="succeeded"&&result.afterRevision)setRevision(result.afterRevision);setConfirmed(false);void router.invalidate();
    }catch(e){
      if(row){const refused=e instanceof ManagementClientError&&!!e.reply&&e.code!=="operation_unknown";markOperation(localStorage,row,refused?"refused":"unknown");if(refused)setUnsettled(undefined);}
      setError(e);
    }finally{busy.current=false;setPending(false);}
  }
  return <Card title="Source document"><div data-testid="material-editor"><p><code>{doc.path}</code> <Badge>{doc.scope}</Badge></p>
    <p className="field-note">Read directly at <SourceTime at={value.observedAtMs}/> · Index {value.indexState}. File time is not authorship or proof of use in a TURN.</p>
    {value.contentProjection === "authorized-membership" && <p className="notice">This is an authorized membership projection. Projects outside the configured scope are not included in the returned text.</p>}
    <ErrorNotice error={error}/>
    {unsettled&&<div className="notice" role="status"><p>An earlier source write is unresolved. Recover its original receipt before another write.</p><code>{unsettled.requestId}</code><div className="actions"><button onClick={recover} disabled={pending}>Recover source write</button><Link to="/operations" search={operationSearch(unsettled)}>Open source operation</Link></div></div>}
    {writable?<form onSubmit={submit}><fieldset disabled={pending||!ready||!!unsettled}><legend>Edit existing text</legend><label htmlFor="material-text">Document text</label>
      <textarea id="material-text" value={draft} onChange={e=>setDraft(e.target.value)} rows={12} spellCheck={false}/>
      <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I confirm replacing this existing source text.</label>
      <button className="primary" type="submit" disabled={!confirmed}>Save source text</button></fieldset></form>
      :<><pre data-testid="material-body">{value.content}</pre><p className="field-note">{doc.kind==="file"?"This source or session is read-only.":"Native Memory and Project replicas are read-only. Changes require a supported native owner, not direct shard editing."}</p></>}
    {writable&&<div className="actions"><button onClick={refresh} disabled={pending}>Read latest revision, keep draft</button></div>}
    <details><summary>Source identity and revision</summary><code>{doc.ref}</code><p>Draft revision <code>{revision}</code></p><p>Current source revision <code>{doc.revision}</code></p></details>
    {receipt&&<div className="notice" data-testid="material-write-receipt"><strong>{receipt.state==="succeeded"?"Source write verified":"Source write is not verified"}</strong><p>{receipt.evidence}. Index refresh and source publication are separate results.</p></div>}
    {locator&&<Link to="/operations" search={operationSearch(locator)}>View source receipt</Link>}
  </div></Card>;
}
