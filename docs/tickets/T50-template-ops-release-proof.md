# T50 — 持久部署、原生用户旅程与自动化退场验收

## Status / Goal

**Planned · Spec-only。** 无网页、无常驻 Bot 回合时持续发现变化；原生 Webhook 唤醒官方 template bot 完成排障/报告；已授权低风险维护在安全边界执行；无法完成时告警且可撤销。Owning contract：[Spec §11](../roadmap/template-ops-automation-spec.md#tickets)、[维护手册](../maintainers/template-ops-automation.md)。

## Depends-on / Modules

观察/通知 lane 依 T43–T47 的具体能力；自动维护 lane 另依 T48/T49。复用 T40 安装/owner 与 T41 monitor，不要求整票循环 Done。未过 native gate 的能力不能进入 productionAccepted。

`packages/box-runtime/src/internal/roots/monitor.runtime.ts`、`ops.runtime.ts`、既有 T40 service lifecycle、CLI installer/ops status、`scripts/verify-runtime-rebuild.mjs` 的待新增 `template-ops` verifier；test source/packed/disposable fixtures 与 `docs/maintainers/t32-live-enable-readiness.md` 现有签署入口。不要新建第二 release 账本。

## Work

显式安装两个权限不同的角色：observer+notification、只调用唯一 controller 的维护调度。collector 无原始 signal 权限；Bot 不作为 daemon owner；不假设 systemd 或改官方 supervisor。证明 supported supervisor/startup hook 的实际持久性，不以 nohup/前台打印 ready 当自启完成。

安装模式 off/notify/diagnose/maintain-low-risk 分开，最后一种必须额外 grant。status 暴露 binding、collector heartbeat/freshness、delivery、diagnosis、qualification/policy/action 与缺口；未配 native 回执/工具边界时明确降级。不向用户展示一个不含范围的「已保护」。

复用原 controller 结果恢复和 T41 outbox；备份恢复、clone、账号切换、endpoint rotation 后不复活旧 grant 或重复操作。卸载/禁用只停止本安装拥有的进程/任务、撤销未来资格，保留未决 operation 与重要 incident；in-flight 先结算事实，不能简单删队列假装取消。

维护手册加入实际已落地命令和用户告警示例，更新 template skill/包版本和所有 Current Home 的状态。纯文档或 offline 路线不得标 live accepted。

## Executable acceptance

实现时添加 `test/template-ops-packed.test.ts`、`packages/box-runtime/test/template-ops-lifetime.test.ts`，注册 `template-ops` 验证组后运行：

```bash
bun run typecheck
bun test test/template-ops-packed.test.ts packages/box-runtime/test/template-ops-lifetime.test.ts test/template.test.ts test/skills.test.ts
bun scripts/verify-runtime-rebuild.mjs template-ops
node scripts/check-publication.mjs
```

新文件/新 verifier 当前不存在。测试必须启动实际发布 Node 入口与临时目录/Fake upstream，证明同根借用/不同根拒绝、重复安装、正常关闭、硬崩恢复、失去 SQLite/网络/通知/Bot、不配合的诊断、预算耗尽和长期无事件零模型调用。遵守当前 Node 与 Bun pin；工具版本不符单列，不顺带升级。

另获范围授权后的 native 演练：导入两个隔离模板实例；配对后合成事件只唤醒自己的 Bot；重复事件有限诊断且零重复维护；无法处理主动报告；低风险同代对齐与限定新 SHA 等价路线分别验证；故意 busy/child task 时等待而不打断；Bot 结束→controller 执行→新回合报告；退出失败保持 unverified；撤销后旧事件不能执行。

原生通知交付、用户可见、Host 实际加载/退出、工具/取消/会话状态、真实 observer 常驻、自动动作类授权分别出证据。不能以一次 pong、HTTP accepted 或编译 marker 代表全部。整个 Box 离线没有外部观察者时必须显示保证边界，不能假装本机报告了自己的死亡。

## Forbidden / Non-goals

不发布公用 webhook secret，不做全平台多盒自动控制、不直接强推主分支/发布模板/安装生产、不以测试通过推导用户全局授权、不引入新的官方更新器或依赖大升级。

## Done evidence / Next

在现有 readiness 记录固定构建、各 lane 的 source/packed/native 证据、目标安装范围、开启的动作类、成本与退路、not_proven 项。最终可以只批准 notify/diagnose，不强迫自动维护同时上线。自动化失效时用户仍能按既有 doctor/Host 显式流程操作。
