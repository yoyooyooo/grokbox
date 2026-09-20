import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ManagementClientError, type IncidentView, type IncidentOperation } from "@grokbox/client";
import { localOperations, rememberOperation, markOperation, operationSearch, type LocalOperation } from "../lib/operations.ts";
import { Card, Badge, ErrorNotice, useConsole } from "./ui.tsx";

export function IncidentEditor({ incident }: { incident: IncidentView }) {
  const { services, bootstrap } = useConsole(), router = useRouter();
  const scope = { installationId: bootstrap.binding.installationId, principalId: bootstrap.session!.principalId };
  const busy = useRef(false);
  const [ready, setReady] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<unknown>();
  const [action, setAction] = useState<"ack" | "snooze">("ack"), [until, setUntil] = useState("");
  const [expected, setExpected] = useState(incident.revision), [receipt, setReceipt] = useState<IncidentOperation>();
  const [unsettled, setUnsettled] = useState<LocalOperation>(), [locator, setLocator] = useState<LocalOperation>();
  const writable = bootstrap.session!.capabilities.includes("incidents.write");
  function unresolved() {
    return localOperations(localStorage, scope).find(row => row.databaseId && row.target === incident.incidentRef && ["unknown", "awaiting-response"].includes(row.state));
  }
  useEffect(() => {
    const check = () => { try { setUnsettled(unresolved()); setReady(true); } catch (failure) { setError(failure); setReady(false); } };
    check(); window.addEventListener("storage", check); return () => window.removeEventListener("storage", check);
  }, [incident.incidentRef, scope.installationId, scope.principalId]);
  async function refresh() {
    if (busy.current) return;
    try { const current = await services.client(bootstrap.binding).incident(incident.incidentRef); setExpected(current.data.incident.revision); await router.invalidate(); }
    catch (failure) { setError(failure); }
  }
  async function recover() {
    if (!unsettled || busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const result = await services.client(bootstrap.binding).incidentOperation(unsettled.databaseId!, unsettled.requestId);
      markOperation(localStorage, unsettled, "succeeded"); setReceipt(result.data); setLocator(unsettled); setUnsettled(unresolved());
      await router.invalidate();
    } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy.current || !ready || unsettled || !writable) return;
    busy.current = true; setPending(true); setError(undefined); setReceipt(undefined);
    let row: LocalOperation | undefined;
    try {
      const pending = unresolved(); if (pending) { setUnsettled(pending); return; }
      const untilMs = new Date(until).getTime();
      if (action === "snooze" && !Number.isSafeInteger(untilMs)) throw new ManagementClientError("invalid_input", "请选择明确的暂缓截止时间。");
      const request = { requestId: crypto.randomUUID(), incidentRef: incident.incidentRef, expectedRevision: expected,
        ...(action === "ack" ? { action: "ack" as const } : { action: "snooze" as const, untilMs }) };
      const api = await services.prepareWrite(bootstrap.binding, scope.principalId);
      row = rememberOperation(localStorage, scope, request); setLocator(row); setUnsettled(row);
      const result = await api.changeIncident(request); markOperation(localStorage, row, "succeeded"); setUnsettled(undefined); setReceipt(result.data);
      void router.invalidate();
    } catch (failure) {
      if (row) {
        const refused = failure instanceof ManagementClientError && !!failure.reply && failure.code !== "operation_unknown";
        markOperation(localStorage, row, refused ? "refused" : "unknown"); if (refused) setUnsettled(undefined);
      }
      setError(failure);
    } finally { busy.current = false; setPending(false); }
  }
  return <Card title="处理异常"><p><Badge tone={incident.status === "resolved" ? "neutral" : "warn"}>{incident.status}</Badge> {incident.rule}</p>
    <code>{incident.incidentRef}</code><p className="field-note">此处记录已查看或暂缓，不修复 Bot、不改执行权限、不发送通知。草稿使用版本 {expected}，当前读取版本 {incident.revision}。</p>
    <ErrorNotice error={error}/>
    {unsettled && <div className="notice" role="status"><p>此异常存在未确认操作。先查询原回执，不创建替代请求。</p><code>{unsettled.requestId}</code><div className="actions"><button onClick={recover} disabled={pending}>查询原异常操作</button><Link to="/operations" search={operationSearch(unsettled)}>打开恢复记录</Link></div></div>}
    <form onSubmit={submit}><fieldset disabled={!writable || pending || !ready || !!unsettled || incident.status === "resolved"}>
      <legend>异常管理动作</legend><div className="radio-group"><label><input type="radio" name="incident-action" checked={action === "ack"} onChange={() => setAction("ack")}/>标记已查看</label><label><input type="radio" name="incident-action" checked={action === "snooze"} onChange={() => setAction("snooze")}/>暂缓提醒</label></div>
      {action === "snooze" && <><label htmlFor="incident-until">截止时间（本地时间）</label><input id="incident-until" type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} required/></>}
      <button className="primary" type="submit">{pending ? "提交中…" : "保存异常处理"}</button>
    </fieldset></form>
    <div className="actions"><button disabled={pending} onClick={refresh}>读取最新异常版本，保留草稿</button></div>
    {!writable && <p className="field-note">当前主体没有异常处理权限。</p>}
    {receipt && <div className="notice" role="status"><strong>异常管理已记录，未宣称修复</strong><p>历史版本 {receipt.beforeRevision} → {receipt.appliedRevision}。当前是否恢复由后续事实单独证明。</p></div>}
    {locator && <Link to="/operations" search={operationSearch(locator)}>查询异常操作回执</Link>}
  </Card>;
}
