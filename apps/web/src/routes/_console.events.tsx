import { useEffect, useState } from "react";
import { createFileRoute, Link, useRouter, useNavigate } from "@tanstack/react-router";
import type { ObservationEventPage, ObservationEvent } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime, useConsole } from "../components/ui.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";
import type { EventWatchState } from "../lib/event-watch.ts";

export const Route = createFileRoute("/_console/events")({
  validateSearch: (search: Record<string, unknown>): { cursor?: string; watch?: boolean } => ({ cursor: boundedSearch(search.cursor), watch: search.watch === true || search.watch === "true" ? true : undefined }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ context, deps }) => context.bootstrap.session!.capabilities.includes("observations.read")
    ? readView(context.services.client(context.bootstrap.binding).observationEvents({ limit: 50, cursor: deps.cursor })) : denied<ObservationEventPage>(),
  component: Events,
});
function Events() {
  const view = Route.useLoaderData(), search = Route.useSearch(), router = useRouter(), navigate = useNavigate({ from: Route.fullPath });
  const { services, bootstrap } = useConsole();
  const [recent, setRecent] = useState<{ rows: ObservationEvent[]; dropped: number }>({ rows: [], dropped: 0 });
  const [watch, setWatch] = useState<EventWatchState>(), [error, setError] = useState<unknown>();
  useEffect(() => {
    setRecent({ rows: view.data?.entries ?? [], dropped: 0 }); setWatch(undefined);
    if (!search.watch || !view.data) return;
    let cursor = view.data.cursor, stop: (() => void) | undefined, blocked = false, disposed = false;
    const start = () => {
      stop?.(); stop = undefined;
      if (document.hidden || blocked || disposed) return;
      stop = services.watchEvents(bootstrap.binding, bootstrap.session!.principalId, cursor, {
        page: page => {
          if (disposed) return;
          cursor = page.cursor;
          setRecent(current => {
            const ids = new Set(current.rows.map(row => row.eventId)), additions = page.entries.filter(row => !ids.has(row.eventId));
            const all = [...current.rows, ...additions];
            return { rows: all.slice(-100), dropped: current.dropped + Math.max(0, all.length - 100) };
          });
        },
        status: state => { if (!disposed) { blocked = state.state === "gap" || state.state === "stopped"; setWatch(state); } },
      });
    };
    const visibility = () => { if (document.hidden) { stop?.(); stop = undefined; setWatch({ state: "stopped", cursor }); } else start(); };
    start(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; stop?.(); document.removeEventListener("visibilitychange", visibility); };
  }, [search.watch, view.data?.cursor, bootstrap.binding.installationId, bootstrap.session!.principalId, services]);
  async function newSnapshot() {
    try { const snapshot = await services.client(bootstrap.binding).observation(); await navigate({ search: { cursor: snapshot.data.cursor, watch: true } }); setError(undefined); }
    catch (failure) { setError(failure); }
  }
  const rows = search.watch ? recent.rows : view.data?.entries ?? [];
  return <><Heading eyebrow="OBSERVED CHANGES" title="观察变化">读取已采集的变化，或从已验证游标订阅后续提交。断线只重连读取；代际与保留缺口需要重新获取快照。</Heading><Card>
    <div className="toolbar"><button onClick={() => { void router.invalidate(); }}>重新读取当前区间</button><Link to="/events" search={{}}>读取保留区间</Link><Link to="/observation">重新获取快照</Link>
      {view.data && <button onClick={() => { void navigate({ search: { ...search, watch: !search.watch || undefined } }); }}>{search.watch ? "停止订阅" : "开始订阅变化"}</button>}
    </div><ErrorNotice error={viewError(view)}/><ErrorNotice error={error}/>
    {search.watch && <div className="notice" role="status" data-testid="event-watch-status"><strong>{watch?.state ?? "connecting"}</strong><p>每个窗口有界，使用同一游标接续。关闭或隐藏页面会停止本页订阅，不会停止后台采集。</p>{watch && <code>{watch.cursor}</code>}</div>}
    <ErrorNotice error={watch?.error}/>{watch?.state === "gap" && <button onClick={newSnapshot}>从新快照重新接续</button>}
    {view.data && <>{view.data.gap && <div className="notice" role="status"><strong>历史覆盖存在缺口</strong><p>更早变化已超出可接续保留范围；没有补造缺失历史。</p></div>}
      {search.watch && recent.dropped > 0 && <p className="field-note">本页只保留最近 100 条；已移出当前展示 {recent.dropped} 条。原历史仍按后台保留策略查询。</p>}
      <div className="table-wrap"><table><thead><tr><th>序号 / 变化</th><th>对象</th><th>观察时间</th><th>声明变化</th></tr></thead><tbody>{rows.map(row => <tr key={row.eventId}><td><small className="muted">#{row.seq}</small><strong className="block">{row.kind}</strong><code>{row.eventId}</code></td><td>{row.agentId ? <Link to="/bots/$botId" params={{ botId: row.agentId }}><code>{row.agentId}</code></Link> : "采集器 / 共享来源"}{row.incidentRef && <small className="block"><Link to="/incidents" search={{ selected: row.incidentRef }}>查看关联异常</Link></small>}</td><td><SourceTime at={row.observedAtMs}/>{row.observationIntervalStartMs !== null && <small className="block muted">发现区间起点 <SourceTime at={row.observationIntervalStartMs}/></small>}</td><td><Badge>{row.previousHarness ?? "unknown"} → {row.currentHarness ?? "unknown"}</Badge></td></tr>)}</tbody></table></div>
      {!rows.length && <Empty>该游标之后暂未记录新变化；不证明上游没有变化。</Empty>}
      <div className="pagination"><span className="muted">保留边界 {view.data.retentionFloor} · {view.data.hasMore ? "仍有后续页" : "当前已读到已保存区间末尾"}</span><Link className="button" to="/events" search={{ cursor: watch?.cursor ?? view.data.cursor }}>{view.data.hasMore ? "继续读取下一页 →" : "从当前游标继续读取 →"}</Link></div>
    </>}
  </Card></>;
}
