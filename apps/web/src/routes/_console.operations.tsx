import { useEffect, useState, type FormEvent } from "react";
import type { FileOperation, JobView, JobCancelReceipt, HandoverOperation } from "@grokbox/client";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { contextOperationRef, type CompactionOperation, type ContextOperation, UUID, type ModelOperation, type IncidentOperation, type ReceiverOperation, type NotificationSendOperation, type NotificationTestOperation, type SetupOperation, type MaterialOperation, type ProtectionOperation } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime, useConsole } from "../components/ui.tsx";
import { fileLocalState, jobLocalState, contextLocalState, compactionLocalState, handoverLocalState, forgetSettledOperation, localOperations, markOperation, operationSearch, operationDomain, type LocalOperation, type OperationDomain } from "../lib/operations.ts";
import { readView, viewError } from "../lib/views.ts";

type Receipt = FileOperation | JobView | JobCancelReceipt | HandoverOperation | CompactionOperation | ModelOperation | IncidentOperation | ReceiverOperation | NotificationSendOperation | NotificationTestOperation | SetupOperation | MaterialOperation | ProtectionOperation | ContextOperation;
type Search = { requestId?: string; domain?: Exclude<OperationDomain, "model">; databaseId?: string; bot?: string; target?: string; scopeId?: string };
export const Route = createFileRoute("/_console/operations")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    requestId: typeof search.requestId === "string" && UUID.test(search.requestId) ? search.requestId.toLowerCase() : undefined,
    domain: ["file", "job", "job-cancel", "handover", "compaction", "context", "protection", "material", "incident", "receiver", "notification", "notification-test", "notification-settings", "routine", "pairing"].includes(String(search.domain)) ? search.domain as Search["domain"] : undefined,
    scopeId: typeof search.scopeId === "string" && /^[a-f0-9]{64}$/.test(search.scopeId) ? search.scopeId : undefined,
    target: typeof search.target === "string" && search.target.length<=160 ? search.target : undefined,
    bot: typeof search.bot === "string" && UUID.test(search.bot) ? search.bot.toLowerCase() : undefined,
    databaseId: typeof search.databaseId === "string" && UUID.test(search.databaseId) ? search.databaseId.toLowerCase() : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    if (!deps.requestId) return null;
    const client = context.services.client(context.bootstrap.binding);
    return readView<Receipt>(deps.domain === "file" ? client.fileOperation(deps.requestId) : deps.domain === "job" ? client.jobOperation(deps.requestId) : deps.domain === "job-cancel" ? client.jobCancellation(deps.target ?? "",deps.requestId) : deps.domain === "handover" ? Promise.resolve().then(() => client.handoverOperation(deps.scopeId ?? "", deps.requestId!)) : deps.domain === "compaction" ? Promise.resolve().then(() => client.compactionOperation(deps.scopeId ?? "", deps.requestId!)) : deps.domain === "context" ? Promise.resolve().then(() => client.contextOperation(contextOperationRef(context.bootstrap.binding.installationId, deps.scopeId ?? "", deps.requestId!))) : deps.domain === "protection" ? client.protectionOperation(deps.target??"",deps.requestId) : deps.domain === "material" ? client.materialOperation(deps.requestId) : deps.domain === "routine" ? client.setupOperation("routine",deps.bot ?? "",deps.requestId)
      : deps.domain === "notification-settings" || deps.domain === "pairing" ? client.setupOperation(deps.domain === "pairing" ? "pairing" : "settings","installation",deps.requestId)
      : deps.domain === "incident" ? client.incidentOperation(deps.databaseId ?? "", deps.requestId)
      : deps.domain === "receiver" ? client.receiverOperation(deps.databaseId ?? "", deps.requestId)
      : deps.domain === "notification" ? client.notificationSendOperation(deps.databaseId ?? "", deps.requestId)
      : deps.domain === "notification-test" ? client.notificationTestOperation(deps.databaseId ?? "", deps.requestId)
      : client.modelOperation(deps.requestId));
  },
  component: Operations,
});
function receiptDomain(data: Receipt): OperationDomain {
  if ("serviceGeneration" in data) return "file";
  if ("jobRef" in data) return "job" in data ? "job-cancel" : "job";
  if ("notificationRef" in data) return "notification";
  if ("handoverRef" in data) return "handover";
  if ("nativeSettlement" in data) return "compaction";
  if ("sourceBodyIncluded" in data) return "context";
  if ("nativeEffectsPerformed" in data) return "protection";
  if ("sourceWrite" in data) return "material";
  if ("kind" in data) return data.kind === "settings" ? "notification-settings" : data.kind;
  return "receiverRef" in data ? data.action === "test" ? "notification-test" : "receiver" : "databaseId" in data ? "incident" : "model";
}
function receiptTarget(data: Receipt): string {
  if ("serviceGeneration" in data) return data.ref;
  if ("jobRef" in data) return "job" in data ? data.jobRef : `job-request:${data.jobRef.split(":")[1]}:${data.requestId}`;
  if ("notificationRef" in data) return data.notificationRef;
  if ("handoverRef" in data) return data.handoverRef;
  if ("nativeSettlement" in data) return data.botRef;
  if ("sourceBodyIncluded" in data) return data.botRef;
  if ("sourceWrite" in data) return data.ref;
  if ("targetRef" in data) return data.targetRef;
  return "receiverRef" in data ? data.receiverRef : "incidentRef" in data ? data.incidentRef : data.target;
}
function ReceiptFacts({ data }: { data: Receipt }) {
  if ("serviceGeneration" in data) return <><dt>Original source</dt><dd><code>{data.ref}</code></dd><dt>Action / result</dt><dd>{data.action} / {data.state}</dd><dt>Published revision</dt><dd><code>{data.result?.revision ?? "Not recorded"}</code></dd><dt>Recovery</dt><dd><Link to="/files" search={{requestId:data.requestId}}>Inspect original file controls</Link></dd><dt>Meaning</dt><dd>This is the original source publication, not index adoption or an external-writer transaction. An unknown effect is never repeated by reading its receipt.</dd></>;
  if ("jobRef" in data) { const job = "job" in data ? data.job : data; return <><dt>Original Job</dt><dd><code>{job.jobRef}</code></dd><dt>Execution observation</dt><dd>{job.state} · {job.observation}</dd><dt>Command</dt><dd>{job.command.executable} · {job.command.argumentCount} arguments</dd><dt>Exit / reason</dt><dd>{job.exitCode ?? job.signal ?? "Not observed"} · {job.reason ?? "None recorded"}</dd><dt>Meaning</dt><dd>Admission, process exit and cancellation are separate. External effects are not reverted; unknown work is never relaunched by this read.</dd><dt>Inspect</dt><dd><Link to="/jobs" search={{selected:job.jobRef}}>Inspect original Job</Link></dd></>; }
  if ("notificationRef" in data) return <><dt>Original incident work</dt><dd><Link to="/notifications" search={{ delivery: data.notificationRef }}><code>{data.notificationRef}</code></Link></dd><dt>Exact receiver</dt><dd><code>{data.receiverRef}</code></dd><dt>Attempt / refusal</dt><dd>{data.attempt?.state ?? data.reason ?? "No verified attempt"}</dd><dt>Reviewed binding revision</dt><dd>{data.expectedRevision}</dd><dt>Meaning</dt><dd>This original send did not enable automatic delivery. Native acceptance is not a Bot report or user read; reading an unknown receipt does not dispatch again.</dd></>;
  if ("handoverRef" in data) return <><dt>Original replacement</dt><dd><code>{data.handoverRef}</code></dd><dt>Action and reviewed revision</dt><dd>{data.action} · <code>{data.expectedRevision}</code></dd><dt>Batch result</dt><dd>{data.result?.outcome ?? "Not settled"}</dd><dt>Remaining / unknown duties</dt><dd>{data.result ? `${data.result.remaining} / ${data.result.unknown}` : "Not recorded"}</dd><dt>Native deletion</dt><dd>{data.result?.sourceDeleted ? "Original deletion receipt retained" : "Not performed by this operation"}</dd><dt>Meaning</dt><dd>A completed batch is not complete duty coverage or current retirement authority. Reading does not resend an unknown effect.</dd><dt>Original controls</dt><dd><Link to="/protection" search={{handover:data.handoverRef,handoverOperation:data.operationRef}}>Inspect original handover controls</Link></dd></>;
  if ("nativeSettlement" in data) return <><dt>Compaction target</dt><dd><code>{data.botRef}</code></dd><dt>Native settlement / failure</dt><dd>{data.nativeSettlement} / {data.failureCode ?? "none recorded"}</dd><dt>Approved revision</dt><dd><code>{data.expectedRevision}</code></dd>{data.result && <><dt>Historical result</dt><dd>{data.result.outcome} · {data.result.beforeTokens} → {data.result.afterTokens} tokens · {data.result.summaryRequests} summary calls</dd></>}<dt>Meaning</dt><dd>The original native shell settled, not a new task or proof of the present model window. An unknown dispatch is never replayed by reading this history.</dd></>;
  if ("sourceBodyIncluded" in data) return <><dt>Context target</dt><dd><code>{data.botRef}</code></dd><dt>Original action / revision</dt><dd>{data.action} · <code>{data.expectedRevision}</code></dd><dt>Application / activation</dt><dd>{data.application} / {data.activation}</dd><dt>Meaning</dt><dd>Historical CONT evidence only. Prepared is not released, release starts no task, and unknown effects are never replayed by reading this receipt.</dd></>;
  if ("nativeEffectsPerformed" in data) return <><dt>Protection target</dt><dd><code>{data.targetRef}</code></dd><dt>Historical revision</dt><dd><code>{data.beforeRevision} → {data.revision??"unverified"}</code></dd><dt>Meaning</dt><dd>This historical configuration receipt does not prove that a worker adopted it or that a native effect happened. Reading it cannot restore an old permission.</dd></>;
  if ("sourceWrite" in data) return <><dt>Source document</dt><dd><code>{data.ref}</code></dd><dt>Evidence</dt><dd>{data.evidence}</dd><dt>Historical revisions</dt><dd><code>{data.beforeRevision} → {data.afterRevision ?? "unverified"}</code></dd><dt>Meaning</dt><dd>A source text replacement. Index adoption is observed separately; other writers do not participate in an atomic compare-and-swap.</dd></>;
  if ("kind" in data) return <><dt>Setup action</dt><dd>{data.action} · <code>{data.targetRef}</code></dd><dt>Evidence</dt><dd>{data.evidence}</dd><dt>Recorded revision</dt><dd><code>{data.beforeRevision ?? "none"} → {data.revision ?? "unverified"}</code></dd>{data.resultRef && <><dt>Result reference</dt><dd><code>{data.resultRef}</code></dd></>}<dt>Boundary</dt><dd>This action did not grant automatic notification permission or invoke a webhook. Native readback is not compare-and-swap or historical attribution.</dd></>;
  if ("receiverRef" in data) return data.action === "test"
    ? <><dt>Test target</dt><dd><code>{data.receiverRef}</code></dd><dt>Delivery record</dt><dd><code>{data.delivery.notificationRef}</code></dd>
      <dt>Attempt</dt><dd>{data.delivery.attempt?.state ?? "not-attempted"}</dd><dt>Meaning</dt><dd>An independently requested test, not an incident or consent to enable. Native acceptance does not prove a Bot report or user read.</dd></>
    : <><dt>Receiver action</dt><dd>{data.action} · <code>{data.receiverRef}</code></dd><dt>Recorded revision</dt><dd>{data.beforeRevision} → {data.appliedRevision}</dd>
      <dt>Recorded at</dt><dd><SourceTime at={data.appliedAtMs}/></dd><dt>Meaning</dt><dd>A historical local consent change. It sent no notification and does not prove that permission is still active.</dd></>;
  return "databaseId" in data
    ? <><dt>动作 / 目标</dt><dd>{data.action} · <code>{data.incidentRef}</code></dd><dt>历史版本</dt><dd>{data.beforeRevision} → {data.appliedRevision}</dd><dt>含义</dt><dd>已查看或暂缓已记录，不代表异常恢复、通知送达或 Bot 已修复。</dd></>
    : <><dt>动作 / 目标</dt><dd>{data.command} · {data.target}</dd><dt>接受时刻</dt><dd>{data.acceptedAt}</dd><dt>提交版本</dt><dd><code>{data.configRevision}</code></dd><dt>实际采用</dt><dd>后续轮次采用；当前轮次保持不变。此回执不是实际执行观察。</dd></>;
}
function Operations() {
  const receipt = Route.useLoaderData(), search = Route.useSearch(), { bootstrap } = useConsole();
  const navigate = useNavigate({ from: Route.fullPath }), router = useRouter();
  const [id, setId] = useState(search.requestId ?? ""), [domain, setDomain] = useState<OperationDomain>(search.domain ?? "model"), [database, setDatabase] = useState(search.databaseId ?? ""), [bot,setBot] = useState(search.bot ?? ""), [target,setTarget]=useState(search.target??"");
  const [accountScope, setAccountScope] = useState(search.scopeId ?? "");
  const [rows, setRows] = useState<LocalOperation[]>(), [storageError, setStorageError] = useState(false);
  const scope = { installationId: bootstrap.binding.installationId, principalId: bootstrap.session!.principalId };
  function reloadLocal() { try { setRows(localOperations(localStorage, scope)); setStorageError(false); } catch { setStorageError(true); } }
  useEffect(() => {
    setAccountScope(search.scopeId ?? ""); setId(search.requestId ?? ""); setDomain(search.domain ?? "model"); setDatabase(search.databaseId ?? ""); setBot(search.bot ?? ""); setTarget(search.target??"");
    try {
      const data = receipt?.data;
      const row = localOperations(localStorage, scope).find(item => data && item.requestId === data.requestId
        && operationDomain(item) === receiptDomain(data) && item.target === receiptTarget(data)
        && (["context-control", "context-compaction", "handover-control"].includes(item.command) ? item.contextScope === search.scopeId : item.setupKind ? item.setupScope === (item.setupKind === "routine" ? search.bot : "installation")
          : receiptDomain(data) === "model" ? !item.databaseId : item.databaseId === search.databaseId));
      if (row && data) markOperation(localStorage, row, "serviceGeneration" in data ? fileLocalState(data.state) : "jobRef" in data ? "job" in data ? data.state === "unknown" ? "unknown" : "recorded" : jobLocalState(data.state) : "handoverRef" in data ? handoverLocalState(data.state) : "nativeSettlement" in data ? compactionLocalState(data.state) : "sourceBodyIncluded" in data ? contextLocalState(data.state) : data.state);
    } catch { setStorageError(true); }
    reloadLocal(); window.addEventListener("storage", reloadLocal);
    return () => window.removeEventListener("storage", reloadLocal);
  }, [search.requestId, search.domain, search.databaseId, search.bot, search.target, search.scopeId, receipt, scope.installationId, scope.principalId]);
  function lookup(event: FormEvent) {
    event.preventDefault(); if (!UUID.test(id.trim()) || ["incident","receiver","notification","notification-test"].includes(domain) && !UUID.test(database.trim()) || domain === "routine" && !UUID.test(bot.trim()) || ["context", "compaction", "handover"].includes(domain) && !/^[a-f0-9]{64}$/.test(accountScope.trim())) return;
    void navigate({ search: { requestId: id.trim().toLowerCase(), ...(["context", "compaction", "handover"].includes(domain) ? { scopeId: accountScope.trim() } : {}), ...(domain !== "model" ? { domain } : {}),
      ...(["incident","receiver","notification","notification-test"].includes(domain) ? { databaseId:database.trim().toLowerCase() } : {}), ...(domain === "routine" ? { bot:bot.trim().toLowerCase() } : {}), ...(["protection","job-cancel"].includes(domain)?{target:target.trim()}:{}) } });
  }
  const data = receipt?.data;
  const title = data ? "serviceGeneration" in data ? "Original file operation" : "jobRef" in data ? "job" in data ? "Original cancellation receipt" : "Original Job receipt" : "notificationRef" in data ? "Original incident delivery receipt" : "handoverRef" in data ? "Original handover operation" : "nativeSettlement" in data ? "Compaction operation receipt" : "sourceBodyIncluded" in data ? "Current context operation" : "nativeEffectsPerformed" in data ? "Protection policy receipt" : "sourceWrite" in data ? "Source operation receipt" : "kind" in data ? "Setup operation receipt" : "receiverRef" in data ? data.action === "test" ? "Independent test receipt" : "Receiver consent recorded"
    : "databaseId" in data ? "异常管理已记录" : data.state === "succeeded" ? "配置提交已确认" : "操作结果仍待查证" : "";
  return <><Heading eyebrow="COMMIT ≠ EXECUTION" title="操作回执">使用原 request-id 与领域定位查询。异常、接收者及测试回执还需原数据库身份；未知结果只查证，不自动重放。</Heading>
    <Card title="查找原操作"><form onSubmit={lookup}><div className="toolbar"><label htmlFor="operation-domain">领域</label><select id="operation-domain" value={domain} onChange={event => setDomain(event.target.value as OperationDomain)}><option value="model">模型配置</option><option value="file">Source file publication</option><option value="job">Job execution</option><option value="job-cancel">Job cancellation</option><option value="context">Current context</option><option value="compaction">Compaction</option><option value="handover">Handover</option><option value="protection">Protection policy</option><option value="material">Source document</option><option value="incident">异常管理</option><option value="receiver">Receiver consent</option><option value="notification">Incident notification delivery</option><option value="notification-test">Independent notification test</option><option value="notification-settings">Notification settings</option><option value="routine">Routine setup</option><option value="pairing">Private pairing</option></select></div>
      {["context", "compaction", "handover"].includes(domain) && <><label htmlFor="operation-scope">Original account scope</label><input id="operation-scope" value={accountScope} onChange={event => setAccountScope(event.target.value)} required maxLength={64}/></>}
      {(domain === "protection" || domain === "job-cancel") && <><label htmlFor="operation-target">Original target: Job reference, or protection Bot/system</label><input id="operation-target" value={target} onChange={event=>setTarget(event.target.value)} required maxLength={160}/></>}
      {domain === "routine" && <><label htmlFor="operation-bot">Original Bot UUID</label><input id="operation-bot" value={bot} onChange={event=>setBot(event.target.value)} required maxLength={36}/></>}
      {["incident","receiver","notification","notification-test"].includes(domain) && <><label htmlFor="operation-database">原数据库 UUID</label><input id="operation-database" value={database} onChange={event => setDatabase(event.target.value)} required maxLength={36} spellCheck={false}/></>}
      <div className="toolbar"><label htmlFor="operation-id">Request UUID</label><input id="operation-id" value={id} onChange={event => setId(event.target.value)} maxLength={36} required pattern="[0-9a-fA-F-]{36}" spellCheck={false}/><button className="primary" type="submit">查询回执</button>{search.requestId && <button type="button" onClick={() => router.invalidate()}>重新读取，不重发</button>}</div></form>
      {receipt && <ErrorNotice error={viewError(receipt)}/>} {receipt?.error?.code === "not_found" && <p className="notice">未查到回执不能证明效果没有发生。请核对原安装、主体、数据库和请求标识，不要创建新请求来“补成功”。</p>}
      {data && <div className="receipt" data-testid="operation-receipt"><Badge tone={data.state === "unknown" ? "warn" : "info"}>{data.state}</Badge><h3>{title}</h3><dl>
        <dt>操作引用</dt><dd><code>{"operationRef" in data ? data.operationRef : data.jobRef}</code></dd><dt>请求标识</dt><dd><code>{data.requestId}</code></dd><ReceiptFacts data={data}/></dl></div>}
    </Card><Card title="本浏览器保存的定位记录"><p className="muted">只属于当前安装和主体，不是全局操作历史。只保存定位元数据，不保存秘密、完整输入或暂缓策略。</p>
      {storageError && <p className="notice danger" role="alert">本地恢复记录无法读取。未丢弃记录，也不会绕过此问题提交新操作。</p>}
      {!rows ? <Empty>正在读取本地定位信息…</Empty> : !rows.length ? <Empty>本浏览器尚无此主体的提交记录。也可以直接输入其他入口保存的定位信息。</Empty> : <div className="table-wrap"><table><thead><tr><th>请求与动作</th><th>目标</th><th>本地标记</th><th>保留</th></tr></thead><tbody>{rows.map(row => <tr key={row.requestId}><td><Link to="/operations" search={operationSearch(row)}><code>{row.requestId}</code></Link><small className="block muted">{row.command} · <SourceTime at={row.createdAt}/></small></td><td><code>{row.target}</code></td><td><Badge tone={row.state === "unknown" || row.state === "awaiting-response" ? "warn" : "neutral"}>{row.state}</Badge></td><td>{["recorded", "succeeded", "refused", "retired"].includes(row.state) ? <button className="quiet" onClick={() => { forgetSettledOperation(localStorage, row); reloadLocal(); }}>移除本地定位</button> : "未知记录保留"}</td></tr>)}</tbody></table></div>}
    </Card></>;
}
