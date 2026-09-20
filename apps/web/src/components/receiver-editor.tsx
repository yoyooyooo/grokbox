import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, type ReceiverView, type ReceiverOperation, type NotificationTestOperation } from "@grokbox/client";
import { localOperations, markOperation, operationSearch, rememberOperation, type LocalOperation } from "../lib/operations.ts";
import { Badge, Card, ErrorNotice, SourceTime, useConsole } from "./ui.tsx";

export function ReceiverEditor({ receiver }: { receiver: ReceiverView }) {
  const { services, bootstrap } = useConsole(), router = useRouter(), busy = useRef(false);
  const scope = { installationId: bootstrap.binding.installationId, principalId: bootstrap.session!.principalId };
  const capabilities = bootstrap.session!.capabilities;
  const [ready, setReady] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<unknown>();
  const [action, setAction] = useState<"enable" | "disable" | "unbind">("enable"), [confirmed, setConfirmed] = useState(false), [testConfirmed, setTestConfirmed] = useState(false);
  const [expected, setExpected] = useState(receiver.revision), [model, setModel] = useState("");
  const [policyPending, setPolicyPending] = useState<LocalOperation>(), [testPending, setTestPending] = useState<LocalOperation>();
  const [receipt, setReceipt] = useState<ReceiverOperation>(), [testReceipt, setTestReceipt] = useState<NotificationTestOperation>();
  const [locator, setLocator] = useState<LocalOperation>(), [testLocator, setTestLocator] = useState<LocalOperation>();
  function syncLocators() {
    const rows = localOperations(localStorage, scope).filter(row => row.target === receiver.receiverRef && ["awaiting-response", "unknown"].includes(row.state));
    setPolicyPending(rows.find(row => row.command.startsWith("receiver-")));
    setTestPending(rows.find(row => row.command === "notification-test"));
    setReady(true);
    return rows;
  }
  useEffect(() => {
    const check = () => { try { syncLocators(); } catch (failure) { setError(failure); setReady(false); } };
    check(); window.addEventListener("storage", check);
    return () => window.removeEventListener("storage", check);
  }, [receiver.receiverRef, scope.installationId, scope.principalId]);
  async function verify() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const result = (await services.client(bootstrap.binding).verifyReceiver(receiver.receiverRef)).data;
      if (result.state !== "ready" || !result.modelRevision) throw new ManagementClientError("source_unavailable", `Receiver preflight blocked: ${result.reason}. No test was sent.`);
      setModel(result.modelRevision);
    } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  }
  async function refresh() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try { const result = await services.client(bootstrap.binding).receiver(receiver.receiverRef); setExpected(result.data.revision); await router.invalidate(); }
    catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  }
  async function recover(row: LocalOperation) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const api = services.client(bootstrap.binding);
      if (row.command === "notification-test") {
        const result = (await api.notificationTestOperation(row.databaseId!, row.requestId)).data;
        setTestReceipt(result); setTestLocator(row); markOperation(localStorage, row, result.state);
      } else {
        const result = (await api.receiverOperation(row.databaseId!, row.requestId)).data;
        setReceipt(result); setLocator(row); markOperation(localStorage, row, result.state);
      }
      syncLocators(); await router.invalidate();
    } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  }
  async function submit(isTest: boolean) {
    if (busy.current || !ready || isTest && (!testConfirmed || !capabilities.includes("notifications.test")) || !isTest && (!confirmed || !capabilities.includes("notifications.write"))) return;
    busy.current = true; setPending(true); setError(undefined);
    let row: LocalOperation | undefined;
    try {
      // Optional-test uncertainty blocks another test, never the independent
      // decision to enable/disable future notifications. Neither path resends.
      const unresolved = syncLocators().find(row => isTest ? row.command === "notification-test" : row.command.startsWith("receiver-"));
      if (unresolved) return;
      const request = { receiverRef: receiver.receiverRef, requestId: crypto.randomUUID(), expectedRevision: expected, confirmed: true as const,
        ...(isTest ? { action: "test" as const, expectedModelRevision: model } : action === "enable" ? { action, expectedModelRevision: model } : { action }) };
      if ((isTest || action === "enable") && !/^[a-f0-9]{64}$/.test(model)) throw new ManagementClientError("invalid_input", "Verify the receiver or enter its reviewed model revision before enabling or testing.");
      const api = await services.prepareWrite(bootstrap.binding, scope.principalId);
      row = rememberOperation(localStorage, scope, request);
      if (isTest) setTestLocator(row); else setLocator(row);
      syncLocators();
      if (isTest) {
        const result = (await api.testReceiver(request)).data;
        markOperation(localStorage, row, result.state); setTestReceipt(result); setTestConfirmed(false);
      } else {
        const result = (await api.changeReceiver(request)).data;
        markOperation(localStorage, row, result.state); setReceipt(result); setExpected(result.appliedRevision); setConfirmed(false);
      }
      syncLocators(); void router.invalidate();
    } catch (failure) {
      if (row) { markOperation(localStorage, row, failure instanceof ManagementClientError && failure.reply && failure.code !== "operation_unknown" ? "refused" : "unknown"); syncLocators(); }
      setError(failure);
    } finally { busy.current = false; setPending(false); }
  }
  function policySubmit(event: FormEvent) { event.preventDefault(); void submit(false); }
  const credentialUsable = ["prepared", "disabled"].includes(receiver.state) && receiver.credentialStored;
  return <Card title="Receiver controls"><div data-testid="receiver-editor"><p><strong>{receiver.alias}</strong> <Badge>{receiver.state}</Badge> <Badge tone={receiver.automatic ? "info" : "neutral"}>{receiver.automatic ? "enabled for future work" : "not enabled"}</Badge></p>
    <p className="revision"><code>{receiver.receiverRef}</code></p><dl><dt>Bot</dt><dd><code>{receiver.botRef}</code></dd><dt>Routine</dt><dd>{receiver.routineId}</dd><dt>Private credential</dt><dd>{receiver.credentialStored ? "stored; never exported" : "not available"}</dd>
      <dt>Permission starts</dt><dd>{receiver.automatic ? <SourceTime at={receiver.automatic.activatedAtMs}/> : "not enabled"}</dd></dl>
    <p className="field-note">Draft revision {expected}; latest read revision {receiver.revision}. Verification reads current qualification without sending or granting consent. A test is optional, never an enable prerequisite.</p>
    <ErrorNotice error={error}/>
    <div className="actions"><button onClick={verify} disabled={pending || !credentialUsable}>Verify receiver</button><button onClick={refresh} disabled={pending}>Refresh receiver revision, keep draft</button></div>
    <label htmlFor="receiver-model-revision">Reviewed model revision</label><input id="receiver-model-revision" value={model} onChange={event => setModel(event.target.value)} maxLength={64} spellCheck={false} disabled={pending}/>
    {policyPending && <div className="notice" role="status"><strong>Receiver change needs recovery</strong><p>No replacement change is submitted while this result is unknown.</p><code>{policyPending.requestId}</code><div className="actions"><button onClick={() => recover(policyPending)} disabled={pending}>Recover receiver change</button><Link to="/operations" search={operationSearch(policyPending)}>Open receiver operation</Link></div></div>}
    <form onSubmit={policySubmit}><fieldset disabled={!ready || pending || !!policyPending || !capabilities.includes("notifications.write")}><label htmlFor="receiver-action">Permission action</label>
      <select id="receiver-action" value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="enable">Enable future notifications</option><option value="disable">Disable future notifications</option><option value="unbind">Unbind local credentials</option></select>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I confirm this receiver change; enabling allows future bounded model wake costs.</label>
      <button className="primary" type="submit" disabled={!confirmed || action === "enable" && (!credentialUsable || !!receiver.automatic)}>Apply receiver change</button></fieldset></form>
    {receipt && <div className="notice" role="status"><strong>Receiver consent recorded</strong><p>{receipt.action}: revision {receipt.beforeRevision} → {receipt.appliedRevision}. No notification was sent by this action. The receipt is historical, not proof of current permission.</p></div>}
    {locator && <Link to="/operations" search={operationSearch(locator)}>View receiver operation receipt</Link>}
    <details open><summary>Independent notification test</summary><p>This explicitly sends one fixed test message and may incur model usage. It does not create an incident, change consent or prove that a user read it.</p>
      {testPending && <div className="notice" role="status"><strong>Test result needs recovery</strong><p>This blocks another test only. Enabling or disabling future notifications remains independent.</p><code>{testPending.requestId}</code><div className="actions"><button onClick={() => recover(testPending)} disabled={pending}>Recover notification test</button><Link to="/operations" search={operationSearch(testPending)}>Open test operation</Link></div></div>}
      <label><input type="checkbox" checked={testConfirmed} onChange={event => setTestConfirmed(event.target.checked)} disabled={pending || !!testPending || !capabilities.includes("notifications.test")}/>I authorize one optional test and its possible model cost.</label>
      <button onClick={() => submit(true)} disabled={!ready || pending || !!testPending || !testConfirmed || receiver.state !== "prepared" || !capabilities.includes("notifications.test")}>Send optional test</button>
      {testReceipt && <div className="notice" role="status"><strong>Independent test receipt</strong><p>Attempt: {testReceipt.delivery.attempt?.state ?? "not-attempted"}; recorded result: {testReceipt.delivery.state}. Automatic delivery is unchanged.</p><code>{testReceipt.delivery.notificationRef}</code></div>}
      {testLocator && <Link to="/operations" search={operationSearch(testLocator)}>View notification test receipt</Link>}
    </details></div></Card>;
}
