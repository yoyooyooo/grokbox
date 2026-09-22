import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { createConsoleServices } from "./lib/services.ts";

export function getRouter() {
  return createRouter({ routeTree, context: { services: createConsoleServices() }, scrollRestoration: true,
    defaultPreload: false, defaultStaleTime: 0, defaultGcTime: 0,
    defaultErrorComponent: () => <main className="standalone"><h1>暂时无法读取此页面</h1><p>没有使用演示数据代替服务结果。请检查连接后重新加载。</p><div className="actions"><a href="/">返回概览</a><a href="/operations">查看操作回执</a><a href="/login">重新登录</a></div></main>,
    defaultNotFoundComponent: () => <main className="standalone"><h1>页面不存在</h1><p>当前地址没有对应的 Console 页面。</p><div className="actions"><a href="/">返回概览</a><a href="/operations">查看操作回执</a><a href="/login">重新登录</a></div></main>,
  });
}
declare module "@tanstack/react-router" { interface Register { router: ReturnType<typeof getRouter> } }
