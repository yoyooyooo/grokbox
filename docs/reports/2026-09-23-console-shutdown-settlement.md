# Console 停服身份与已登记事务结算

日期：2026-09-23。工作包：AH-167。代码候选 `b3aac9b5c95111a09f4cdade87e491e2471ab95e`，基于 V2 `0f365f23f484cd53b6c5b28b724a663c723375db`。

## 已复现的差异

在真正的模型暂存文件完成后、原最终发布检查前暂停一个已登记请求。同一未改变的管理授权下，Bearer 请求在停服后结算成功，Console Cookie 请求在不停服时成功，但 Console Cookie 请求在停服时留下 unknown 且不发布。实际 Node HTTP、一次性 grant 兑换、Cookie/CSRF、Effect 与原文件 writer 都参与了复现；只有账号归属与模型能力是隔离 fixture，模型使用 stub/echo。

根因在原 Server close 顺序：先同步清空 ConsoleAuthority 会话，再等待 runtime.dispose。最终授权检查因此无法辨认正在结算的原 Cookie 主体；这不是用户主动 logout，也不是底层管理 grant 已撤销。

## 原 owner 内的修正

close 立即设置 closing 拒绝新请求，但在原 runtime.dispose 的 finally 中才清理临时 Console 身份。原已登记的 uninterruptible 本地事务继续由原 Scope 收尾；没有新 runtime、后台任务或第二配置 writer。关闭调用仍复用同一个 Promise，成功和拒绝路径都进行会话清理。

这不冻结权限。显式 logout、当前 grant 撤销、凭据移除或主体改绑仍在原最终授权检查中生效。重启不恢复旧会话；原 durable receipt 留在原主体和 requestId 下，unknown 不重新发布。

## 实际验证

新增五种正式 HTTP 时序：授权不变、撤权、主体改绑、凭据移除、主动 logout。修前整个授权 Node 套件24项中23通过、1失败；修后24项全通过。测试检查真实暂存文件、停服等待、新请求拒绝、原配置字节、发布次数、重启后的原回执、旧 Cookie 失效和不重复写入。

固定代码候选的十二文件组合101个外层测试通过，0失败；内部 Node 授权24、桌面23、Server36、产品53、消息34均无失败/跳过。内外不重复累计。根/Web 类型、完整构建、包边界、文档和公开性检查通过；这些结果不是完整核心候选的原生、平台或独立审查结论。

## 边界与来源

未操作现役 Host/modeld、真实 Bot、桌面、用户 Cookie 或收费 Provider。运行环境是自有临时根与本地测试 HTTP Server。独立复核及实际合流状态按来源票记录，不把本报告当现场采用许可。

源码：[Server 关闭程序](../../packages/server/src/server.ts)、[Console 身份](../../packages/server/src/console-access.ts)、[HTTP 发布边界](../../packages/server/test/model-publication-boundaries.node.ts)。关联原[模型发布授权报告](2026-09-23-model-publication-authorization.md)。
