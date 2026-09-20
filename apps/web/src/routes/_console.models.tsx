import { createFileRoute, Link } from "@tanstack/react-router";
import type { DefaultModelView, ModelList } from "@grokbox/client";
import { Badge, Card, Empty, ErrorNotice, Heading } from "../components/ui.tsx";
import { DefaultSelectionForm } from "../components/selection-forms.tsx";
import { ModelEditor, NewModelForm } from "../components/model-editor.tsx";
import { boundedSearch, denied, readView, viewError } from "../lib/views.ts";

export const Route = createFileRoute("/_console/models")({
  validateSearch: (search: Record<string, unknown>): { cursor?: string; selected?: string; create?: boolean } => ({
    cursor: boundedSearch(search.cursor), selected: boundedSearch(search.selected), create: search.create === true || search.create === "true" || undefined,
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, selected: search.selected }),
  loader: async ({ context, deps }) => {
    const api = context.services.client(context.bootstrap.binding), permitted = context.bootstrap.session!.capabilities.includes("models.read");
    const [models, defaults, selected] = await Promise.all([
      permitted ? readView(api.models({ limit: 50, cursor: deps.cursor })) : denied<ModelList>(),
      permitted ? readView(api.defaultModel()) : denied<DefaultModelView>(),
      permitted && deps.selected ? readView(api.model(deps.selected)) : null,
    ]);
    return { models, defaults, selected };
  }, component: Models,
});
function Models() {
  const { models, defaults, selected } = Route.useLoaderData(), search = Route.useSearch();
  return <><Heading eyebrow="MODEL RELATIONSHIPS" title="模型配置">配置、默认关系和逐 Bot 选择分别维护。凭据仅呈现配置状态，不向浏览器解析秘密。</Heading>
    <Card title="模型目录"><div className="toolbar"><p>当前可见 {models.data?.total ?? "—"} 个模型配置</p><Link className="button" to="/models" search={{ create: true }}>新增完整声明</Link><Link to="/models" search={{}}>重新获取首页</Link></div><ErrorNotice error={viewError(models)}/>
      {models.data && <><div className="table-wrap"><table><thead><tr><th>模型 ID</th><th>上游模型</th><th>配置来源</th><th>凭据状态</th><th>声明能力</th></tr></thead><tbody>{models.data.models.map(model => <tr key={model.id}><td><Link to="/models" search={{ ...search, selected: model.id, create: undefined }}>{model.alias || model.id}</Link><small className="block muted">{model.id}</small></td><td>{model.model}</td><td><Badge>{model.configurationSource}</Badge></td><td>{model.credential.configured ? `已配置 · ${model.credential.source}` : "未配置"}</td><td>{[model.capabilities.tools ? "工具" : "", model.capabilities.vision ? "视觉" : ""].filter(Boolean).join(" / ") || "基础文本"}</td></tr>)}</tbody></table></div>{!models.data.models.length && <Empty>当前配置源明确返回空模型目录。</Empty>}<div className="pagination"><span className="muted">有界分页；凭据和 Provider 实际资格另行验证。</span>{models.data.nextCursor && <Link className="button" to="/models" search={{ cursor: models.data.nextCursor }}>下一页 →</Link>}</div></>}
    </Card>
    {selected && <ErrorNotice error={viewError(selected)}/>} {selected?.data && <ModelEditor key={selected.data.model.id} initial={selected.data.model} revision={selected.data.revision}/>}
    {search.create && models.data && <NewModelForm revision={models.data.revision}/>}
    <ErrorNotice error={viewError(defaults)}/>{defaults.data && <DefaultSelectionForm initial={defaults.data} models={models.data?.models ?? []}/>}
  </>;
}
