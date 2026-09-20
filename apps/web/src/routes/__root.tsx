import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ConsoleServices } from "../lib/services.ts";
import styleUrl from "../styles.css?url";

export const Route = createRootRouteWithContext<{ services: ConsoleServices }>()({
  beforeLoad: async ({ context }) => ({ bootstrap: await context.services.bootstrap() }),
  head: () => ({ meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" },
    { title: "grokbox · 内部观察与管理" }, { name: "robots", content: "noindex, nofollow" }], links: [{ rel: "stylesheet", href: styleUrl }] }),
  component: Root,
});
function Root() {
  return <html lang="zh-CN"><head><HeadContent/></head><body><a className="skip-link" href="#main-content">跳到主要内容</a><Outlet/><Scripts/></body></html>;
}
