import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, fileIdentity, fileReference, normalizeFileChange, FILE_UUID, type FileChange, type FileEntry, type FileOperation, type FileRead, type FileRootsView } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, useConsole } from "../components/ui.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";
import { localOperations, rememberOperation, retainFileOperation, markOperation, fileLocalState, operationSearch, type LocalOperation } from "../lib/operations.ts";
import { browserFileDigest, publishBrowserFile, downloadBrowserFile } from "../lib/file-transfers.ts";

export const Route = createFileRoute("/_console/files")({
  validateSearch: (s:Record<string,unknown>):{directory?:string;selected?:string;cursor?:string;requestId?:string}=>({
    directory:boundedSearch(s.directory,1800),selected:boundedSearch(s.selected,1800),cursor:boundedSearch(s.cursor,160),
    requestId:typeof s.requestId==="string"&&FILE_UUID.test(s.requestId)?s.requestId.toLowerCase():undefined,
  }),
  loaderDeps:({search})=>search,
  loader:async({context,deps})=>{
    const client=context.services.client(context.bootstrap.binding);
    const roots=context.bootstrap.session!.capabilities.includes("files.read")?await readView(client.fileRoots()):denied<FileRootsView>();
    const directory=deps.directory??roots.data?.roots[0]?.ref;
    const [listing,selected]=await Promise.all([directory?readView(client.fileDirectory(directory,{limit:20,cursor:deps.cursor})):null,deps.selected?readView(client.fileStat(deps.selected)):null]);
    return {roots,directory,listing,selected};
  },
  component:Files,
});
function Files(){
  const data=Route.useLoaderData(),search=Route.useSearch(),router=useRouter();
  const [receipt,setReceipt]=useState<FileOperation>();
  return <><Heading eyebrow="SOURCE FILES" title="Files">Inspect configured roots and explicitly change their source bytes. Indexed Memory and Project documents keep their own source permissions.</Heading>
    <p><Link to="/materials" search={{kind:"file"}}>Search indexed source documents →</Link></p>
    <Card title="Named roots"><ErrorNotice error={viewError(data.roots)}/>
      {data.roots.data&&<><p>Source state: <Badge>{data.roots.data.state}</Badge></p>{!data.roots.data.roots.length?<Empty>No available named roots. This view does not create or authorize a root.</Empty>:<div className="actions">{data.roots.data.roots.map(root=><Link className="button" key={root.ref} to="/files" search={{directory:root.ref}}>{root.name}</Link>)}</div>}</>}
    </Card>
    {data.listing&&<Card title="Directory"><ErrorNotice error={viewError(data.listing)}/>{data.listing.data&&<>
      <p className="revision"><code>{data.listing.data.ref}</code></p>
      {!data.listing.data.entries.length?<Empty>This authorized directory is empty.</Empty>:<div className="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Bytes</th><th>Inspect</th></tr></thead><tbody>{data.listing.data.entries.map(entry=><tr key={entry.ref}>
        <td><Link to="/files" search={entry.kind==="directory"?{directory:entry.ref}:{directory:data.directory,selected:entry.ref}}>{entry.name}</Link></td><td>{entry.kind}</td><td>{entry.size}</td>
        <td><Link to="/files" search={{directory:data.directory,selected:entry.ref}}>Inspect {entry.name}</Link></td></tr>)}</tbody></table></div>}
      <div className="actions"><button onClick={()=>router.invalidate()}>Refresh directory</button>{data.listing.data.nextCursor&&<Link to="/files" search={{...search,cursor:data.listing.data.nextCursor}}>Next files →</Link>}{search.selected&&<Link to="/files" search={{directory:data.directory}}>Create another file</Link>}</div>
    </>}</Card>}
    {data.selected&&<ErrorNotice error={viewError(data.selected)}/>}
    {data.selected?.data&&<FileContent key={data.selected.data.ref} entry={data.selected.data}/>}
    {data.directory&&data.listing?.data&&(!search.selected||data.selected?.data)&&<FileEditor key={search.selected??data.directory} directory={data.directory} selected={data.selected?.data??undefined} onReceipt={setReceipt}/>}
    <FileHistory key={search.requestId??"local-history"} initialRequestId={search.requestId} latest={receipt} onReceipt={setReceipt}/>
  </>;
}
function FileContent({entry}:{entry:FileEntry}){
  const {services,bootstrap}=useConsole(),[content,setContent]=useState<FileRead>(),[pending,setPending]=useState(false),[error,setError]=useState<unknown>(),[download,setDownload]=useState<{size:number;sha256:string}>();
  const canRead=bootstrap.session!.capabilities.includes("files.content.read");
  async function load(downloadOnly:boolean){if(pending)return;setPending(true);setError(undefined);try{
    const client=services.client(bootstrap.binding);
    if(downloadOnly)setDownload(await downloadBrowserFile(client,entry.ref,entry.name));else setContent((await client.readFile(entry.ref)).data);
  }catch(e){setError(e);}finally{setPending(false);}}
  let displayed:string|undefined;
  if(content){try{const raw=atob(content.contentBase64);displayed=new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(raw,c=>c.charCodeAt(0)));if(displayed.includes("\0"))displayed=undefined;}catch{/* Binary content is displayed only as base64. */}}
  return <Card title="Selected source"><div data-testid="file-selected"><dl><dt>Name / kind</dt><dd>{entry.name} / {entry.kind}</dd><dt>Revision</dt><dd><code>{entry.revision}</code></dd><dt>Bytes</dt><dd>{entry.size}</dd></dl>
    <ErrorNotice error={error}/>{entry.kind==="file"&&<div className="actions"><button disabled={!canRead||pending||entry.size>65536} onClick={()=>load(false)}>Read source content</button><button disabled={!canRead||pending||entry.size>67108864} onClick={()=>load(true)}>Download verified file</button></div>}
    {content&&<><p>Explicit content · {displayed===undefined?"base64":"UTF-8"} · SHA-256 verified</p><pre data-testid="file-content" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{displayed??content.contentBase64}</pre></>}
    {download&&<p role="status">Verified {download.size} bytes delivered to the browser download. Saving to local storage is controlled by the browser.</p>}
    <p className="field-note">Content is data, never executable markup. A directory revision describes its entry metadata, not a cryptographic snapshot of every descendant.</p>
  </div></Card>;
}
function FileEditor({directory,selected,onReceipt}:{directory:string;selected?:FileEntry;onReceipt:(op:FileOperation)=>void}){
  const {services,bootstrap}=useConsole(),router=useRouter(),busy=useRef(false),scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId};
  const [action,setAction]=useState<"write"|"upload"|"mkdir"|"delete">(selected?.kind==="directory"?"delete":"write");
  const [name,setName]=useState(""),[text,setText]=useState(""),[file,setFile]=useState<File>(),[expected,setExpected]=useState(selected?.revision??null);
  const [confirmed,setConfirmed]=useState(false),[recursive,setRecursive]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<unknown>(),[rows,setRows]=useState<LocalOperation[]>(),[storageError,setStorageError]=useState(false);
  const caps=bootstrap.session!.capabilities;
  function refreshRows(){try{const rows=localOperations(localStorage,scope).filter(r=>r.command==="file-change");setRows(rows);setStorageError(false);return rows;}catch(e){setStorageError(true);setError(e);return undefined;}}
  useEffect(()=>{refreshRows();window.addEventListener("storage",refreshRows);return()=>window.removeEventListener("storage",refreshRows);},[scope.installationId,scope.principalId]);
  function target(){if(selected)return selected.ref;const parent=fileIdentity(directory,scope.installationId);return fileReference(scope.installationId,parent.binding,parent.root,(parent.path?`${parent.path}/`:"")+name);}
  let ref="";try{ref=target();}catch{/* Invalid draft is rejected before submission. */}
  const unresolved=rows?.find(r=>r.target===ref&&["awaiting-response","unknown"].includes(r.state));
  async function review(){if(busy.current||!selected)return;busy.current=true;setPending(true);try{setExpected((await services.client(bootstrap.binding).fileStat(selected.ref)).data.revision);setConfirmed(false);await router.invalidate();}catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function submit(event:FormEvent){event.preventDefault();if(busy.current||!confirmed||!rows||storageError)return;
    busy.current=true;setPending(true);setError(undefined);let locator:LocalOperation|undefined;
    try{
      const ref=target(),fresh=refreshRows();if(!fresh)throw new ManagementClientError("unavailable","Recovery storage is unavailable.");
      if(fresh.some(r=>r.target===ref&&["awaiting-response","unknown"].includes(r.state)))throw new ManagementClientError("operation_unknown","Inspect the original unresolved source operation before another change.");
      if(!selected&&(!name||name.includes("/")))throw new ManagementClientError("invalid_input","Enter one new entry name in the selected directory.");
      const base={requestId:crypto.randomUUID(),ref,confirmed:true as const,expectedRevision:expected};
      const request:FileChange=normalizeFileChange(action==="write"?{...base,action,content:text}:action==="upload"?{...base,action,size:file?.size,sha256:file?await browserFileDigest(file):""}:action==="delete"?{...base,action,recursive}:{...base,action},scope.installationId);
      const client=await services.prepareWrite(bootstrap.binding,scope.principalId);locator=rememberOperation(localStorage,scope,request);refreshRows();
      const operation=await publishBrowserFile(client,request,file);markOperation(localStorage,locator,fileLocalState(operation.state));onReceipt(operation);setConfirmed(false);refreshRows();await router.invalidate();
    }catch(e){
      if(locator){let observed=false;try{const operation=(await services.client(bootstrap.binding).fileOperation(locator.requestId)).data;markOperation(localStorage,locator,fileLocalState(operation.state));onReceipt(operation);observed=true;}catch{/* Keep uncertainty unless the response proves a pre-admission refusal. */}
        if(!observed)markOperation(localStorage,locator,e instanceof ManagementClientError&&e.reply&&["revision_conflict","permission_denied","invalid_input"].includes(e.code)?"refused":"unknown");refreshRows();}
      setError(e);
    }finally{busy.current=false;setPending(false);}
  }
  const authorized=caps.includes(action==="delete"?"files.delete":"files.write");
  return <Card title="Source change"><form onSubmit={submit} data-testid="file-editor"><ErrorNotice error={error}/>
    {storageError&&<p className="notice danger">Local recovery storage is unavailable. No change will be submitted.</p>}
    {unresolved&&<p className="notice">This source has an unresolved original request. <Link to="/operations" search={operationSearch(unresolved)}>Inspect original file operation</Link>.</p>}
    <fieldset disabled={pending||!rows||storageError||!!unresolved}><label htmlFor="file-action">Action</label><select id="file-action" value={action} onChange={e=>{setAction(e.target.value as typeof action);setConfirmed(false);}}>
      {selected?.kind!=="directory"&&<><option value="write">Write text</option><option value="upload">Upload binary</option></>}{!selected&&<option value="mkdir">Create directory</option>}{selected&&<option value="delete">Move to recoverable trash</option>}
    </select>{!selected&&<><label htmlFor="file-name">New entry name</label><input id="file-name" value={name} onChange={e=>setName(e.target.value)} maxLength={255} required/></>}
    <p className="field-note">Reviewed revision: <code data-testid="file-draft-revision">{expected??"absent"}</code>. Refreshing the directory does not rewrite this draft.</p>
    {selected&&<button type="button" onClick={review}>Refresh source revision, keep draft</button>}
    {action==="write"&&<><label htmlFor="file-text">Exact UTF-8 text</label><textarea id="file-text" value={text} onChange={e=>setText(e.target.value)} rows={6}/></>}
    {action==="upload"&&<><label htmlFor="file-upload">Local file · up to 64 MiB</label><input id="file-upload" type="file" onChange={e=>{setFile(e.target.files?.[0]);setConfirmed(false);}} required/></>}
    {action==="delete"&&selected?.kind==="directory"&&<label><input type="checkbox" checked={recursive} onChange={e=>setRecursive(e.target.checked)}/>Include the bounded directory subtree.</label>}
    <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={!authorized}/>I confirm this exact source change.</label>
    <button className="primary" type="submit" disabled={!authorized||!confirmed}>Apply file change</button></fieldset>
  </form></Card>;
}
function FileHistory({initialRequestId,latest,onReceipt}:{initialRequestId?:string;latest?:FileOperation;onReceipt:(op:FileOperation)=>void}){
  const {services,bootstrap}=useConsole(),router=useRouter(),scope={installationId:bootstrap.binding.installationId,principalId:bootstrap.session!.principalId},busy=useRef(false);
  const [requestId,setRequestId]=useState(initialRequestId??""),[result,setResult]=useState<FileOperation>(),[rows,setRows]=useState<LocalOperation[]>(),[error,setError]=useState<unknown>(),[pending,setPending]=useState(false),[confirmed,setConfirmed]=useState(false);
  const caps=bootstrap.session!.capabilities;
  function local(){try{setRows(localOperations(localStorage,scope).filter(r=>r.command==="file-change"));}catch(e){setError(e);setRows(undefined);}}
  useEffect(()=>{local();window.addEventListener("storage",local);return()=>window.removeEventListener("storage",local);},[scope.installationId,scope.principalId]);
  useEffect(()=>{if(latest){setResult(latest);setRequestId(latest.requestId);local();}},[latest]);
  useEffect(()=>{if(initialRequestId&&caps.includes("operations.read"))void recover(initialRequestId);},[initialRequestId]);
  async function recover(id:string){if(busy.current)return;busy.current=true;setPending(true);setError(undefined);try{
    const result=(await services.client(bootstrap.binding).fileOperation(id)).data;setResult(result);setRequestId(id);setConfirmed(false);
    const row=localOperations(localStorage,scope).find(r=>r.requestId===id&&r.command==="file-change"&&r.target===result.ref);if(row)markOperation(localStorage,row,fileLocalState(result.state));local();
  }catch(e){setError(e);}finally{busy.current=false;setPending(false);}}
  async function control(){if(!result||busy.current||!confirmed||!rows)return;busy.current=true;setPending(true);setError(undefined);let row:LocalOperation|undefined;
    try{
      const client=await services.prepareWrite(bootstrap.binding,scope.principalId);let next:FileOperation;
      if(result.action==="upload"&&result.state==="unknown"){
        row=retainFileOperation(localStorage,scope,result);local();next=(await client.controlFileUpload({requestId:result.requestId,generation:result.serviceGeneration,action:"cancel"})).data;
      }else if(result.action==="delete"&&result.state==="succeeded"){
        const request:FileChange={action:"restore",ref:result.ref,requestId:crypto.randomUUID(),deletionRequestId:result.requestId,expectedRevision:null,confirmed:true};
        row=rememberOperation(localStorage,scope,request);local();next=await publishBrowserFile(client,request);
      }else return;
      markOperation(localStorage,row,fileLocalState(next.state));setResult(next);onReceipt(next);setConfirmed(false);local();await router.invalidate();
    }catch(e){if(row){markOperation(localStorage,row,e instanceof ManagementClientError&&e.reply&&["revision_conflict","permission_denied","invalid_input"].includes(e.code)?"refused":"unknown");local();}setError(e);}
    finally{busy.current=false;setPending(false);}
  }
  const cancel=result?.action==="upload"&&result.state==="unknown",restore=result?.action==="delete"&&result.state==="succeeded";
  return <Card title="Original file operations"><div data-testid="file-history"><ErrorNotice error={error}/>
    <form onSubmit={e=>{e.preventDefault();void recover(requestId);}}><label htmlFor="file-request">Original request UUID</label><div className="toolbar"><input id="file-request" value={requestId} onChange={e=>setRequestId(e.target.value)} maxLength={36}/><button disabled={pending||!caps.includes("operations.read")||!FILE_UUID.test(requestId)}>Read original file operation</button></div></form>
    {result&&<div className="notice" data-testid="file-operation"><h3>Original file receipt</h3><dl><dt>Action / state</dt><dd>{result.action} / <Badge>{result.state}</Badge></dd><dt>Request</dt><dd><code>{result.requestId}</code></dd><dt>Source</dt><dd><code>{result.ref}</code></dd><dt>Published revision</dt><dd><code>{result.result?.revision??"not recorded"}</code></dd></dl>
      <p>Unknown never authorizes another publication. An original deletion is restored only to its original path, without replacing an existing destination.</p>
      <Link to="/operations" search={{domain:"file",requestId:result.requestId}}>Open file operation receipt</Link>
      {(cancel||restore)&&<><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={pending}/>I confirm this original recovery action.</label><button onClick={control} disabled={!rows||pending||!confirmed||!caps.includes(cancel?"files.write":"files.restore")}>{cancel?"Cancel original staging upload":"Restore original deletion"}</button><p className="field-note">A lost transfer owner or an unknown publication cannot be cancelled as though it had never happened.</p></>}
    </div>}
    {rows?.length?<div className="table-wrap"><table><thead><tr><th>Request</th><th>Local marker</th><th>Recovery</th></tr></thead><tbody>{rows.map(row=><tr key={row.requestId}><td><code>{row.requestId}</code></td><td>{row.state}</td><td><button disabled={pending||!caps.includes("operations.read")} onClick={()=>recover(row.requestId)}>Recover file request</button></td></tr>)}</tbody></table></div>:<Empty>No file recovery locators for this browser and principal.</Empty>}
    <p className="field-note">Only request/source locators are stored locally, never file bytes or reusable approvals. Reading this page does not send a change.</p>
  </div></Card>;
}
