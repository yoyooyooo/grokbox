import { useState, type FormEvent } from "react";
import { ManagementClientError, type ModelPatch, type ModelView } from "@grokbox/client";
import { Card, ErrorNotice, MutationFeedback, useConsole, useModelAction } from "./ui.tsx";

type Draft = { alias: string; model: string; endpoint: string; apiKeyRef: string };
const draftFor = (model: ModelView): Draft => ({ alias: model.alias ?? "", model: model.model, endpoint: model.endpoint ?? "", apiKeyRef: "" });
export function ModelEditor({ initial, revision }: { initial: ModelView; revision: string }) {
  const { services, bootstrap } = useConsole(), action = useModelAction();
  const [base, setBase] = useState({ model: initial, revision }), [draft, setDraft] = useState(() => draftFor(initial));
  const [touched, setTouched] = useState<Partial<Record<keyof Draft, true>>>({}), [error, setError] = useState<unknown>();
  const writable = bootstrap.session!.capabilities.includes("models.write") && initial.configurationSource === "local";
  const field = (key: keyof Draft, value: string) => { setDraft(current => ({ ...current, [key]: value })); setTouched(current => ({ ...current, [key]: true })); };
  async function refresh(reset = false) {
    try {
      const next = (await services.client(bootstrap.binding).model(initial.id)).data;
      setBase(next); setError(undefined);
      if (reset) { setDraft(draftFor(next.model)); setTouched({}); }
    } catch (failure) { setError(failure); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(undefined);
    if (!Object.keys(touched).length) { setError(new ManagementClientError("invalid_input", "尚未修改任何字段。")); return; }
    const patch: ModelPatch = {};
    if (touched.alias) patch.alias = draft.alias || null;
    if (touched.model) patch.model = draft.model;
    if (touched.endpoint) patch.endpoint = draft.endpoint;
    if (touched.apiKeyRef) {
      if (!draft.apiKeyRef) { setError(new ManagementClientError("invalid_input", "更换凭据必须给出明确引用；留空不代表清除现有凭据。")); return; }
      patch.apiKeyRef = draft.apiKeyRef;
    }
    if (await action.submit({ kind: "model-patch", modelId: initial.id, patch }, base.revision)) await refresh(true);
  }
  async function remove() {
    if (!window.confirm(`删除本地模型配置 ${initial.id}？有 Bot 或默认关系引用时会拒绝，不会自动换绑。`)) return;
    await action.submit({ kind: "model-delete", modelId: initial.id }, base.revision);
  }
  return <Card title={`模型配置 · ${initial.id}`}><dl><dt>配置来源</dt><dd>{base.model.configurationSource}</dd><dt>当前模型</dt><dd>{base.model.model}</dd><dt>当前别名</dt><dd>{base.model.alias ?? "未设置"}</dd><dt>当前端点（已脱敏）</dt><dd>{base.model.endpoint ?? "非网络模型"}</dd><dt>凭据</dt><dd>{base.model.credential.configured ? `已配置 · ${base.model.credential.source}` : "未配置"}；不读取或展示值</dd></dl>
    <form onSubmit={save}><fieldset disabled={!writable || action.pending}><label htmlFor="edit-alias">别名</label><input id="edit-alias" value={draft.alias} onChange={event => field("alias", event.target.value)} maxLength={16}/><label htmlFor="edit-model">模型名称</label><input id="edit-model" value={draft.model} onChange={event => field("model", event.target.value)} maxLength={2048} required/>
    <label htmlFor="edit-endpoint">端点</label><input id="edit-endpoint" value={draft.endpoint} onChange={event => field("endpoint", event.target.value)} maxLength={2048} required/><label htmlFor="edit-key-ref">更换凭据引用（可选，不是密钥值）</label><input id="edit-key-ref" type="password" autoComplete="new-password" value={draft.apiKeyRef} onChange={event => field("apiKeyRef", event.target.value)} maxLength={2048} placeholder="env:… / file:… / pi-provider:…"/>
    <p className="field-note">仅提交你编辑过的字段；读取最新版本不会把未触碰字段写回。留空别名表示显式清除。</p><div className="actions"><button className="primary" type="submit">保存模型配置</button><button className="danger-button" type="button" onClick={remove}>删除未引用配置</button></div></fieldset></form>
    {!writable && <p className="notice">此配置来源或当前权限不允许在这里修改。外部导入和内建模型不是本地可删除配置。</p>}<button className="quiet" onClick={() => refresh()} disabled={action.pending}>读取最新版本，保留草稿</button><p className="revision">表单基准 <code>{base.revision}</code></p><ErrorNotice error={error}/><MutationFeedback action={action}/></Card>;
}
export function NewModelForm({ revision }: { revision: string }) {
  const { services, bootstrap } = useConsole(), action = useModelAction();
  const [baseRevision, setBaseRevision] = useState(revision), [id, setId] = useState(""), [provider, setProvider] = useState("openai-chat");
  const [model, setModel] = useState(""), [endpoint, setEndpoint] = useState(""), [reference, setReference] = useState("");
  const [tools, setTools] = useState(true), [vision, setVision] = useState(false), [error, setError] = useState<unknown>();
  async function refresh() { try { setBaseRevision((await services.client(bootstrap.binding).models({ limit: 1 })).data.revision); setError(undefined); } catch (failure) { setError(failure); } }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (await action.submit({ kind: "model-put", modelId: id, model: { id, provider, model, endpoint, apiKeyRef: reference, capabilities: { tools, vision, images: false }, dataTypes: vision ? ["text", "image"] : ["text"] } }, baseRevision)) {
      setReference(""); await refresh();
    }
  }
  return <Card title="新增本地模型声明"><p>这是完整声明，不是连通性或付费模型测试。相同 ID 的已有配置可能被替换；应先检查模型列表。</p><form onSubmit={create}><fieldset disabled={!bootstrap.session!.capabilities.includes("models.write") || action.pending}>
    <label htmlFor="new-id">新模型 ID</label><input id="new-id" value={id} onChange={event => setId(event.target.value)} required maxLength={256}/><label htmlFor="new-provider">Provider 适配类型</label><select id="new-provider" value={provider} onChange={event => setProvider(event.target.value)}><option value="openai-chat">OpenAI-compatible Chat</option><option value="openai-responses">OpenAI-compatible Responses</option></select>
    <label htmlFor="new-model">上游模型名称</label><input id="new-model" value={model} onChange={event => setModel(event.target.value)} required maxLength={2048}/><label htmlFor="new-endpoint">上游端点（不带凭据或查询参数）</label><input id="new-endpoint" value={endpoint} onChange={event => setEndpoint(event.target.value)} required maxLength={2048} placeholder="https://…/v1"/>
    <label htmlFor="new-key-ref">凭据引用（不是密钥值）</label><input id="new-key-ref" type="password" autoComplete="new-password" value={reference} onChange={event => setReference(event.target.value)} required maxLength={2048}/><div className="radio-group"><label><input type="checkbox" checked={tools} onChange={event => setTools(event.target.checked)}/>工具声明</label><label><input type="checkbox" checked={vision} onChange={event => setVision(event.target.checked)}/>视觉声明</label></div><button className="primary" type="submit">提交完整模型声明</button></fieldset></form>
    <button className="quiet" onClick={refresh} disabled={action.pending}>读取最新版本，保留草稿</button><ErrorNotice error={error}/><MutationFeedback action={action}/></Card>;
}
