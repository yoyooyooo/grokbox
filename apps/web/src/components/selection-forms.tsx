import { useState, type FormEvent } from "react";
import type { BotModelView, BotModelSelection, DefaultModelView, ModelView } from "@grokbox/client";
import { Card, ErrorNotice, MutationFeedback, useConsole, useModelAction } from "./ui.tsx";

type Policy = NonNullable<Extract<BotModelSelection, { kind: "model" }>["reasoning"]>;
const efforts: Array<Policy["effort"]> = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function ModelChoice({ prefix, id, effort, models, setId, setEffort }: {
  prefix: string; id: string; effort: string; models: ModelView[]; setId: (id: string) => void; setEffort: (effort: string) => void;
}) {
  return <><label htmlFor={`${prefix}-model`}>模型 ID</label><input id={`${prefix}-model`} list={`${prefix}-models`} value={id} onChange={event => setId(event.target.value)} maxLength={256} required placeholder="精确配置 ID"/>
    <datalist id={`${prefix}-models`}>{models.map(model => <option value={model.id} key={model.id}>{model.alias ?? model.model}</option>)}</datalist>
    <label htmlFor={`${prefix}-effort`}>推理档位</label><select id={`${prefix}-effort`} value={effort} onChange={event => setEffort(event.target.value)}><option value="default">采用模型默认（不指定覆盖）</option>{efforts.map(value => <option key={value}>{value}</option>)}</select>
    <p className="field-note">只提交显式选择，不自动降档。后端会检查该模型的能力声明与准入条件。</p></>;
}
export function BotSelectionForm({ initial, models }: { initial: BotModelView; models: ModelView[] }) {
  const { services, bootstrap } = useConsole(), action = useModelAction();
  const [base, setBase] = useState(initial), [kind, setKind] = useState(initial.selection.kind);
  const [modelId, setModelId] = useState(initial.selection.kind === "model" ? initial.selection.modelId : "");
  const [effort, setEffort] = useState(initial.selection.kind === "model" ? initial.selection.reasoning?.effort ?? "default" : "default");
  const [readError, setReadError] = useState<unknown>(), [refreshing, setRefreshing] = useState(false);
  const canWrite = bootstrap.session!.capabilities.includes("models.write");
  async function refresh() {
    setRefreshing(true); setReadError(undefined);
    try { setBase((await services.client(bootstrap.binding).botModel(initial.botRef)).data); }
    catch (error) { setReadError(error); }
    finally { setRefreshing(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const selection: BotModelSelection = kind === "model" ? { kind, modelId, ...(effort === "default" ? {} : { reasoning: { effort: effort as Policy["effort"] } }) } : { kind };
    if (await action.submit({ kind: "bot-selection", agentId: initial.botRef.split(":")[2]!, selection }, base.revision)) await refresh();
  }
  return <Card title="后续轮次的模型选择"><p>当前配置关系：<strong>{base.selection.kind === "native" ? "原生模型" : base.selection.kind === "default" ? "跟随默认" : `指定 ${base.selection.modelId}`}</strong></p>
    <p className="muted">配置解析结果：{base.effectiveModel?.modelId ?? "原生或无有效默认"} · 当前 TURN：未观察。此处不以配置推断实际执行。</p>
    {initial.revision !== base.revision && <p className="notice">另一个入口已更新配置。表单仍保留原基准和草稿。</p>}
    <form onSubmit={submit}><fieldset disabled={!canWrite || action.pending || refreshing}><legend>选择关系</legend><div className="radio-group">{(["native", "default", "model"] as const).map(value => <label key={value}><input type="radio" name={`selection-${initial.botRef}`} value={value} checked={kind === value} onChange={() => setKind(value)}/>{value === "native" ? "原生模型" : value === "default" ? "跟随默认" : "指定模型"}</label>)}</div>
      {kind === "model" && <ModelChoice prefix="bot" id={modelId} effort={effort} models={models} setId={setModelId} setEffort={value => setEffort(value as typeof effort)}/>}
      <button className="primary" type="submit">{action.pending ? "提交中…" : "保存 Bot 模型选择"}</button></fieldset></form>
    {!canWrite && <p className="notice">当前主体只有读取权限。</p>}
    <button className="quiet" onClick={refresh} disabled={refreshing || action.pending}>{refreshing ? "读取中…" : "读取最新版本，保留草稿"}</button><p className="revision">表单基准 <code>{base.revision}</code></p><ErrorNotice error={readError}/><MutationFeedback action={action}/></Card>;
}
export function DefaultSelectionForm({ initial, models }: { initial: DefaultModelView; models: ModelView[] }) {
  const { services, bootstrap } = useConsole(), action = useModelAction();
  const [base, setBase] = useState(initial), [id, setId] = useState(initial.selection?.modelId ?? ""), [effort, setEffort] = useState<string>(initial.selection?.reasoning?.effort ?? "default");
  const [readError, setReadError] = useState<unknown>();
  const canWrite = bootstrap.session!.capabilities.includes("models.write");
  async function refresh() { try { setBase((await services.client(bootstrap.binding).defaultModel()).data); setReadError(undefined); } catch (error) { setReadError(error); } }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await action.submit({ kind: "default-selection", selection: { modelId: id, ...(effort === "default" ? {} : { reasoning: { effort: effort as Policy["effort"] } }) } }, base.revision)) await refresh();
  }
  async function clear() {
    if (!window.confirm("清空默认选择？仍存在跟随者时，后台会拒绝此操作，不会替它们换模型。")) return;
    if (await action.submit({ kind: "default-selection", selection: null }, base.revision)) await refresh();
  }
  return <Card title="全局默认关系"><p>当前默认：<strong>{base.selection?.modelId ?? "未设置"}</strong>。只影响明确选择跟随默认的 Bot。</p><form onSubmit={save}><fieldset disabled={!canWrite || action.pending}><ModelChoice prefix="default" id={id} effort={effort} models={models} setId={setId} setEffort={setEffort}/><div className="actions"><button type="submit" className="primary">保存默认选择</button><button type="button" onClick={clear}>清空默认</button></div></fieldset></form><button className="quiet" onClick={refresh} disabled={action.pending}>读取最新版本，保留草稿</button><p className="revision">表单基准 <code>{base.revision}</code></p><ErrorNotice error={readError}/><MutationFeedback action={action}/></Card>;
}
