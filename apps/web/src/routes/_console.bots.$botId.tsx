import { createFileRoute, Link } from "@tanstack/react-router";
import { ManagementClientError, UUID, type BotModelView, type ModelList } from "@grokbox/client";
import { Badge, Card, ErrorNotice, Heading, SourceTime } from "../components/ui.tsx";
import { BotSelectionForm } from "../components/selection-forms.tsx";
import { denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/bots/$botId")({
  loader: async ({ context, params }) => {
    if (!UUID.test(params.botId)) throw new ManagementClientError("invalid_input", "Use a stable native Bot ID.");
    const api = context.services.client(context.bootstrap.binding), modelsRead = context.bootstrap.session!.capabilities.includes("models.read");
    const [bot, selection, models] = await Promise.all([readView(api.bot(params.botId)),
      modelsRead ? readView(api.botModel(params.botId)) : denied<BotModelView>(), modelsRead ? readView(api.models({ limit: 100 })) : denied<ModelList>()]);
    return { bot, selection, models };
  }, component: BotDetail,
});
function BotDetail() {
  const { bot, selection, models } = Route.useLoaderData();
  return <><Link to="/bots" search={{}} className="text-link">← Bot 列表</Link><Heading eyebrow="BOT DETAIL" title={bot.data?.name || "Bot 详情"}>{bot.data?.title ?? "真实原生身份与后续模型配置"}</Heading>
    <ErrorNotice error={viewError(bot)}/>{bot.data && <Card title="身份与来源"><dl className="details-grid"><dt>原生 ID</dt><dd><code>{bot.data.id}</code></dd><dt>稳定引用</dt><dd><code>{bot.data.botRef}</code></dd><dt>原生 harness 声明</dt><dd><Badge>{bot.data.nativeHarness ?? "unknown"}</Badge> <span className="muted">不是独立所有权证明</span></dd><dt>运行 / TURN</dt><dd>{bot.data.running === null ? "未知" : String(bot.data.running)} / {bot.data.runningTurn === null ? "未知" : String(bot.data.runningTurn)}</dd><dt>来源代际</dt><dd><code>{bot.data.source.generation}</code></dd><dt>采集时刻</dt><dd><SourceTime at={bot.data.source.observedAt}/></dd></dl>{bot.data.description && <p className="description">{bot.data.description}</p>}{bot.data.textTruncated && <p className="notice">部分文本被有界读取截断：{bot.data.truncatedFields.join("、")}</p>}</Card>}
    <ErrorNotice error={viewError(selection)}/><ErrorNotice error={viewError(models)}/>{selection.data && <BotSelectionForm key={selection.data.botRef} initial={selection.data} models={models.data?.models ?? []}/>}
    {models.data?.nextCursor && <p className="muted">候选提示只覆盖首个模型页；可以输入精确模型 ID，或到模型配置页继续分页查找。</p>}</>;
}
