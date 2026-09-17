# T50 — 持久部署、原生用户旅程与自动化退场验收

## Status / Goal

**Planned · Spec-only。** 无网页、无常驻 Bot 回合时持续发现变化；原生 Webhook 唤醒官方 template bot 完成排障/报告；已授权低风险维护在安全边界执行；无法完成时告警且可撤销。Owning contract：[Spec §11](../roadmap/template-ops-automation-spec.md#tickets)、[维护手册](../maintainers/template-ops-automation.md)。

## Depends-on / Modules

user 基础通知/支持 lane 依 T43–T46 与 T51–T53；自动诊断另依 T47，自动维护另依 T48/T49。基础支持不等待诊断/维护完成。复用 T40 安装/owner 与 T41 monitor，不要求整票循环 Done；未过 native gate 的能力不能进入 productionAccepted。

`packages/box-runtime/src/internal/roots/monitor.runtime.ts`、`ops.runtime.ts`、既有 T40 service lifecycle、CLI installer/ops status、`scripts/verify-runtime-rebuild.mjs` 的待新增 `template-ops` verifier；test source/packed/disposable fixtures 与 [LIVE 唯一现场索引](LIVE-integration-validation.md#live-ops-routines)。本票拥有发布判据与实现/离线/review，不维护第二份当前 live 账本。

## Work

显式安装两个权限不同的角色：observer+notification、只调用唯一 controller 的维护调度。collector 无原始 signal 权限；Bot 不作为 daemon owner；不假设 systemd 或改官方 supervisor。证明 supported supervisor/startup hook 的实际持久性，不以 nohup/前台打印 ready 当自启完成。

采用 T51 的 user/maintainer preset + 独立能力开关；正常启用服务的新安装默认轻量采样，配对后生效 brief-notice，旧安装 off 保持。诊断、canary、低风险维护分别 opt-in，维护另需 grant，issue 逐份确认。status 展示 requested/effective/valueSource/blockedReason 及 binding、collector、delivery、diagnosis、support、qualification/policy/action；不向用户展示一个不含范围的「已保护」。

复用原 controller 结果恢复和 T41 outbox；备份恢复、clone、账号切换、endpoint rotation 后不复活旧 grant 或重复操作。卸载/禁用只停止本安装拥有的进程/任务、撤销未来资格，保留未决 operation 与重要 incident；in-flight 先结算事实，不能简单删队列假装取消。

维护手册加入实际已落地命令和用户告警示例，更新 template skill/包版本和所有 Current Home 的状态。纯文档或 offline 路线不得标 live accepted。

## 2026-09-17 补充：三条独立上线 lane

按 [Spec §10.2](../roadmap/template-ops-automation-spec.md#routine-e2e) 经实际发布 CLI 完整验证 T53：创建一次性 Bot + disabled Webhook Routine、读回/enable、invoke 发真实 HTTP、关联 native run/报告、更新同一 Routine 再次 POST、disable 与安全清理。同时验证 create/update --routines-from 组合入口与独立 apply 不产生第二套结果；不能只用 sendPrompt 测试唤醒或只测第一版 Routine。

user lane 验证：默认无模型采样、无影响 source 变更不提醒、有影响且不可自修首次短提示/issue 询问、无回应/拒绝不追问；同意整理后本地安全草稿、exact 预览确认后 Fake IssuePublisher 仅一次，unknown 不重发。不启动 T47 或 T49，也不需要 GitHub 凭据才能提醒/准备草稿。真实 issue 测试必须另指定测试仓库并取得具体同意。

maintainer lane 验证：额外本地观察按配置生效，但不自动给普通用户发 debug 或打开模型/维护/公开上报；配置升级/克隆/坏文件/恢复不新增花费或权限。diagnose/maintain lane 分别启用和验收，不能由 preset 一次开全。

追加 packed 测试目标 `test/agent-routines-packed.test.ts`、`test/ops-config-cli.test.ts`、`test/ops-issue-cli.test.ts`（T51–T53 提供）；template-ops verifier 纳入这些真实入口，并给每条 lane 输出支持范围。当前本票和新测试仍是目标，不是已执行清单。

## 本轮多目标与授权发布 lane

依 [T54](T54-ops-targets-and-routing.md) 冻结单目标/高级配置，默认 user 只绑定一个任意获授权 Bot；[T55](T55-custom-receiver-delivery.md) 另验 custom 模型/依赖资格、廉价 brief 与高级 analysis 分流、显式备用、集中报告、总额度和一层交接。用户模式不等待全部高级 lane，但不能保留第二个模板专用发送器。

[T56](T56-scripted-issue-publishing.md) 的 confirm-each：用户审核一次 exact draft 后 CLI 内置 REST 完成提交/对账；preauthorized-summary 则独立验收有限 grant、字段模板/仓库/作者/预算/撤销，默认仍关闭。真实 GitHub 只用另获授权的测试仓库与合成材料；普通 CI 使用 Fake/本地 stub，不给生产公共仓库制造测试 issue。

追加测试族由新票交付后纳入 template-ops verifier：ops-routing/targets CLI、custom-notification-receiver/cross-bot-handoff、github-issue-publisher/issue-publishing-grant。验收先以实际 Node CLI 创建/配置不同模型测试 Bot 与 Webhook Routine，验证真实 POST 而非 sendPrompt；capture model、数据去向/权限证据缺失保留 not_proven。

故障 oracle：modeld 不可用不得为通知重启 Host；unknown POST 不备用广播；同 Bot 多 alias 不翻倍成本；跨 Bot 同 report/plan 不重复执行；禁用或重绑后旧 claim 无新权限；issue 201 结果丢失不经 gh 重试；旧 private backup 不复活 binding/grant。普通/高级 Bot 角色不等于可信程度或操作批准权。

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

原生验收已按场景预登记到 [LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)、[LIVE-OPS-RECEIVERS](LIVE-integration-validation.md#live-ops-receivers)、[LIVE-OPS-OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)、[LIVE-OPS-ISSUE-PUBLISHING](LIVE-integration-validation.md#live-ops-issue-publishing) 和 [LIVE-OPS-MAINTENANCE](LIVE-integration-validation.md#live-ops-maintenance)。各条目的当前现场状态和下一步只在 LIVE 更新；来源实现、离线/制品证明和独立复审仍在各功能票，预登记不等于只剩 live，也不授权测试 Bot、费用、重启或对外发布。

在日期报告记录固定构建、各 lane 的 source/packed/native 证据、目标安装范围、开启的动作类、成本与退路；在 LIVE 对应条目唯一更新已验范围、not_proven 项、阻断和下一步。最终可以只批准 user 基础通知/确认后支持；诊断和自动维护各自保留 not_proven，不强迫同时上线。自动化失效时用户仍能按既有 doctor/Host 显式流程操作。
