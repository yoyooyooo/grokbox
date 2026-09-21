import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { NotificationWorkerView, ReceiverList, ReceiverView, NotificationList, NotificationView } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { ReceiverEditor } from "../components/receiver-editor.tsx";
import { NotificationSender } from "../components/notification-sender.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/notifications")({
  validateSearch: (search: Record<string, unknown>): { selected?: string; cursor?: string; delivery?: string } => ({
    selected: boundedSearch(search.selected, 160), cursor: boundedSearch(search.cursor, 128), delivery: boundedSearch(search.delivery, 160),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (!context.bootstrap.session!.capabilities.includes("notifications.read")) return {
      worker: denied<NotificationWorkerView>(), receivers: denied<ReceiverList>(), deliveries: denied<NotificationList>(),
      selected: deps.selected ? denied<ReceiverView>() : null, delivery: deps.delivery ? denied<NotificationView>() : null,
    };
    const client = context.services.client(context.bootstrap.binding);
    const [worker, receivers, deliveries, selected, delivery] = await Promise.all([
      readView(client.notificationWorker()), readView(client.receivers()), readView(client.notifications({ limit: 20, cursor: deps.cursor })),
      deps.selected ? readView(client.receiver(deps.selected)) : null, deps.delivery ? readView(client.notification(deps.delivery)) : null,
    ]);
    return { worker, receivers, deliveries, selected, delivery };
  },
  component: Notifications,
});
function Notifications() {
  const data = Route.useLoaderData(), search = Route.useSearch(), router = useRouter(), worker = data.worker.data;
  if (data.worker.error?.code === "permission_denied" && data.receivers.error?.code === "permission_denied" && data.deliveries.error?.code === "permission_denied") {
    return <><Heading eyebrow="BACKGROUND NOTIFICATIONS" title="通知后台">Notification read access is required for this installation.</Heading><ErrorNotice error={viewError(data.worker)}/></>;
  }
  return <><Heading eyebrow="BACKGROUND NOTIFICATIONS" title="通知后台">通知 worker 随管理服务运行。打开、刷新或关闭此页面都不创建投递，也不改变已有授权。</Heading>
    <p><Link className="button" to="/notification-setup" search={{}}>Set up a notification receiver →</Link></p>
    <Card title="Receivers"><ErrorNotice error={viewError(data.receivers)}/>
      {data.receivers.data && (!data.receivers.data.receivers.length ? <Empty>No local receiver bindings. Configure and bind a managed native Routine through the explicit setup path; viewing this page does not create credentials.</Empty>
        : <div className="table-wrap"><table><thead><tr><th>Receiver</th><th>Binding</th><th>Future delivery</th><th>Revision</th></tr></thead><tbody>{data.receivers.data.receivers.map(receiver => <tr key={receiver.bindingId}><td><Link to="/notifications" search={{ ...search, selected: receiver.receiverRef }}>{receiver.alias}</Link><small className="block muted">{receiver.routineId}</small></td><td><Badge>{receiver.state}</Badge></td><td>{receiver.automatic ? "explicitly enabled; fresh checks still required" : "not enabled"}</td><td>{receiver.revision}</td></tr>)}</tbody></table></div>)}
      <p className="field-note">Enable records consent without sending. Test is independent and optional. Stored credentials and a running worker do not by themselves authorize delivery.</p>
    </Card>
    {data.selected && <ErrorNotice error={viewError(data.selected)}/>}{data.selected?.data && <ReceiverEditor key={data.selected.data.receiverRef} receiver={data.selected.data}/>}
    <Card title="Retained deliveries"><ErrorNotice error={viewError(data.deliveries)}/>
      {data.deliveries.data && <><p className="field-note">Incident notices and explicit tests are separate work types. This is retained history, not complete upstream delivery or user-read evidence.</p>
        {!data.deliveries.data.notifications.length ? <Empty>No retained notification work in this database.</Empty> : <div className="table-wrap"><table><thead><tr><th>Work</th><th>Purpose</th><th>Recorded state</th><th>Attempt</th><th>Created</th></tr></thead><tbody>{data.deliveries.data.notifications.map(item => <tr key={item.workId}><td><Link to="/notifications" search={{ ...search, delivery: item.notificationRef }}><code>{item.workId}</code></Link></td><td>{item.purpose}</td><td><Badge tone={item.state === "unknown" ? "warn" : "neutral"}>{item.state}</Badge></td><td>{item.attempt?.state ?? "not-attempted"}</td><td><SourceTime at={item.createdAtMs}/></td></tr>)}</tbody></table></div>}
        <div className="pagination"><button onClick={() => router.invalidate()}>Refresh deliveries</button>{data.deliveries.data.nextCursor && <Link to="/notifications" search={{ ...search, cursor: data.deliveries.data.nextCursor }}>Next deliveries →</Link>}</div></>}
    </Card>
    {data.delivery && <ErrorNotice error={viewError(data.delivery)}/>}{data.delivery?.data && <Card title="Delivery receipt"><div data-testid="notification-delivery"><dl>
      <dt>Reference</dt><dd><code>{data.delivery.data.notificationRef}</code></dd><dt>Purpose</dt><dd>{data.delivery.data.purpose}</dd><dt>Incident</dt><dd>{data.delivery.data.incidentRef ? <code>{data.delivery.data.incidentRef}</code> : "none — an explicit test"}</dd>
      <dt>Recorded state</dt><dd>{data.delivery.data.state}</dd><dt>Attempt</dt><dd>{data.delivery.data.attempt?.state ?? "not-attempted"}</dd><dt>Bot report / user read</dt><dd>not_observed / not_observed</dd>
      <dt>Original identity</dt><dd><code>{data.delivery.data.attempt?.attemptId ?? data.delivery.data.workId}</code></dd></dl><p>No automatic retry is performed. Unknown is not failure-to-send, and native acceptance is not task completion.</p></div></Card>}
    {data.delivery?.data?.purpose === "incident" && <NotificationSender key={data.delivery.data.notificationRef} delivery={data.delivery.data} receivers={data.receivers.data?.receivers ?? []}/>}
    <Card title="投递进程"><div className="toolbar"><button onClick={() => { void router.invalidate(); }}>读取通知状态</button></div><ErrorNotice error={viewError(data.worker)}/>
      {worker && <div data-testid="notification-worker"><dl><dt>进程归属</dt><dd>{worker.owner}</dd><dt>工作状态</dt><dd><Badge>{worker.state}</Badge></dd>
        <dt>已完成检查轮数</dt><dd>{worker.cycles}</dd><dt>最近检查</dt><dd>{worker.lastCycleAtMs ? <SourceTime at={worker.lastCycleAtMs}/> : "尚未观察"}</dd>
        <dt>当前等待间隔</dt><dd>{worker.nextDelayMs} 毫秒</dd><dt>最近资格结果</dt><dd>{worker.lastCycle ? <><Badge tone={worker.lastCycle.state === "blocked" || worker.lastCycle.state === "unavailable" ? "warn" : "neutral"}>{worker.lastCycle.state}</Badge> <code>{worker.lastCycle.reason}</code></> : "尚未检查"}</dd>
        <dt>最近尝试结果</dt><dd>{worker.lastCycle?.outcome ?? "没有本轮投递证据"}</dd></dl>
        <p className="field-note">waiting 只说明 worker 等待下一轮检查，不等于通知已启用。缺配置、未授权、来源失效与无新工作分别保留原因。</p>
        <div className="notice"><strong>接收、执行、阅读是不同结果</strong><p>native-accepted 只代表原生入口受理。Bot 报告和用户已读仍为 not_observed；unknown 不会自动重发。进程存活不证明开机安装或完整通知资格。</p></div>
      </div>}
    </Card></>;
}
