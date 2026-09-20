import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { materialIdentity, type MaterialKind, type MaterialScope, type MaterialPage, type MaterialRead, type MaterialStatus } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { MaterialEditor } from "../components/material-editor.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";
type Search = { kind: "memory" | "project" | "file"; query?: string; sourceId?: string; scope?: MaterialScope; cursor?: string; selected?: string };
export const Route = createFileRoute("/_console/materials")({
  validateSearch:(s:Record<string,unknown>):Search=>({kind:s.kind==="project"||s.kind==="file"?s.kind:"memory",query:boundedSearch(s.query),sourceId:boundedSearch(s.sourceId,32),
    scope:["agent","user","project","file"].includes(String(s.scope))?s.scope as MaterialScope:undefined,cursor:boundedSearch(s.cursor,160),selected:boundedSearch(s.selected,1800)}),
  loaderDeps:({search})=>search,
  loader:async({context,deps})=>{
    const api=context.services.client(context.bootstrap.binding), caps=context.bootstrap.session!.capabilities;
    const [status,page,selected]=await Promise.all([
      caps.includes("materials.read")?readView(api.materialStatus()):denied<MaterialStatus>(),
      caps.includes(deps.query?"materials.search":"materials.read")?readView(Promise.resolve().then(()=>api.materials({kind:deps.kind,sourceId:deps.sourceId,scope:deps.scope,query:deps.query,cursor:deps.cursor,limit:25}))):denied<MaterialPage>(),
      deps.selected?caps.includes("materials.content.read")?readView(Promise.resolve().then(()=>api.readMaterial(deps.selected!))):denied<MaterialRead>():null,
    ]);
    const memberships=selected?.data?.document.kind==="project"&&caps.includes("materials.read")
      ?await readView(api.materials({sourceId:materialIdentity(selected.data.document.ref,context.bootstrap.binding.installationId).sourceId,kind:"membership",limit:100})):null;
    return {status,page,selected,memberships};
  },component:Materials,
});
function Materials(){
  const data=Route.useLoaderData(),search=Route.useSearch(),navigate=useNavigate({from:Route.fullPath}),router=useRouter();
  const [query,setQuery]=useState(search.query??"");
  function submit(e:FormEvent){e.preventDefault();void navigate({search:{...search,query:query.trim()||undefined,cursor:undefined,selected:undefined}});}
  const members=data.memberships?.data?.items.filter(row=>row.membership.includes(data.selected?.data?.document.project??""))??[];
  return <><Heading eyebrow="SOURCE DOCUMENTS" title="Materials">Search only explicitly configured local sources. Native replicas, file contents and index freshness remain separate facts.</Heading>
    <nav className="actions" aria-label="Material categories">{(["memory","project","file"] as const).map(kind=><Link key={kind} to="/materials" search={{kind}} aria-current={search.kind===kind?"page":undefined}>{kind==="memory"?"Memory":kind==="project"?"Projects":"Files"}</Link>)}</nav>
    <Card title="Find documents"><form onSubmit={submit}><div className="toolbar"><label htmlFor="material-query">Literal text search</label><input id="material-query" value={query} onChange={e=>setQuery(e.target.value)} maxLength={256}/><button type="submit">Search materials</button></div></form>
      <div className="toolbar"><label htmlFor="material-source">Source</label><select id="material-source" value={search.sourceId??""} onChange={e=>void navigate({search:{...search,sourceId:e.target.value||undefined,cursor:undefined,selected:undefined}})}><option value="">All configured sources</option>{data.status.data?.sources.map(s=><option key={s.id} value={s.id}>{s.id}</option>)}</select>
        {search.kind==="memory"&&<><label htmlFor="material-scope">Memory scope</label><select id="material-scope" value={search.scope??""} onChange={e=>void navigate({search:{...search,scope:(e.target.value||undefined) as MaterialScope|undefined,cursor:undefined,selected:undefined}})}><option value="">All authorized scopes</option><option value="agent">Agent</option><option value="user">User</option><option value="project">Project</option></select></>}
        <button type="button" onClick={()=>void router.invalidate()}>Refresh material view</button></div>
      <ErrorNotice error={viewError(data.page)}/>
      {data.page.error?.code==="cursor_gap"&&<Link to="/materials" search={{...search,cursor:undefined}}>Start a new material snapshot</Link>}
      {data.page.data&&(!data.page.data.items.length?<Empty>No matching documents in this indexed window. Review source coverage below before treating this as absence.</Empty>:<div className="table-wrap"><table data-testid="material-list"><thead><tr><th>Document</th><th>Source / scope</th><th>Source time</th><th>Bytes</th></tr></thead><tbody>{data.page.data.items.map(item=><tr key={item.ref}><td><Link to="/materials" search={{...search,selected:item.ref}}>{item.path}</Link><small className="block muted">{item.writable?"Text editing permitted by source":"Read-only source"}</small></td><td>{item.sourceId} · {item.scope}</td><td><SourceTime at={item.modifiedAtMs}/></td><td>{item.bytes}</td></tr>)}</tbody></table></div>)}
      {data.page.data?.nextCursor&&<div className="pagination"><Link to="/materials" search={{...search,cursor:data.page.data.nextCursor,selected:undefined}}>Next material page →</Link></div>}
      <p className="field-note">Lists contain metadata only. Open an exact reference to read current source text. Equal contents do not merge identities across scopes.</p>
    </Card>
    {data.selected&&<ErrorNotice error={viewError(data.selected)}/>}{data.selected?.data&&<MaterialEditor key={data.selected.data.document.ref} value={data.selected.data}/>}
    {data.memberships&&<Card title="Observed Project memberships"><ErrorNotice error={viewError(data.memberships)}/><p>From the configured Bots’ native membership files, not from repository paths or an assumed account-wide roster.</p>{members.length?<ul>{members.map(member=><li key={member.ref}><code>{member.agentId}</code></li>)}</ul>:<Empty>No matching membership in this indexed window.</Empty>}{data.memberships.data?.nextCursor&&<p className="notice">Additional membership pages exist; this display is incomplete.</p>}</Card>}
    <Card title="Source coverage"><ErrorNotice error={viewError(data.status)}/>{data.status.data&&<><p>Indexer: <Badge>{data.status.data.state}</Badge> · No source writes or native model calls are performed by indexing.</p>
      {!data.status.data.sources.length?<Empty>No sources are explicitly configured. Opening this page does not create or authorize one.</Empty>:<div className="table-wrap"><table data-testid="material-sources"><thead><tr><th>Source</th><th>Index</th><th>Last indexed</th><th>Coverage</th></tr></thead><tbody>{data.status.data.sources.map(source=><tr key={source.id}><td>{source.id}<small className="block muted">{source.kind}</small></td><td><Badge tone={source.state==="ready"?"neutral":"warn"}>{source.state}</Badge> <Badge tone={source.freshness==="stale"?"warn":"neutral"}>{source.freshness}</Badge><small className="block">{source.reason}</small></td><td>{source.indexedAtMs?<SourceTime at={source.indexedAtMs}/>:"not indexed"}</td><td>{source.documents} documents · {source.skipped} skipped</td></tr>)}</tbody></table></div>}
      <p className="field-note">The account scope is an explicit source binding, not a newly verified native login. Upstream synchronization, authorship and TURN inclusion are not observed. A partial or unavailable source is not a complete empty result.</p></>}
    </Card></>;
}
