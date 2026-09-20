import { useRef, useState, type ReactNode } from "react";
import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { ManagementClientError, type ModelChange, type ModelOperation } from "@grokbox/client";
import { markOperation, rememberOperation, type LocalOperation } from "../lib/operations.ts";

export function useConsole() { return useRouteContext({ from: "__root__" }); }
export function Heading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children && <p className="lede">{children}</p>}</header>;
}
export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{title && <h2>{title}</h2>}{children}</section>;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "info" | "warn" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const known = error instanceof ManagementClientError;
  return <div className="notice danger" role="alert"><strong>{known ? error.code : "unavailable"}</strong>
    <p>{known ? error.message : "请求未能完成，未使用假数据或自动重发写入。"}</p>
    {known && error.code === "authentication_required" && <a href="/login">重新登录</a>}
    {known && error.code === "revision_conflict" && <p>配置已被其他入口修改。草稿仍保留；读取最新版本并检查差异后，再明确提交。</p>}
  </div>;
}
export function SourceTime({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{new Date(at).toISOString().replace("T", " ").replace("Z", " UTC")}</time>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="empty">{children}</p>; }

export function useModelAction() {
  const { services, bootstrap } = useConsole(), router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>();
  const [receipt, setReceipt] = useState<ModelOperation>(), [locator, setLocator] = useState<LocalOperation>();
  async function submit(change: ModelChange, revision: string): Promise<boolean> {
    if (busy.current || !bootstrap.session) return false;
    busy.current = true; setPending(true); setError(undefined); setReceipt(undefined); setLocator(undefined);
    const input = { requestId: crypto.randomUUID(), expectedRevision: revision, change: structuredClone(change) };
    let row: LocalOperation | undefined;
    try {
      const api = await services.prepareWrite(bootstrap.binding, bootstrap.session.principalId);
      row = rememberOperation(localStorage, { installationId: bootstrap.binding.installationId, principalId: bootstrap.session.principalId }, input);
      setLocator(row);
      const result = await api.changeModels(input);
      markOperation(localStorage, row, result.data.state);
      setReceipt(result.data);
      void router.invalidate();
      return true;
    } catch (failure) {
      if (row) markOperation(localStorage, row, failure instanceof ManagementClientError && failure.reply && failure.code !== "operation_unknown" ? "refused" : "unknown");
      setError(failure);
      return false;
    } finally { busy.current = false; setPending(false); }
  }
  return { submit, pending, error, receipt, locator };
}
export function MutationFeedback({ action }: { action: ReturnType<typeof useModelAction> }) {
  return <><ErrorNotice error={action.error}/>{action.receipt && <div className="notice" role="status"><strong>配置已保存，供后续轮次采用</strong>
    <p>在途轮次保持不变；这不是模型调用、当前轮次生效或用户任务完成的证明。</p></div>}
    {action.locator && <p className="recovery-link">恢复标识 <code>{action.locator.requestId}</code> · <Link to="/operations" search={{ requestId: action.locator.requestId }}>查询原操作回执</Link></p>}</>;
}
