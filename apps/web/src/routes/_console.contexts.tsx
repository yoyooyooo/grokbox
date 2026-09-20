import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import type { ContextView, ContextOperation } from "@grokbox/client";
import { Card, Heading, ErrorNotice, Badge, Empty, SourceTime } from "../components/ui.tsx";
import { ContextEditor } from "../components/context-editor.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/contexts")({
  validateSearch: (v: Record<string, unknown>): { bot?: string; operationRef?: string } => ({ bot: boundedSearch(v.bot, 160), operationRef: boundedSearch(v.operationRef, 200) }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const api = context.services.client(context.bootstrap.binding), permissions = context.bootstrap.session!.capabilities;
    const [current, operation] = await Promise.all([
      !deps.bot ? null : !permissions.includes("context.read") ? denied<ContextView>() : readView(Promise.resolve().then(() => api.context(deps.bot!))),
      !deps.operationRef ? null : !permissions.includes("operations.read") ? denied<ContextOperation>() : readView(Promise.resolve().then(() => api.contextOperation(deps.operationRef!))),
    ]);
    return { current, operation };
  },
  component: Contexts,
});
function Contexts() {
  const data = Route.useLoaderData(), search = Route.useSearch(), router = useRouter(), navigate = useNavigate({ from: Route.fullPath });
  const [bot, setBot] = useState(search.bot ?? ""), [reference, setReference] = useState(search.operationRef ?? "");
  const view = data.current?.data, original = data.operation?.data;
  function select(event: FormEvent) { event.preventDefault(); void navigate({ search: { bot: bot.trim() || undefined, operationRef: reference.trim() || undefined } }); }
  return <><Heading eyebrow="SINGLE CURRENT CONTEXT" title="Current context">Inspect the native revision, retain a checkpoint, or manage an explicitly selected current context. Prepared, applied, released and task execution are different facts.</Heading>
    <Card title="Select an exact Bot or original operation"><form onSubmit={select}>
      <label htmlFor="context-bot">Native Bot UUID or reference</label><input id="context-bot" value={bot} onChange={e => setBot(e.target.value)} maxLength={160} spellCheck={false}/>
      <label htmlFor="context-original">Original context operation reference</label><input id="context-original" value={reference} onChange={e => setReference(e.target.value)} maxLength={200} spellCheck={false}/>
      <div className="actions"><button type="submit">Inspect current context</button><button type="button" onClick={() => router.invalidate()}>Refresh observations only</button></div>
    </form><p className="field-note">Operation history remains readable without the native source. Selecting an operation never applies its old material or automatically redirects a Bot reference.</p></Card>
    {data.current && <ErrorNotice error={viewError(data.current)}/>}
    {!data.current && <Empty>Select an exact Bot to inspect its current context. No source was opened by the empty page.</Empty>}
    {view && <Card title="Native context metadata"><div data-testid="context-head"><dl><dt>Bot</dt><dd><code>{view.botRef}</code></dd>
      <dt>Account scope</dt><dd><code>{view.scopeId}</code></dd><dt>Current revision</dt><dd><code>{view.revision}</code></dd>
      <dt>Observed state / unresolved effects</dt><dd><Badge tone={view.effects === "unresolved" ? "warn" : "neutral"}>{view.state}</Badge> / {view.effects}</dd>
      <dt>Checkpoint</dt><dd>{view.hasCheckpoint ? "A root is present; material completeness is checked on capture" : "No current root"}</dd>
      <dt>Observed</dt><dd><SourceTime at={view.observedAtMs}/></dd></dl><p>These are scoped native observations, not permission to run, a selectable session, or a dump of Memory and transcript contents.</p></div></Card>}
    {data.operation && <ErrorNotice error={viewError(data.operation)}/>}
    {original && <Card title="Original context history"><div data-testid="context-history"><p><code>{original.operationRef}</code></p><Badge tone={original.state === "unknown" ? "warn" : "info"}>{original.state}</Badge>
      <dl><dt>Exact target</dt><dd><code>{original.botRef}</code></dd><dt>Original action</dt><dd>{original.action}</dd><dt>Application / activation</dt><dd>{original.application} / {original.activation}</dd></dl>
      <Link to="/operations" search={{ domain: "context", scopeId: original.scopeId, requestId: original.requestId }}>Inspect retained context receipt</Link>
      {view && (view.botRef !== original.botRef || view.scopeId !== original.scopeId) && <p className="notice danger" role="alert">This original operation does not belong to the selected current Bot and account scope. Its controls have not been retargeted.</p>}
    </div></Card>}
    {view && <ContextEditor key={view.botRef} view={view} original={original?.botRef === view.botRef && original.scopeId === view.scopeId ? original : undefined}/>}
  </>;
}
