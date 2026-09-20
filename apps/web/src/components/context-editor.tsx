import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ManagementClientError, contextOperationRef, type ContextChange, type ContextContinuation, type ContextView, type ContextOperation } from "@grokbox/client";
import { Card, ErrorNotice, Badge, useConsole } from "./ui.tsx";
import { localOperations, rememberOperation, retainContextContinuation, markOperation, contextLocalState, operationSearch, type LocalOperation } from "../lib/operations.ts";

export function ContextEditor({ view, original }: { view: ContextView; original?: ContextOperation }) {
  const { bootstrap, services } = useConsole(), session = bootstrap.session!, scope = { installationId: bootstrap.binding.installationId, principalId: session.principalId };
  const writable = session.capabilities.includes("context.write"), activatable = session.capabilities.includes("context.activate");
  const [draft, setDraft] = useState(view), [action, setAction] = useState<ContextChange["action"]>("capture"), [snapshot, setSnapshot] = useState("");
  const [confirmed, setConfirmed] = useState(false), [continuationConfirmed, setContinuationConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(), [storageError, setStorageError] = useState(false), [pending, setPending] = useState<LocalOperation>();
  const [last, setLast] = useState<LocalOperation>(), [result, setResult] = useState<ContextOperation | undefined>(original);
  function reloadLocators() {
    try {
      const rows = localOperations(localStorage, scope).filter(r => r.command === "context-control" && r.target === view.botRef);
      setPending(rows.find(r => r.state === "unknown" || r.state === "awaiting-response")); setStorageError(false);
    } catch { setStorageError(true); }
  }
  useEffect(() => { reloadLocators(); window.addEventListener("storage", reloadLocators); return () => window.removeEventListener("storage", reloadLocators); }, [scope.installationId, scope.principalId, view.botRef]);
  useEffect(() => { if (original) setResult(original); }, [original]);
  async function refresh() {
    setError(undefined);
    try { setDraft((await services.client(bootstrap.binding).context(view.botRef)).data); }
    catch (e) { setError(e); }
  }
  function finish(row: LocalOperation, value: ContextOperation) {
    markOperation(localStorage, row, contextLocalState(value.state)); setResult(value); setLast(row); setConfirmed(false); setContinuationConfirmed(false); reloadLocators();
  }
  function failed(row: LocalOperation | undefined, e: unknown, continuing = false) {
    if (row) markOperation(localStorage, row, !continuing && e instanceof ManagementClientError && ["invalid_input", "permission_denied", "source_changed", "revision_conflict", "idempotency_conflict"].includes(e.code) ? "refused" : "unknown");
    setError(e); reloadLocators();
  }
  async function submit() {
    if (busy || pending || storageError || !confirmed || !writable) return;
    setBusy(true); setError(undefined); let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      const input = { requestId: crypto.randomUUID(), botRef: view.botRef, scopeId: draft.scopeId, expectedRevision: draft.revision, confirmed: true, action,
        ...(["initialize", "restore"].includes(action) ? { snapshotRef: snapshot.trim() } : {}) } as ContextChange;
      row = rememberOperation(localStorage, scope, input); setLast(row); setPending(row);
      finish(row, (await api.changeContext(input)).data);
    } catch (e) { failed(row, e); } finally { setBusy(false); }
  }
  const selected = pending ?? (result?.botRef === view.botRef ? { requestId: result.requestId, contextScope: result.scopeId } : last);
  async function recover() {
    if (busy || !selected?.contextScope) return;
    setBusy(true); setError(undefined);
    try {
      const value = (await services.client(bootstrap.binding).contextOperation(contextOperationRef(scope.installationId, selected.contextScope, selected.requestId))).data;
      const row = localOperations(localStorage, scope).find(r => r.requestId === selected.requestId && r.command === "context-control" && r.target === view.botRef);
      if (row) finish(row, value); else setResult(value);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function advance(action: ContextContinuation["action"]) {
    if (busy || !selected?.contextScope || !continuationConfirmed || storageError || (action === "activate" ? !activatable : !writable)) return;
    setBusy(true); setError(undefined); let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      const input: ContextContinuation = { action, requestId: selected.requestId, scopeId: selected.contextScope, botRef: view.botRef, confirmed: true,
        ...(action === "activate" ? { expectedRevision: result?.requestId === selected.requestId && result.activationExpectedRevision ? result.activationExpectedRevision : draft.revision } : {}) } as ContextContinuation;
      row = retainContextContinuation(localStorage, scope, input); setLast(row); setPending(row);
      finish(row, (await api.continueContext(input)).data);
    } catch (e) { failed(row, e, true); } finally { setBusy(false); }
  }
  return <Card title="Current context control"><div data-testid="context-editor">
    <p>Capture saves private recovery material. Reset and restore back up first. Initialization only accepts an eligible unused target. None of these actions starts a task.</p>
    <ErrorNotice error={error}/>{storageError && <p className="notice danger" role="alert">Local recovery metadata is unavailable. No change or continuation will be submitted.</p>}
    {pending && <p className="notice">An original context operation is unresolved. Read or explicitly reconcile it before making another source change.</p>}
    <fieldset disabled={!writable || busy || !!pending || storageError}>
      <label htmlFor="context-action">Context action</label><select id="context-action" value={action} onChange={e => setAction(e.target.value as ContextChange["action"])}>
        <option value="capture">Capture checkpoint</option><option value="reset">Reset current context</option><option value="restore">Restore saved context</option><option value="initialize">Initialize unused target</option>
      </select>
      {["initialize", "restore"].includes(action) && <><label htmlFor="context-snapshot">Original snapshot reference</label><input id="context-snapshot" value={snapshot} onChange={e => setSnapshot(e.target.value)} maxLength={200} spellCheck={false}/></>}
      <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I confirm this exact context change and its private recovery material.</label>
      <button className="primary" onClick={submit} disabled={!confirmed}>Submit context change</button>
    </fieldset>
    <p className="field-note">Reviewed native revision: <code data-testid="context-draft-revision">{draft.revision}</code>. New page data does not silently replace a draft revision.</p>
    <button onClick={refresh} disabled={busy}>Read latest context revision, keep selection</button>
    {selected?.contextScope && <div className="receipt"><p>Original request: <code>{selected.requestId}</code></p><button onClick={recover} disabled={busy}>Read original context result</button>
      <label className="check"><input type="checkbox" checked={continuationConfirmed} onChange={e => setContinuationConfirmed(e.target.checked)} disabled={busy || storageError}/>I confirm continuing only this original operation, without a replacement request.</label>
      <div className="actions">
        <button onClick={() => advance("reconcile")} disabled={!writable || !continuationConfirmed || busy || storageError}>Reconcile original context</button>
        <button onClick={() => advance("resume")} disabled={!writable || !continuationConfirmed || busy || storageError}>Resume safe context stages</button>
        <button onClick={() => advance("cancel")} disabled={!writable || !continuationConfirmed || busy || storageError}>Cancel before source application</button>
        <button onClick={() => advance("activate")} disabled={!activatable || !continuationConfirmed || busy || storageError}>Release original context hold</button>
      </div><p className="field-note">Cancellation is permitted only before any native application declaration exists. Unknown application cannot be cancelled or turned into another apply. Hold release uses its original native marker and starts no task.</p>
    </div>}
    {result && <div className="receipt" data-testid="context-result"><h3>Original context result</h3><Badge tone={result.state === "unknown" || result.state === "admitted" ? "warn" : "info"}>{result.state}</Badge>
      <dl><dt>Reference</dt><dd><code>{result.operationRef}</code></dd><dt>Application / activation</dt><dd>{result.application} / {result.activation}</dd>
      <dt>Original release revision</dt><dd><code>{result.activationExpectedRevision ?? "not requested"}</code></dd><dt>Captured snapshot</dt><dd><code>{result.captureRef ?? "not recorded"}</code></dd><dt>Target backup</dt><dd><code>{result.backupRef ?? "not recorded"}</code></dd><dt>Candidate material</dt><dd><code>{result.candidateRef ?? "not recorded"}</code></dd></dl>
      <p>These are retained operation facts, not current usability or a task result. Snapshot references preserve identity even after material retirement; this page never loads their bodies.</p>
      <Link to="/operations" search={{ requestId: result.requestId, domain: "context", scopeId: result.scopeId }}>View context operation receipt</Link>
    </div>}
    {last && !result && <Link to="/operations" search={operationSearch(last)}>View original context request</Link>}
  </div></Card>;
}
