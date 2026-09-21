import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ManagementClientError, protectionReferenceIdentity, type ProtectionHandover, type HandoverAction, type HandoverOperation, type HandoverChange, type HandoverContinuation } from "@grokbox/client";
import { Card, Badge, ErrorNotice, useConsole } from "./ui.tsx";
import { localOperations, rememberOperation, retainHandoverContinuation, markOperation, handoverLocalState, operationSearch, type LocalOperation } from "../lib/operations.ts";

export function HandoverEditor({ view, original }: { view: ProtectionHandover; original?: HandoverOperation }) {
  const { bootstrap, services } = useConsole(), session = bootstrap.session!, scope = { installationId: bootstrap.binding.installationId, principalId: session.principalId };
  const account = protectionReferenceIdentity(view.handoverRef, scope.installationId, "handover").scopeId;
  const [draft, setDraft] = useState(view), [action, setAction] = useState<HandoverAction>("observe"), [itemId, setItemId] = useState(""), [evidenceRef, setEvidenceRef] = useState("");
  const [confirmed, setConfirmed] = useState(false), [continuing, setContinuing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [storageError, setStorageError] = useState(false), [pending, setPending] = useState<LocalOperation>(), [last, setLast] = useState<LocalOperation>(), [result, setResult] = useState(original);
  const allowed = (kind: HandoverAction) => session.capabilities.includes("handover.write")
    && (kind !== "attest" || session.capabilities.includes("handover.attest")) && (kind !== "retire" || session.capabilities.includes("handover.retire"))
    && (kind !== "advance" || !draft.userMessagesConfigured || session.capabilities.includes("handover.messages"));
  function reload() {
    try { setPending(localOperations(localStorage, scope).find(r => r.command === "handover-control" && r.target === view.handoverRef && ["unknown", "awaiting-response"].includes(r.state))); setStorageError(false); }
    catch { setStorageError(true); }
  }
  useEffect(() => { reload(); window.addEventListener("storage", reload); return () => window.removeEventListener("storage", reload); }, [scope.installationId, scope.principalId, view.handoverRef]);
  useEffect(() => { if (original?.handoverRef === view.handoverRef) setResult(original); }, [original, view.handoverRef]);
  function finish(row: LocalOperation | undefined, value: HandoverOperation) {
    if (value.handoverRef !== view.handoverRef) throw new ManagementClientError("operation_unknown", "This original request belongs to another handover. Its controls were not retargeted.");
    if (row) { markOperation(localStorage, row, handoverLocalState(value.state)); setLast(row); }
    setResult(value); setConfirmed(false); setContinuing(false); reload();
  }
  function failed(row: LocalOperation | undefined, value: unknown, continuation = false) {
    if (row) markOperation(localStorage, row, !continuation && value instanceof ManagementClientError
      && ["invalid_input", "permission_denied", "revision_conflict", "idempotency_conflict", "source_changed", "not_found"].includes(value.code) ? "refused" : "unknown");
    setError(value); reload();
  }
  async function refresh() {
    if (busy) return; setBusy(true); setError(undefined);
    try { setDraft((await services.client(bootstrap.binding).protectionHandover(view.handoverRef)).data); setConfirmed(false); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function submit() {
    if (busy || pending || storageError || !confirmed || !allowed(action) || !draft.activated) return;
    setBusy(true); setError(undefined); let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      const input: HandoverChange = { requestId: crypto.randomUUID(), handoverRef: view.handoverRef, action, expectedRevision: draft.revision, confirmed: true,
        ...(action === "attest" ? { itemId: itemId.trim(), evidenceRef: evidenceRef.trim() } : action === "retire" ? { evidenceRef: evidenceRef.trim() } : {}) };
      row = rememberOperation(localStorage, scope, input); setLast(row); setPending(row);
      finish(row, (await api.changeHandover(input)).data);
    } catch (e) { failed(row, e); } finally { setBusy(false); }
  }
  const selected = pending ?? (result?.handoverRef === view.handoverRef ? { requestId: result.requestId, contextScope: account } : last);
  async function recover() {
    if (busy || !selected?.contextScope) return; setBusy(true); setError(undefined);
    try {
      const value = (await services.client(bootstrap.binding).handoverOperation(selected.contextScope, selected.requestId)).data;
      const row = localOperations(localStorage, scope).find(r => r.requestId === selected.requestId && r.command === "handover-control" && r.target === view.handoverRef);
      finish(row, value);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function advance(kind: HandoverContinuation["action"]) {
    if (busy || !selected?.contextScope || !continuing || storageError || !session.capabilities.includes("handover.write")) return;
    setBusy(true); setError(undefined); let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      const input: HandoverContinuation = { requestId: selected.requestId, scopeId: selected.contextScope, action: kind, confirmed: true };
      row = retainHandoverContinuation(localStorage, scope, input, view.handoverRef); setLast(row); setPending(row);
      finish(row, (await api.continueHandover(input)).data);
    } catch (e) { failed(row, e, true); } finally { setBusy(false); }
  }
  return <Card title="Handover control"><div data-testid="handover-editor">
    <p>Advance executes a bounded dependency-ordered batch in the original replacement. Observe reads native relationships and records local evidence only. Attest rechecks one observed duty. Retirement requires independent resources and a qualified native deletion boundary.</p>
    <ErrorNotice error={error}/>
    {storageError && <p className="notice danger" role="alert">Local recovery metadata is unavailable. No new handover request will be sent.</p>}
    {pending && <p className="notice">An original handover operation is unresolved. Query or continue that request before creating another.</p>}
    {!draft.activated && <p className="notice">The replacement has not completed activation, or is already retired. No new handover action is enabled.</p>}
    <fieldset disabled={busy || !!pending || storageError || !session.capabilities.includes("handover.write") || !draft.activated}>
      <label htmlFor="handover-action">Handover action</label><select id="handover-action" value={action} onChange={e => { setAction(e.target.value as HandoverAction); setConfirmed(false); }}>
        <option value="observe">Observe relationships</option><option value="advance">Advance original duties</option><option value="attest">Attest observed duty</option><option value="retire">Evaluate and retire source</option>
      </select>
      {action === "attest" && <><label htmlFor="handover-item">Observed duty UUID</label><input id="handover-item" value={itemId} onChange={e => { setItemId(e.target.value); setConfirmed(false); }} maxLength={36}/></>}
      {["attest", "retire"].includes(action) && <><label htmlFor="handover-evidence">{action === "attest" ? "Exact duty evidence reference" : "Original observation operation reference"}</label><input id="handover-evidence" value={evidenceRef} onChange={e => { setEvidenceRef(e.target.value); setConfirmed(false); }} maxLength={350} spellCheck={false}/></>}
      {action === "advance" && draft.userMessagesConfigured && <p className="notice">This workflow permits formal notices sent as the authenticated user. Separate message authority is required; no Bot sender is fabricated.</p>}
      {action === "retire" && <p className="notice danger">Retirement may delete the old native identity only after all required checks. A quiet interval, an active successor or a pasted hash cannot authorize deletion.</p>}
      {!allowed(action) && <p className="notice">This action requires an additional explicit capability.</p>}
      <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I confirm this handover action and its disclosed native effects.</label>
      <button className="primary" disabled={!confirmed || !allowed(action)} onClick={submit}>Submit handover action</button>
    </fieldset>
    <p className="field-note">Reviewed revision: <code data-testid="handover-draft-revision">{draft.revision}</code>. A conflict preserves this approval; refresh it explicitly.</p>
    <button disabled={busy} onClick={refresh}>Read latest handover revision</button>
    {selected?.contextScope && <div className="receipt"><p>Original request: <code>{selected.requestId}</code></p><button disabled={busy} onClick={recover}>Read original handover result</button>
      <label className="check"><input type="checkbox" checked={continuing} onChange={e => setContinuing(e.target.checked)} disabled={busy || storageError}/>I confirm continuing only the original handover request.</label>
      <div className="actions">{(["reconcile", "resume", "cancel"] as const).map(kind => <button key={kind} disabled={busy || storageError || !continuing || !session.capabilities.includes("handover.write")} onClick={() => advance(kind)}>{kind === "reconcile" ? "Reconcile original handover" : kind === "resume" ? "Resume original duties" : "Cancel undispatched preparation"}</button>)}</div>
      <p className="field-note">Reconciliation never dispatches a new native effect. Resume retains the original duty identities; unknown effects are not resent. Cancellation is limited to preparation before dispatch.</p>
    </div>}
    {result && <div className="receipt" data-testid="handover-result"><h3>Original handover operation</h3><Badge tone={result.state === "unknown" || result.state === "admitted" ? "warn" : "info"}>{result.state}</Badge>
      <p><code>{result.operationRef}</code></p>{result.result && <><dl><dt>Batch outcome</dt><dd>{result.result.outcome}{result.result.reason && ` · ${result.result.reason}`}</dd><dt>Duties</dt><dd>{result.result.complete} complete · {result.result.remaining} remaining · {result.result.unknown} unknown</dd><dt>Native source deletion</dt><dd>{result.result.sourceDeleted ? "Recorded by the original retirement operation" : "Not performed by this operation"}</dd></dl>
        {result.result.assessment && <p data-testid="handover-blockers">Retirement blockers: {result.result.assessment.blockers.join(", ") || "None in this observation; fresh checks still required"}.</p>}
        {result.result.observations.map(item => item.evidenceRef && <p key={item.itemId}><code>{item.evidenceRef}</code> <button onClick={() => { setAction("attest"); setItemId(item.itemId); setEvidenceRef(item.evidenceRef!); setConfirmed(false); }}>Select this observed duty</button></p>)}
        <p className="notice">A completed management batch does not mean all duties are complete. Recorded native state does not prove causation, current target usability or permission to delete.</p></>}
      <Link to="/operations" search={{ domain: "handover", requestId: result.requestId, scopeId: account }}>View handover operation receipt</Link>
    </div>}
    {last && !result && <Link to="/operations" search={operationSearch(last)}>View original handover request</Link>}
  </div></Card>;
}
