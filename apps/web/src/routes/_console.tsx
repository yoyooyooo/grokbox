import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Activity, Bot, Boxes, ChevronRight, LogOut, Settings2, ShieldCheck } from "lucide-react";
import { announceSessionChange } from "../lib/services.ts";
import { ErrorNotice, useConsole } from "../components/ui.tsx";

export const Route = createFileRoute("/_console")({
  beforeLoad: ({ context }) => { if (!context.bootstrap.session) throw redirect({ to: "/login" }); },
  component: ConsoleLayout,
});
function ConsoleLayout() {
  const { bootstrap, services } = useConsole(), session = bootstrap.session!;
  const loading = useRouterState({ select: state => state.isLoading });
  const [error, setError] = useState<unknown>(), [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    let disposed = false, checking = false;
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const next = await services.bootstrap();
        if (disposed || next.error) return;
        if (!next.session) window.location.replace("/login");
        else if (next.session.sessionId !== session.sessionId || JSON.stringify(next.session.capabilities) !== JSON.stringify(session.capabilities)) window.location.reload();
      } catch { /* Reads retain their last known state; server authorization still runs per action. */ }
      finally { checking = false; }
    };
    const storage = (event: StorageEvent) => { if (event.key === "grokbox:console-session-change") window.location.reload(); };
    const page = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    const expiry = setTimeout(() => window.location.replace("/login"), Math.max(0, session.expiresAt - Date.now()));
    const timer = setInterval(() => { void check(); }, 60_000);
    window.addEventListener("focus", check); window.addEventListener("storage", storage); window.addEventListener("pageshow", page);
    return () => { disposed = true; clearTimeout(expiry); clearInterval(timer); window.removeEventListener("focus", check); window.removeEventListener("storage", storage); window.removeEventListener("pageshow", page); };
  }, [services, session.sessionId, session.expiresAt, session.capabilities]);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true); setError(undefined);
    try {
      const api = await services.prepareWrite(bootstrap.binding, session.principalId);
      await api.consoleLogout();
      announceSessionChange(); window.location.replace("/login");
    } catch (failure) {
      try { const current = await services.bootstrap(); if (!current.session && !current.error) { announceSessionChange(); window.location.replace("/login"); return; } } catch { /* Do not repeat logout after a lost response. */ }
      setError(failure); setSigningOut(false);
    }
  }
  return <div className="app-shell"><aside className="sidebar" aria-label="主导航"><Link to="/" className="brand"><span className="brand-mark"><Boxes size={23}/></span><span>grokbox<small>CONTROL ROOM</small></span></Link>
    <p className="nav-label">WORKSPACE</p><nav><Link to="/" activeOptions={{ exact: true }}><Activity size={18}/>概览</Link><Link to="/bots" search={{}}><Bot size={18}/>Bots</Link><Link to="/models" search={{}}><Settings2 size={18}/>模型配置</Link><Link to="/operations" search={{}}><ShieldCheck size={18}/>操作回执</Link><Link to="/notifications"><Activity size={18}/>通知后台</Link><Link to="/materials" search={{kind:"memory"}}><Boxes size={18}/>Materials</Link><Link to="/files" search={{}}><Boxes size={18}/>Files</Link><Link to="/protection" search={{}}><ShieldCheck size={18}/>Protection</Link><Link to="/host-health"><ShieldCheck size={18}/>Host health</Link><Link to="/contexts" search={{}}><ShieldCheck size={18}/>Context</Link><Link to="/lifecycles" search={{}}><Bot size={18}/>Lifecycles</Link><Link to="/desktop"><ShieldCheck size={18}/>Desktop</Link><Link to="/jobs" search={{}}><Activity size={18}/>Jobs</Link><Link to="/observation"><Activity size={18}/>持续观察</Link><Link to="/incidents" search={{}}><ShieldCheck size={18}/>持久异常</Link><Link to="/events" search={{}}><Activity size={18}/>观察变化</Link></nav>
    <div className="sidebar-foot"><span className="eyebrow">PINNED INSTALLATION</span><code>{bootstrap.binding.installationId}</code><p>单 Box · 内部观察与必要管理</p><p className="muted">材料、日志与保护页面随领域接入；不提供聊天或任务发起。</p></div></aside>
    <div className="workspace"><header className="topbar"><span>Console <ChevronRight size={14}/><strong>{session.principalId}</strong></span><span className="topbar-actions"><span role="status" aria-live="polite">{loading ? "读取中…" : "身份已绑定"}</span><button className="quiet" onClick={signOut} disabled={signingOut}><LogOut size={15}/>{signingOut ? "退出中…" : "退出登录"}</button></span></header>
      <main id="main-content"><ErrorNotice error={error}/><Outlet/></main><footer className="workspace-footer">配置、执行和观察事实分别呈现。没有页面也不应停止后台工作。</footer></div></div>;
}
