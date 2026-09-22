import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Boxes, ChevronRight, LogOut } from "lucide-react";
import { announceSessionChange } from "../lib/services.ts";
import { ConsoleNav } from "../components/console-nav.tsx";
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
    <ConsoleNav />
    <div className="sidebar-foot"><span className="eyebrow">PINNED INSTALLATION</span><code>{bootstrap.binding.installationId}</code><p>单 Box · 内部观察与必要管理</p><p className="muted">已有 API 页面覆盖观察、材料、操作、通知、保护与系统；不提供聊天或任务发起。</p></div></aside>
    <div className="workspace"><header className="topbar"><span>Console <ChevronRight size={14}/><strong>{session.principalId}</strong></span><span className="topbar-actions"><span role="status" aria-live="polite">{loading ? "读取中…" : "身份已绑定"}</span><button className="quiet" onClick={signOut} disabled={signingOut}><LogOut size={15}/>{signingOut ? "退出中…" : "退出登录"}</button></span></header>
      <main id="main-content"><ErrorNotice error={error}/><Outlet/></main><footer className="workspace-footer">配置、执行和观察事实分别呈现。没有页面也不应停止后台工作。</footer></div></div>;
}
