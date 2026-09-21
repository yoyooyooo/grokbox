import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { ObservationSnapshot } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/observation")({
  loader: async ({ context }) => {
    const capabilities = context.bootstrap.session!.capabilities, client = context.services.client(context.bootstrap.binding);
    const [snapshot, service] = await Promise.all([
      capabilities.includes("observations.read") ? readView(client.observation()) : denied<ObservationSnapshot>(),
      capabilities.includes("system.read") ? readView(client.service()) : null,
    ]);
    return { snapshot, service };
  },
  component: Observation,
});
function Observation() {
  const loaded = Route.useLoaderData(), view = loaded.snapshot, router = useRouter(), snapshot = view.data;
  const service = loaded.service?.data;
  return <><Heading eyebrow="PERSISTED OBSERVATION" title="持续观察">读取后台已经保存的事实；刷新只重读本地观察，不启动采集、不查询原生服务，也不授予执行资格。</Heading>
    {loaded.service && <Card title="管理服务与后台采集"><ErrorNotice error={viewError(loaded.service)}/>{service && <><p>管理进程 <Badge>{service.state}</Badge> · 采集器 <Badge tone={service.observation.state === "running" ? "info" : "warn"}>{service.observation.state}</Badge></p><p className="muted">归属 management-server · 目标 {service.observation.targets} 个 · 替换次数 {service.observation.replacements}</p>{service.observation.reason && <p>当前原因 <code>{service.observation.reason}</code></p>}<p className="muted">采集器随管理服务启动和关闭；仅消费显式配置，不自动初始化数据库、启用通知或采用 Host。这不是开机安装资格。</p></>}</Card>}
    <Card><div className="toolbar"><button onClick={() => { void router.invalidate(); }}>重新读取观察</button><Link to="/incidents" search={{}}>查看持久异常</Link></div><ErrorNotice error={viewError(view)}/>
      {snapshot && <><dl className="facts"><div><dt>采集器记录</dt><dd><Badge tone={snapshot.collector.recordedRunning ? "info" : "warn"}>{snapshot.collector.recordedRunning ? "记录为运行中 · 未探测进程" : "记录为已停止"}</Badge></dd></div>
        <div><dt>最后心跳</dt><dd>{snapshot.collector.lastHeartbeatMs === null ? "尚无记录" : <SourceTime at={snapshot.collector.lastHeartbeatMs}/>}</dd></div>
        <div><dt>本次读取</dt><dd><SourceTime at={snapshot.readAtMs}/></dd></div><div><dt>存储版本</dt><dd>{snapshot.storage.schemaVersion}</dd></div></dl>
        <p className="notice">仅覆盖已登记观察的 {snapshot.agents.length} 个 Bot。记录为运行中不证明进程存活，新读取时间不代表来源刚刚更新。</p>
        <div className="table-wrap"><table><thead><tr><th>Bot 原生身份</th><th>最后确认状态</th><th>Server / 本地声明</th><th>新鲜度</th><th>最后成功观察</th></tr></thead><tbody>{snapshot.agents.map(row => <tr key={row.agentId}><td><Link to="/bots/$botId" params={{ botId: row.agentId }}><code>{row.agentId}</code></Link></td><td>{row.lastKnown?.state ?? "unknown"}</td><td>{row.lastKnown ? `${row.lastKnown.serverHarness ?? "unknown"} / ${row.lastKnown.localHarness ?? "unknown"}` : "unknown"}</td><td><Badge tone={row.freshness === "fresh" ? "info" : "warn"}>{row.freshness}</Badge></td><td>{row.lastSuccessMs === null ? "未观察到" : <SourceTime at={row.lastSuccessMs}/>}</td></tr>)}</tbody></table></div>
        {!snapshot.agents.length && <Empty>观察库尚无已登记对象；不表示原生 Bot 列表为空。</Empty>}
        <div className="pagination"><span>快照与游标来自同一个读取事务。</span><Link className="button" to="/events" search={{ cursor: snapshot.cursor }}>从此快照接续变化 →</Link></div>
        <details><summary>来源与恢复定位</summary><p>数据库 <code>{snapshot.databaseId}</code></p><p>采集代 <code>{snapshot.collectorEpoch ?? "none"}</code></p><p>来源范围 <code>{snapshot.scopeId ?? "尚未确认"}</code></p><p>游标 <code>{snapshot.cursor}</code></p></details>
      </>}
    </Card></>;
}
