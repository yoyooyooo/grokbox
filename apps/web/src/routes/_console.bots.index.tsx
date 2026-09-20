import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { type BotList } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/bots/")({
  validateSearch: (search: Record<string, unknown>): { cursor?: string; q?: string } => ({ cursor: boundedSearch(search.cursor), q: boundedSearch(search.q, 1024) }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ context, deps }) => context.bootstrap.session!.capabilities.includes("bots.read")
    ? readView(context.services.client(context.bootstrap.binding).bots({ limit: 25, cursor: deps.cursor })) : denied<BotList>(),
  component: Bots,
});
function Bots() {
  const view = Route.useLoaderData(), search = Route.useSearch(), navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState(search.q ?? "");
  const bots = view.data?.bots.filter(bot => !search.q || `${bot.name} ${bot.title ?? ""} ${bot.id}`.toLocaleLowerCase().includes(search.q.toLocaleLowerCase()));
  function filter(event: FormEvent) { event.preventDefault(); void navigate({ search: { ...search, q: query || undefined } }); }
  return <><Heading eyebrow="NATIVE IDENTITIES" title="Bots">对象引用使用原生 ID 和安装范围。harness 只读声明不代替执行所有权证明。</Heading><Card><form className="toolbar" onSubmit={filter}><label htmlFor="bot-filter">本页筛选</label><input id="bot-filter" value={query} maxLength={1024} onChange={event => setQuery(event.target.value)} placeholder="名称、标题或原生 ID"/><button type="submit">筛选</button><Link to="/bots" search={{}}>重新获取首页</Link></form><ErrorNotice error={viewError(view)}/>
    {view.data && <><p className="source-line">当前成员总数 {view.data.total} · 本页 {view.data.bots.length} · 采集于 <SourceTime at={view.data.source.observedAt}/></p><div className="table-wrap"><table><thead><tr><th>Bot</th><th>原生声明</th><th>活动观察</th><th>身份</th></tr></thead><tbody>{bots!.map(bot => <tr key={bot.id}><td><Link to="/bots/$botId" params={{ botId: bot.id }}><strong>{bot.name || "未命名 Bot"}</strong></Link><small className="block muted">{bot.title ?? "未提供标题"}{bot.textTruncated ? " · 字段有截断" : ""}</small></td><td><Badge>{bot.nativeHarness ?? "unknown"}</Badge></td><td><Badge tone={bot.running ? "info" : "neutral"}>{bot.running === null ? "未知" : bot.running ? "运行中" : "未观察到运行"}</Badge></td><td><code>{bot.id}</code></td></tr>)}</tbody></table></div>{!bots!.length && <Empty>{search.q ? "当前页没有匹配项；不代表所有页或所有来源均无结果。" : "当前来源返回空成员快照。"}</Empty>}
    <div className="pagination"><span className="muted">成员集稳定分页，字段按次刷新；代际变化需要重取首页。</span>{view.data.nextCursor && <Link className="button" to="/bots" search={{ cursor: view.data.nextCursor, q: search.q }}>下一页 →</Link>}</div></>}
  </Card></>;
}
