import { createFileRoute, Link } from "@tanstack/react-router";
import type { BotList, DefaultModelView, ModelList } from "@grokbox/client";
import { Badge, Card, ErrorNotice, Heading, SourceTime, useConsole } from "../components/ui.tsx";
import { denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/")({
  loader: async ({ context }) => {
    const api = context.services.client(context.bootstrap.binding), capabilities = context.bootstrap.session!.capabilities;
    const [identity, bots, models, defaults] = await Promise.all([readView(api.identity()),
      capabilities.includes("bots.read") ? readView(api.bots({ limit: 8 })) : denied<BotList>(),
      capabilities.includes("models.read") ? readView(api.models({ limit: 1 })) : denied<ModelList>(),
      capabilities.includes("models.read") ? readView(api.defaultModel()) : denied<DefaultModelView>()]);
    return { identity, bots, models, defaults };
  }, component: Overview,
});
function Overview() {
  const { identity, bots, models, defaults } = Route.useLoaderData(), { bootstrap } = useConsole();
  return <><Heading eyebrow="WORKSPACE OVERVIEW" title="Box 概览">先看来源与状态，再进入具体对象。此页不是一个替代所有资格检查的绿灯。</Heading>
    <div className="metrics"><Card><span className="metric-label">原生 Bots</span><strong className="metric">{bots.data?.total ?? "—"}</strong><span className="muted">{bots.data ? "当前成员快照，不代表全部执行所有权" : "来源不可用或无权限"}</span></Card>
      <Card><span className="metric-label">可见模型配置</span><strong className="metric">{models.data?.total ?? "—"}</strong><span className="muted">配置存在不等于 Provider 已验证</span></Card>
      <Card><span className="metric-label">默认选择</span><strong className="metric small">{defaults.data ? defaults.data.selection?.modelId ?? "未设置" : "不可读取"}</strong><span className="muted">仅影响显式跟随默认的 Bot</span></Card></div>
    <div className="columns"><Card title="当前连接"><dl><dt>安装身份</dt><dd><code>{bootstrap.binding.installationId}</code></dd><dt>入口</dt><dd>{bootstrap.binding.origin}</dd><dt>管理 API</dt><dd><Badge tone={identity.data ? "info" : "warn"}>{identity.data ? `已验证 · v${identity.data.apiVersion}` : "当前读取失败"}</Badge></dd><dt>主体</dt><dd>{bootstrap.session?.principalId}</dd><dt>快照采集时刻</dt><dd>{bots.data ? <SourceTime at={bots.data.source.observedAt}/> : "尚无合格来源"}</dd></dl><ErrorNotice error={viewError(identity)}/><ErrorNotice error={viewError(defaults)}/></Card>
    <Card title="近期可见对象"><ErrorNotice error={viewError(bots)}/>{bots.data && <div className="object-list">{bots.data.bots.length ? bots.data.bots.map(bot => <Link key={bot.id} to="/bots/$botId" params={{ botId: bot.id }}><span className="avatar">{(bot.name || "B").slice(0, 1)}</span><span><strong>{bot.name || "未命名 Bot"}</strong><small>{bot.title ?? bot.id}</small></span><Badge tone={bot.running ? "info" : "neutral"}>{bot.running === null ? "未知" : bot.running ? "运行中" : "未观察到运行"}</Badge></Link>) : <p className="empty">当前来源明确返回空成员快照。</p>}</div>}<Link to="/bots" search={{}} className="text-link">查看有界 Bot 列表 →</Link></Card></div>
    <Card title="能力与证据边界"><div className="capability-grid"><div><h3>模型与操作</h3><p>查询、配置、默认关系和逐 Bot 选择进入共享领域用例。保存后可通过原 request-id 查询回执。</p><div className="actions"><Link to="/models" search={{}}>管理模型 →</Link><Link to="/operations" search={{}}>查询操作回执 →</Link></div></div><div><h3>观察与资料</h3><p>持续观察、变化、异常、Materials 与 Files 都直接投影现有 API，并保留来源、权限和 stale/unknown 状态。</p><div className="actions"><Link to="/observation">持续观察 →</Link><Link to="/materials" search={{kind:"memory"}}>查看 Materials →</Link></div></div><div><h3>恢复与系统</h3><p>Notifications、Protection、Context、Jobs、Desktop 与 Lifecycles 保留原 request locator；权限不足或来源失效会给出恢复入口。</p><div className="actions"><Link to="/notification-setup" search={{}}>通知设置 →</Link><Link to="/host-health">Host health →</Link></div></div></div><ErrorNotice error={viewError(models)}/></Card></>;
}
