import { useRef, useState, type FormEvent } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Boxes, LockKeyhole } from "lucide-react";
import { ManagementClientError } from "@grokbox/client";
import { announceSessionChange } from "../lib/services.ts";
import { ErrorNotice, useConsole } from "../components/ui.tsx";

export const Route = createFileRoute("/login")({
  beforeLoad: ({ context }) => { if (context.bootstrap.session) throw redirect({ to: "/" }); }, component: Login,
});
function Login() {
  const { bootstrap, services } = useConsole();
  const [code, setCode] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState<unknown>();
  const lock = useRef(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true; setPending(true); setError(undefined);
    const input = code.trim(); setCode("");
    try {
      await services.client(bootstrap.binding).redeemConsoleGrant(input);
      announceSessionChange(); window.location.replace("/");
    } catch (failure) {
      // A consumed code must not be replayed after a lost authentication response.
      try { const next = await services.bootstrap(); if (next.session) { announceSessionChange(); window.location.replace("/"); return; } } catch { /* Keep the original failure. */ }
      setError(failure); lock.current = false; setPending(false);
    }
  }
  const bootstrapError = bootstrap.error ? new ManagementClientError(bootstrap.error.code, bootstrap.error.message) : undefined;
  return <main className="login-page" id="main-content"><div className="login-story"><span className="brand"><Boxes size={30}/>grokbox</span><p className="eyebrow">YOUR BOX, IN VIEW</p><h1>看清内部状态，<br/>再做明确的改变。</h1><p>原生客户端之外的观察与管理入口。模型配置和操作结果与 CLI 共用同一后台。</p><div className="login-binding"><span>当前安装</span><code>{bootstrap.binding.installationId}</code><span>{bootstrap.binding.origin}</span></div></div>
    <section className="login-card"><span className="login-icon"><LockKeyhole size={25}/></span><h2>登录控制台</h2><p>使用本机 owner 签发的一次性登录码。登录码五分钟内有效，不能作为长期管理凭据。</p><ErrorNotice error={bootstrapError ?? error}/>
      <form onSubmit={login}><label htmlFor="login-code">一次性登录码</label><input id="login-code" name="console-code" type="password" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} maxLength={64} required spellCheck={false}/><button className="primary" type="submit" disabled={pending || !code.trim()}>{pending ? "正在兑换…" : "安全登录"}</button></form>
      <details><summary>如何获得登录码？</summary><p>在 Box 的 CLI 使用下面的命令。登录码仅写入新建私有文件，不应放入 URL、日志或公开消息。</p><pre>grokbox system console grant create{`\n  --origin ${bootstrap.binding.origin}`}<br/>  --credential-file &lt;新的私有文件&gt;</pre><p>管理 Server 必须显式允许相同的 console origin。</p></details></section></main>;
}
