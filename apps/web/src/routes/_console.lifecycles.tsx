import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { lifecycleIdentity, type LifecycleList, type LifecycleOperation } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime, useConsole } from "../components/ui.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/lifecycles")({
  validateSearch: (value: Record<string, unknown>): { operation?: string; cursor?: string } => ({ operation: boundedSearch(value.operation, 200), cursor: boundedSearch(value.cursor, 200) }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (!context.bootstrap.session!.capabilities.includes("operations.read")) return { list: denied<LifecycleList>(), selected: deps.operation ? denied<LifecycleOperation>() : null };
    const api = context.services.client(context.bootstrap.binding);
    const [list, selected] = await Promise.all([readView(api.lifecycles({ limit: 20, cursor: deps.cursor })),
      deps.operation ? readView(Promise.resolve().then(() => api.lifecycle(deps.operation!))) : null]);
    return { list, selected };
  },
  component: Lifecycles,
});
function Lifecycles() {
  const data = Route.useLoaderData(), search = Route.useSearch(), navigate = useNavigate({ from: Route.fullPath }), router = useRouter(), { bootstrap } = useConsole();
  const [reference, setReference] = useState(search.operation ?? ""), [error, setError] = useState<unknown>();
  const row = data.selected?.data;
  function lookup(event: FormEvent) {
    event.preventDefault(); setError(undefined);
    try { const found = lifecycleIdentity(reference.trim(), bootstrap.binding.installationId); void navigate({ search: { operation: found.ref } }); }
    catch (failure) { setError(failure); }
  }
  return <><Heading eyebrow="NATIVE LIFECYCLE HISTORY" title="Bot lifecycles">Inspect the original clone, replacement or startup operation. A prepared Bot, released state, started turn and completed handover are different results. This page does not create Bots or start tasks.</Heading>
    <Card title="Retained operations"><ErrorNotice error={viewError(data.list)}/>
      <p className="field-note">Only operations belonging to this authenticated principal and installation are listed. Protection workflows and another principal's work are not included. Pagination is a retained keyset, not a frozen global snapshot.</p>
      {data.list.data && (!data.list.data.operations.length ? <Empty>No retained lifecycle operations in this principal's current window.</Empty> : <div className="table-wrap"><table><thead><tr><th>Original request</th><th>Kind</th><th>Recorded phase</th><th>Uncertain effects</th><th>Updated</th></tr></thead><tbody>{data.list.data.operations.map(item => <tr key={item.operationRef}>
        <td><Link to="/lifecycles" search={{ ...search, operation: item.operationRef }}><code>{item.requestId}</code></Link></td><td>{item.kind}</td><td><Badge tone={item.state === "blocked" ? "warn" : "neutral"}>{item.state}</Badge></td><td>{item.effectsUnknown ? "Original receipt required" : "No unresolved stage recorded"}</td><td><SourceTime at={item.updatedAtMs}/></td>
      </tr>)}</tbody></table></div>)}
      <div className="pagination"><button onClick={() => router.invalidate()}>Refresh lifecycle history</button>{search.cursor && <Link to="/lifecycles" search={{ operation: search.operation }}>First window</Link>}{data.list.data?.nextCursor && <Link to="/lifecycles" search={{ ...search, cursor: data.list.data.nextCursor }}>Next lifecycle window →</Link>}</div>
    </Card>
    <Card title="Read an original operation"><form onSubmit={lookup}><label htmlFor="lifecycle-reference">Lifecycle operation reference</label><div className="toolbar"><input id="lifecycle-reference" value={reference} onChange={e => setReference(e.target.value)} required maxLength={200} spellCheck={false}/><button type="submit">Read lifecycle receipt</button></div></form><ErrorNotice error={error}/>
      {data.selected && <ErrorNotice error={viewError(data.selected)}/>}
      {data.selected?.error?.code === "not_found" && <p className="notice">No matching receipt is not proof that a native effect never happened. Check the original principal, installation, account scope and request ID; do not issue a replacement create.</p>}
      {row && <div data-testid="lifecycle-receipt"><dl><dt>Reference</dt><dd><code>{row.operationRef}</code></dd><dt>Immutable plan</dt><dd><code>{row.planRevision}</code></dd>
        <dt>Original source</dt><dd>{row.sourceBotRef ? <code>{row.sourceBotRef}</code> : "None — independent startup"}</dd><dt>Associated target</dt><dd>{row.targetBotRef ? <code>{row.targetBotRef}</code> : "Not durably associated"}</dd>
        <dt>Recorded phase</dt><dd><Badge tone={row.state === "blocked" ? "warn" : "neutral"}>{row.state}</Badge></dd><dt>Requested effects</dt><dd>Activation: {row.requestedActivation ? "yes" : "no"} · Program startup: {row.requestedStartup ? "yes" : "no"}</dd>
        <dt>Current usability / source retirement</dt><dd>not-observed / not-observed</dd></dl>
        <div className="table-wrap"><table><thead><tr><th>Stage</th><th>Durable record</th></tr></thead><tbody>{row.steps.map(step => <tr key={step.step}><td>{step.step}</td><td>{step.state}</td></tr>)}</tbody></table></div>
        {row.effectsUnknown && <p className="notice danger">At least one native stage is uncertain. Repeated submission only reads the original receipt; it does not grant another create. Authorized continuation must use the original operation and plan.</p>}
        {row.handoverRef && (bootstrap.session!.capabilities.includes("protection.read") ? <Link to="/protection" search={{ handover: row.handoverRef }}>Inspect remaining handover duties</Link> : <p>Handover reference: <code>{row.handoverRef}</code>. Reading duties requires protection access.</p>)}
        <p className="field-note">Private instructions, profile descriptions, recovery bodies and provider settings are not loaded. Historical completion does not prove the target's present state or permission to delete its source.</p>
      </div>}
    </Card></>;
}
