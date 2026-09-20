import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { createConsoleServices } from "./lib/services.ts";

export function getRouter() {
  return createRouter({ routeTree, context: { services: createConsoleServices() }, scrollRestoration: true,
    defaultPreload: false, defaultStaleTime: 0, defaultGcTime: 0,
    defaultErrorComponent: () => <main className="standalone"><h1>暂时无法读取此页面</h1><p>没有使用演示数据代替服务结果。请检查连接后重新加载。</p><a href="/">返回概览</a></main>,
    defaultNotFoundComponent: () => <main className="standalone"><h1>页面不存在</h1><a href="/">返回概览</a></main>,
  });
}
declare module "@tanstack/react-router" { interface Register { router: ReturnType<typeof getRouter> } }
