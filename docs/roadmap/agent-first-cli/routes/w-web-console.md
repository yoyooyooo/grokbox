# W · 自有 Web 的完整功能与最终体验

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-web-console`，从当前v2切出。自有Web属于最终交付，但**不阻塞运行核心J2–J4**；原版Grok Bot App由R/D验证，不随本路线后置。

## 目标与入口

在已建立的Web工程上补齐真实管理功能、导航、错误/恢复和最终体验，不重搭空站。先读[WEB-02](../../../tickets/WEB-02-web-foundation.md)、[WEB-03](../../../tickets/WEB-03-functional-prototype.md)、[WEB-01](../../../tickets/WEB-01-visual-baseline.md)、[页面目标](../../future/webui-console.md)及[T29](../../../tickets/T29-runtime-webui.md)。V0不是最终视觉批准。

## owner与边界

`apps/web/src/routes/`、components/lib、SSR与同源bridge、浏览器操作定位、`apps/web/test/`。领域合同/客户端来自packages/client，后端writer和权限仍归对应A/R/B/C/D/E/F，不执行CLI子进程，不复制模型/恢复/通知规则或后台采集器。

浏览器只保存最小恢复定位；URL拥有导航/筛选，查询投影、草稿、订阅各有作用域。现有模型、材料、通知、保护、contexts、operations、Job和files页面及真实Chrome成果保留。桌面页面属于未提交收尾包，先由原负责人交付，不并行重写。

## 出口

| 出口 | 可开始 / 依赖 | 必须交付 |
| --- | --- | --- |
| **W1 完整功能页面** | J0可整合已存在API；新增功能消费各领域已合入v2的接口 | Bot/材料/运行和日志/异常/保护/系统的已接受功能可定位和操作；错误、权限、stale、并发冲突、unknown、刷新/返回/切对象与原请求恢复明确；真实SSR/浏览器/窄屏和CLI共享行为。交J5，不要求所有CLI leaf各造按钮 |
| **W2 最终呈现** | WEB-01已有明确视觉接受，W1对应功能可运行 | 用户确认后的视觉、可访问性/键盘、响应式、资源/动效与受影响回归。配合W5，不重跑无关模型矩阵 |

页面可在后端交付前用明确隔离fixture开发/测试，但正式页面缺API必须明确不可用，不能fixture兜底或拿静态截图签功能通过。不要因W1缺页面阻塞R真实原版App或F安装宿主验收。

## 验证与部署

按域运行`apps/web/test/operations.test.ts`、`test/web-bridge.test.ts`、`test/browser-groups.test.ts`和`test/web-browser.test.ts`中的实际已注册窗口；`bun run typecheck:web`、构建和搬移生产制品的Chrome证明与源码渲染分开。新增旅程应登记一次且不跳过、不无界延长测试预算。

登录/主体/安装隔离、Host/Origin/CSRF、代理信任、秘密不进HTML/本地存储继续必验。若核心日用期间选择同时启用Web，实际暴露面也须先具备安全资格；“不阻核心”不是允许不安全服务上线。

只将本域薄接线加入共享operations/bridge，跨域冲突交Q；不把所有路由重排混进一个功能包。固定日用制品不随本worktree构建更新，最终发布/暴露外部端点另需授权。
