import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, type NotificationView, type ReceiverView, type NotificationSendOperation } from "@grokbox/client";
import { localOperations, rememberOperation, markOperation, operationSearch, type LocalOperation } from "../lib/operations.ts";
import { Card, ErrorNotice, useConsole } from "./ui.tsx";

export function NotificationSender({ delivery, receivers }: { delivery: NotificationView; receivers: ReceiverView[] }) {
  const { services, bootstrap } = useConsole(), router = useRouter(), busy = useRef(false);
  const scope = { installationId: bootstrap.binding.installationId, principalId: bootstrap.session!.principalId };
  const canSend = bootstrap.session!.capabilities.includes("notifications.send"), canRecover = bootstrap.session!.capabilities.includes("operations.read");
  const [selected, setSelected] = useState(receivers.find(row => row.databaseId === delivery.databaseId && row.state === "prepared")?.receiverRef ?? "");
  const [approval, setApproval] = useState<{ receiverRef: string; revision: number; model: string }>();
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(), [locator, setLocator] = useState<LocalOperation>(), [unresolved, setUnresolved] = useState<LocalOperation>();
  const [receipt, setReceipt] = useState<NotificationSendOperation>();
  function inspectLocal() {
    const row = localOperations(localStorage, scope).find(row => row.command === "notification-send" && row.target === delivery.notificationRef
      && ["awaiting-response", "unknown"].includes(row.state));
    setUnresolved(row); if (row) setLocator(row); setReady(true); return row;
  }
  useEffect(() => {
    const read = () => { try { inspectLocal(); } catch (failure) { setReady(false); setError(failure); } };
    read(); window.addEventListener("storage", read); return () => window.removeEventListener("storage", read);
  }, [delivery.notificationRef, scope.installationId, scope.principalId]);
  async function review() {
    if (busy.current || !selected) return;
    busy.current = true; setPending(true); setError(undefined); setConfirmed(false);
    try {
      const api = services.client(bootstrap.binding), receiver = (await api.receiver(selected)).data;
      const proof = (await api.verifyReceiver(selected)).data;
      if (receiver.state !== "prepared" || receiver.databaseId !== delivery.databaseId || proof.state !== "ready" || !proof.modelRevision || proof.revision !== receiver.revision)
        throw new ManagementClientError("source_unavailable", "The exact prepared receiver and model could not be reviewed together. Nothing was sent.");
      setApproval({ receiverRef: selected, revision: proof.revision, model: proof.modelRevision });
    } catch (failure) { setApproval(undefined); setError(failure); }
    finally { busy.current = false; setPending(false); }
  }
  async function recover(row: LocalOperation) {
    if (busy.current || !canRecover) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const result = (await services.client(bootstrap.binding).notificationSendOperation(row.databaseId!, row.requestId)).data;
      if (result.notificationRef !== delivery.notificationRef) throw new ManagementClientError("protocol_error", "The receipt belongs to another work item.");
      setReceipt(result); setLocator(row); markOperation(localStorage, row, result.state); inspectLocal(); await router.invalidate();
    } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !ready || !canSend || !confirmed || !approval || approval.receiverRef !== selected || receipt !== undefined || delivery.state !== "ready" || delivery.attempt) return;
    busy.current = true; setPending(true); setError(undefined);
    let row: LocalOperation | undefined;
    try {
      if (inspectLocal()) return;
      const request = { notificationRef: delivery.notificationRef, receiverRef: approval.receiverRef, requestId: crypto.randomUUID(),
        expectedRevision: approval.revision, expectedModelRevision: approval.model, confirmed: true as const };
      const api = await services.prepareWrite(bootstrap.binding, scope.principalId);
      row = rememberOperation(localStorage, scope, request); setLocator(row); inspectLocal();
      const result = (await api.sendNotification(request)).data;
      markOperation(localStorage, row, result.state); setReceipt(result); setConfirmed(false); inspectLocal(); await router.invalidate();
    } catch (failure) {
      if (row) {
        markOperation(localStorage, row, failure instanceof ManagementClientError && failure.reply && failure.code !== "operation_unknown" ? "refused" : "unknown");
        if (failure instanceof ManagementClientError && failure.code === "notification_send_refused") setReceipt(failure.details?.operation as NotificationSendOperation);
        inspectLocal();
      }
      setError(failure);
    } finally { busy.current = false; setPending(false); }
  }
  return <Card title="Send this incident notification"><div data-testid="notification-sender">
    <p>Send only this existing incident work through its configured receiver. This may use the receiver's model; it does not enable future notifications, create new work or repeat an earlier attempt.</p>
    <ErrorNotice error={error}/>
    {unresolved && <div className="notice" role="status"><strong>Original delivery needs recovery</strong><p>Refresh and reconnect only query this request; they never submit another send.</p><code>{unresolved.requestId}</code>
      <button onClick={() => recover(unresolved)} disabled={pending || !canRecover}>Recover original delivery</button></div>}
    <form onSubmit={submit}><fieldset disabled={!ready || pending || !!unresolved || receipt !== undefined || !canSend || delivery.state !== "ready" || delivery.attempt !== null}>
      <label htmlFor="notification-send-receiver">Exact receiver</label><select id="notification-send-receiver" value={selected} onChange={event => { setSelected(event.target.value); setApproval(undefined); setConfirmed(false); }}>
        <option value="">Choose a receiver</option>{receivers.filter(row => row.databaseId === delivery.databaseId && row.state === "prepared").map(row => <option key={row.bindingId} value={row.receiverRef}>{row.alias} · {row.routineId}</option>)}
      </select><button type="button" onClick={review} disabled={!selected}>Review receiver for this delivery</button>
      {approval && <p data-testid="notification-send-approval">Reviewed binding revision {approval.revision}; model <code>{approval.model}</code>. A conflict retains this draft until you explicitly review again.</p>}
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I authorize this incident notification and its possible model cost.</label>
      <button type="submit" className="primary" disabled={!confirmed || !approval}>Send incident notification</button>
    </fieldset></form>
    {(!canSend || delivery.state !== "ready" || delivery.attempt !== null) && <p className="field-note">Sending requires a fresh unattempted work item and separate notification-send permission. Existing attempts and unknown requests cannot be replaced.</p>}
    {receipt && <div data-testid="notification-send-receipt" className="notice" role="status"><strong>Original delivery receipt</strong><p>{receipt.state} · {receipt.attempt?.state ?? receipt.reason ?? "No verified attempt yet"}. Bot report and user read remain not_observed.</p></div>}
    {locator && <Link to="/operations" search={operationSearch(locator)}>Open original delivery operation</Link>}
  </div></Card>;
}
