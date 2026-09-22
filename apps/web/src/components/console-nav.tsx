import { Activity, Bot, Boxes, Settings2, ShieldCheck } from "lucide-react";
import { Link } from "@tanstack/react-router";

export function ConsoleNav() {
  return <nav className="console-nav" aria-label="主导航" data-testid="console-nav">
    <div className="nav-group">
      <p className="nav-label">WORKSPACE</p>
      <Link to="/" activeOptions={{ exact: true }}><Boxes size={18}/>概览</Link>
      <Link to="/bots" search={{}}><Bot size={18}/>Bots</Link>
      <Link to="/models" search={{}}><Settings2 size={18}/>模型配置</Link>
    </div>
    <div className="nav-group">
      <p className="nav-label">OBSERVE</p>
      <Link to="/observation"><Activity size={18}/>持续观察</Link>
      <Link to="/events" search={{}}><Activity size={18}/>观察变化</Link>
      <Link to="/incidents" search={{}}><ShieldCheck size={18}/>持久异常</Link>
      <Link to="/operations" search={{}}><ShieldCheck size={18}/>操作回执</Link>
      <Link to="/host-health"><ShieldCheck size={18}/>Host health</Link>
    </div>
    <div className="nav-group">
      <p className="nav-label">MANAGE</p>
      <Link to="/materials" search={{kind: "memory"}}><Boxes size={18}/>Materials</Link>
      <Link to="/files" search={{}}><Boxes size={18}/>Files</Link>
      <Link to="/notifications" search={{}}><Activity size={18}/>通知后台</Link>
      <Link to="/notification-setup" search={{}}><Settings2 size={18}/>通知设置</Link>
      <Link to="/protection" search={{}}><ShieldCheck size={18}/>Protection</Link>
      <Link to="/contexts" search={{}}><ShieldCheck size={18}/>Context</Link>
      <Link to="/lifecycles" search={{}}><Bot size={18}/>Lifecycles</Link>
      <Link to="/desktop"><ShieldCheck size={18}/>Desktop</Link>
      <Link to="/jobs" search={{}}><Activity size={18}/>Jobs</Link>
    </div>
  </nav>;
}
