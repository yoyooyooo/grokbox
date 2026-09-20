import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { IncidentList, IncidentDetail } from "@grokbox/client";
import { IncidentEditor } from "../components/incident-editor.tsx";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/incidents")({
  validateSearch: (search: Record<string, unknown>): { cursor?: string; selected?: string } => ({ cursor: boundedSearch(search.cursor), selected: boundedSearch(search.selected) }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (!context.bootstrap.session!.capabilities.includes("observations.read")) return { list: denied<IncidentList>(), detail: deps.selected ? denied<IncidentDetail>() : null };
    const api = context.services.client(context.bootstrap.binding);
    const [list, detail] = await Promise.all([readView(api.incidents({ limit: 25, cursor: deps.cursor })), deps.selected ? readView(api.incident(deps.selected)) : null]);
    return { list, detail };
  },
  component: Incidents,
});
function Incidents() {
  const { list: view, detail } = Route.useLoaderData(), search = Route.useSearch(), router = useRouter();
  return <><Heading eyebrow="RETAINED INCIDENTS" title="持久异常">这是观察域保存的异常，不是原生告警托盘。已查看、暂缓与实际恢复分别记录。</Heading><Card>
    <div className="toolbar"><button onClick={() => { void router.invalidate(); }}>重新读取异常</button><Link to="/incidents" search={{}}>返回异常首页</Link><Link to="/observation">来源与新鲜度</Link></div><ErrorNotice error={viewError(view)}/>
    {view.data && <><div className="table-wrap"><table><thead><tr><th>规则 / 对象</th><th>事实状态</th><th>处理记录</th><th>发现 / 最近观察</th></tr></thead><tbody>{view.data.incidents.map(row => <tr key={row.id}><td><strong>{row.rule}</strong><small className="block">{row.agentId ? <Link to="/bots/$botId" params={{ botId: row.agentId }}><code>{row.agentId}</code></Link> : "安装或共享来源"}</small><details><summary>异常引用 · revision {row.revision}</summary><code>{row.incidentRef}</code></details><Link to="/incidents" search={{ ...search, selected: row.incidentRef }}>处理此异常</Link></td><td><Badge tone={row.status === "resolved" ? "neutral" : "warn"}>{row.status}</Badge>{row.resolvedAtMs !== null && <small className="block"><SourceTime at={row.resolvedAtMs}/></small>}</td><td>{row.acknowledged ? "已查看，不代表修复" : "尚未确认查看"}{row.snoozeUntilMs !== null && <small className="block">暂缓截止 <SourceTime at={row.snoozeUntilMs}/></small>}</td><td><SourceTime at={row.firstSeenAtMs}/><small className="block muted"><SourceTime at={row.lastSeenAtMs}/></small></td></tr>)}</tbody></table></div>
      {!view.data.incidents.length && <Empty>当前保留范围没有异常记录；这不证明全系统健康或采集完整。</Empty>}
      <div className="pagination"><span className="muted">处理经共享管理用例提交。冲突保留草稿，未知结果先查询原回执。</span>{view.data.nextCursor && <Link className="button" to="/incidents" search={{ cursor: view.data.nextCursor }}>下一页 →</Link>}</div>
    </>}
  </Card>{detail && <ErrorNotice error={viewError(detail)}/>} {detail?.data && <IncidentEditor key={detail.data.incident.incidentRef} incident={detail.data.incident}/>}</>;
}
