import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ManagementClientError, compactionOperation, type CompactionPreview, type CompactionChange, type CompactionContinuation, type CompactionOperation } from "@grokbox/client";
import { Card, ErrorNotice, Badge, useConsole } from "./ui.tsx";
import { localOperations, rememberOperation, retainCompactionContinuation, markOperation, compactionLocalState, operationSearch, type LocalOperation } from "../lib/operations.ts";

/** Only the shared compaction API executes work. This editor retains locators,
 * never the approved plan, context, summary text or credentials. */
export function CompactionEditor({ botRef, view, original }: { botRef: string; view?: CompactionPreview; original?: CompactionOperation }) {
  const { bootstrap, services } = useConsole(), session = bootstrap.session!;
  const scope = { installationId: bootstrap.binding.installationId, principalId: session.principalId };
  const writable = session.capabilities.includes("context.compact"), readable = session.capabilities.includes("operations.read");
  const [draft, setDraft] = useState(view), [confirmed, setConfirmed] = useState(false), [continuationConfirmed, setContinuationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [storageError, setStorageError] = useState(false), [error, setError] = useState<unknown>();
  const [pending, setPending] = useState<LocalOperation>(), [other, setOther] = useState<LocalOperation>(), [last, setLast] = useState<LocalOperation>();
  const [result, setResult] = useState<CompactionOperation | undefined>(original);
  function reloadLocators() {
    try {
      const rows = localOperations(localStorage, scope).filter(r => r.target === botRef && ["unknown", "awaiting-response"].includes(r.state));
      setPending(rows.find(r => r.command === "context-compaction"));
      setOther(rows.find(r => r.command === "context-control")); setStorageError(false);
    } catch { setStorageError(true); }
  }
  useEffect(() => { reloadLocators(); window.addEventListener("storage", reloadLocators); return () => window.removeEventListener("storage", reloadLocators); }, [botRef, scope.installationId, scope.principalId]);
  useEffect(() => { if (original) setResult(original); }, [original]);
  function finish(row: LocalOperation | undefined, value: CompactionOperation) {
    if (value.botRef !== botRef) throw new ManagementClientError("protocol_error", "The original result belongs to another Bot.");
    if (row) { markOperation(localStorage, row, compactionLocalState(value.state)); setLast(row); }
    setResult(value); setConfirmed(false); setContinuationConfirmed(false); reloadLocators();
  }
  function failed(row: LocalOperation | undefined, e: unknown, continuing: boolean) {
    if (row) {
      const value = e instanceof ManagementClientError ? e.details?.operation : undefined;
      if (e instanceof ManagementClientError && e.code === "compaction_failed" && row.contextScope
        && compactionOperation(value, scope.installationId, row.contextScope, row.requestId) && value.botRef === botRef && value.state === "failed") finish(row, value);
      else markOperation(localStorage, row, !continuing && e instanceof ManagementClientError
        && ["invalid_input", "revision_conflict", "source_changed", "idempotency_conflict"].includes(e.code) ? "refused" : "unknown");
    }
    setError(e); reloadLocators();
  }
  async function refresh() {
    if (busy) return; setBusy(true); setError(undefined);
    try { setDraft((await services.client(bootstrap.binding).compactionPreview(botRef)).data); setConfirmed(false); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function submit() {
    if (!draft || !writable || busy || pending || other || storageError || !confirmed) return;
    setBusy(true); setError(undefined); let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      const input: CompactionChange = { requestId: crypto.randomUUID(), botRef, scopeId: draft.scopeId, expectedRevision: draft.revision, confirmed: true };
      row = rememberOperation(localStorage, scope, input); setLast(row); setPending(row);
      finish(row, (await api.compact(input)).data);
    } catch (e) { failed(row, e, false); } finally { setBusy(false); }
  }
  const selected = pending ?? (result?.botRef === botRef ? { requestId: result.requestId, contextScope: result.scopeId } : last);
  async function recover() {
    if (busy || !readable || !selected?.contextScope) return; setBusy(true); setError(undefined);
    try {
      const value = (await services.client(bootstrap.binding).compactionOperation(selected.contextScope, selected.requestId)).data;
      const row = localOperations(localStorage, scope).find(r => r.command === "context-compaction" && r.target === botRef && r.requestId === selected.requestId && r.contextScope === selected.contextScope);
      finish(row, value);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function advance(action: CompactionContinuation["action"]) {
    if (busy || !writable || !selected?.contextScope || !continuationConfirmed || storageError) return;
    setBusy(true); setError(undefined); let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      const input: CompactionContinuation = { action, requestId: selected.requestId, scopeId: selected.contextScope, botRef, confirmed: true };
      row = retainCompactionContinuation(localStorage, scope, input); setLast(row); setPending(row);
      finish(row, (await api.continueCompaction(input)).data);
    } catch (e) { failed(row, e, true); } finally { setBusy(false); }
  }
  return <Card title="Compact current context"><div data-testid="compaction-editor">
    <p>Compaction can call the selected summary model and incur cost. It uses the current root when the native default Box runner admits this request; the preview is not a frozen snapshot. It does not send a user task.</p>
    <ErrorNotice error={error}/>
    {storageError && <p role="alert" className="notice danger">Local recovery metadata cannot be read. No replacement request will be submitted.</p>}
    {pending && <p className="notice">An original compaction is unresolved. Read or reconcile that request before submitting another.</p>}
    {other && <p className="notice">An original context change is unresolved. <Link to="/operations" search={operationSearch(other)}>Inspect that original context operation</Link>.</p>}
    {draft ? <dl data-testid="compaction-plan"><dt>Selected summary model</dt><dd>{draft.modelId}</dd><dt>Native capability</dt><dd><Badge>{draft.nativeCapability}</Badge></dd>
      <dt>Input / reserved tokens</dt><dd>{draft.budget.inputTokens} / {draft.budget.reserveTokens}</dd><dt>Reviewed plan revision</dt><dd><code data-testid="compaction-draft-revision">{draft.revision}</code></dd></dl>
      : <p className="notice">No current compaction plan is available. Retained history is separate from native availability.</p>}
    <button onClick={refresh} disabled={busy}>Review latest compaction plan</button>
    <fieldset disabled={!writable || busy || !!pending || !!other || storageError || !draft || draft.nativeCapability !== "ready"}>
      <label className="check"><input id="compaction-confirm" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I approve compaction of this Bot's current context and its possible summary-model cost.</label>
      <button className="primary" onClick={submit} disabled={!confirmed}>Compact current context</button>
    </fieldset>
    <p className="field-note">Refreshing page observations does not silently change this reviewed revision. A conflict keeps the draft; review the latest plan explicitly.</p>
    {selected?.contextScope && <div className="receipt"><p>Original request: <code>{selected.requestId}</code></p>
      <button onClick={recover} disabled={busy || !readable}>Read original compaction result</button>
      <label className="check"><input id="compaction-continue-confirm" type="checkbox" checked={continuationConfirmed} onChange={e => setContinuationConfirmed(e.target.checked)} disabled={busy || storageError || !writable}/>I confirm acting only on this original request, without a new dispatch identity.</label>
      <div className="actions"><button onClick={() => advance("reconcile")} disabled={busy || storageError || !writable || !continuationConfirmed}>Reconcile original compaction</button>
        <button onClick={() => advance("resume")} disabled={busy || storageError || !writable || !continuationConfirmed}>Resume undispatched compaction</button>
        <button onClick={() => advance("cancel")} disabled={busy || storageError || !writable || !continuationConfirmed}>Cancel before compaction dispatch</button></div>
      <p className="field-note">Resume executes only an admitted, undispatched original plan. Unknown native work is only queried, never retried. Cancel is unavailable after a dispatch declaration.</p>
    </div>}
    {result && <div className="receipt" data-testid="compaction-result"><h3>Original compaction result</h3><Badge tone={["unknown", "admitted"].includes(result.state) ? "warn" : "info"}>{result.state}</Badge>
      <dl><dt>Reference</dt><dd><code>{result.operationRef}</code></dd><dt>Native settlement</dt><dd>{result.nativeSettlement}</dd><dt>Failure</dt><dd>{result.failureCode ?? "none recorded"}</dd>
        {result.result && <><dt>Outcome</dt><dd>{result.result.outcome}</dd><dt>Measured tokens</dt><dd>{result.result.beforeTokens} → {result.result.afterTokens}</dd><dt>Summary calls / input tokens</dt><dd>{result.result.summaryRequests} / {result.result.summaryInputTokens}</dd><dt>Target / headroom</dt><dd>{String(result.result.targetMet)} / {String(result.result.headroomMet)}</dd></>}</dl>
      <p>Historical evidence only. A no-op consumes this request; later input cannot turn it into new work. This result does not prove the current model window or delivery to the App.</p>
      <Link to="/operations" search={{ requestId: result.requestId, domain: "compaction", scopeId: result.scopeId }}>View compaction operation receipt</Link>
    </div>}
    {last && !result && <Link to="/operations" search={operationSearch(last)}>View original compaction request</Link>}
  </div></Card>;
}
