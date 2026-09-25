# T55 — 接收者资格、固定分析任务与故障域

## Status / Goal

**Partial：两个固定 disabled Routine blueprint、原生自动任务选模预检、原配对/授权和维护任务接收/回执接口已实现；实际 Bot 模型/工具回合、用户展示、默认用户出口和生产者合流仍未资格化。** 本轮 AH-143 不实现 AH-189 修复逻辑、AH-190 采用控制或通用 Bot 交接框架。

## 当前接收者链

正式入口使用 `notification receiver blueprint/verify/enable` 与原 `routine`、`system config` 管理族。历史 `ops targets` / `ops notifications` 命令不再是当前 writer。受信 driver 复用 capsule、原 outbox、相同原生 HTTP 边界；未知结果不能换目标广播。

原生只读序列检查受管 Agent/Routine、定义 digest、安装 scope、Gateway generation、reviewed profile、实际 loaded capabilities、ownership 和下一次 automation 的选模见证。模型不是从普通聊天配置猜测；绑定还要求最后五秒新鲜度。原生适配器仅识别两个固定策略摘要，不接受任意 prompt 为“合格接收者”。预检不取 key、不调用模型、不证明真实 Bot 回合或用户已读。

普通提醒的固定策略仍为 `notify_then_end`。维护策略为 `claim_analyze_report`：先领取精确任务、取固定 revision 的安全摘要、分析并报告有限结论；不能改配置、换模型、重启、修源码、建 Issue、调另一个 Bot 或采用制品。Routine 默认 disabled；启用仍须用户有权的原生路径，不由配对/预检暗中执行。

## 分析授权与最小接口

配置要求 `ops.maintainer.enabled=true`、确切 `ops.maintainer.target`、目标允许 `diagnose-or-report`、`ops.diagnostics.mode=automatic-bounded`。准备配对后，管理入口 enable 的预期 binding/model revision、持久 request UUID、`--confirm` 和额外 `--confirm-analysis` 才能发布 `analysisAuthorized=true`。preset 和旧提醒授权不能代签。原私有凭据 owner 在实际 HTTP 前再次检查该分析授权。

接收端另需本安装明确委派的管理凭据，principal 精确为 `notification-receiver:<bindingId>`，只授 `notifications.tasks`。凭据不能放在 Webhook body、普通 ops 配置或报告中，也不在本轮测试/配置提交时自动创建或发送给真实 Bot。缺凭据或真实 Bot 工具入口时保留 blocked，不伪造认领。这个主体验证是凭据归属，不是原生 Bot turn 证明，也不是同 UID shell 沙箱。

- `POST /v1/notification-task-claims`：仅接收 `databaseId/workId/attemptId/taskDigest/requestId`；服务端从认证主体取得接收者，不接受请求自报 Bot/权限。
- `GET /v1/notification-tasks/:databaseId/:workId`：读取原任务和分层回执；`/evidence` 仅在原认领、当前配置/绑定/授权有效且任务未过期时读取该 revision 的 `public-summary`。没有通用本地诊断或私有 Host 源码访问权。
- `POST /v1/notification-task-results`：在上述原定位字段上增加 `claimId/conclusion/reportDigest`。结论限 `no-action-proposed/repair-proposed/inconclusive/blocked`；仅可附独立报告摘要 hash 或 null，不接受源码、自由文本、执行指令或“已修复/已采用”结论。

重放相同 request 必须得到原 claim/result，另一个 claim 或同 request 换内容必须冲突。认领只允许已经 dispatch 的 attempting/accepted/unknown，不能认领 reserved。未过期任务方可首次认领；已领取的结果允许在原记录保留期内补报，但不因此恢复取证/执行授权。

## 回执和故障域

HTTP 状态保持原 `native-accepted/definitely-not-accepted/unknown`。任务回执明确 `source=receiver-credential`、`nativeTurnObserved=false`；`claim` 与 `result` 不会改变 HTTP 事实、推造用户展示或签署修复完成。HTTP200 无回执仍是未认领；报告丢应答后查询原 task/request，不换 ID 发另一条 Webhook。

重启可读取/补报已领取任务；尚未发送的旧 backlog 和不明预留仍受原恢复围栏约束，尚未实现完整自动冷启动接续。有限明确拒绝重试见 [T45](T45-template-webhook-delivery.md)。通知、分析各有安装额度；同实际 Bot 的 alias 和用途仍共享目标额度。轮询本身不调用模型，获准 Webhook 可能产生实际模型费用，不能用本地 attempt 数保证 token 成本硬上限。

依赖故障 Host/modeld/provider 的接收者不是独立告警出口。HOST-01 的 `notificationCoverage=local-only` 不因新增回执接口变成用户送达；无维护 Bot 的默认用户出口尚缺已资格化的任意原生通知写能力，不能以本地页面、文件或 HTTP200 代替。

## 已有证明与缺口

原预检探针与早期局限保留在 [接收者选模回执](../reports/2026-09-18-receiver-model-preflight.md)。本轮定向原用例保留，`notification-task.test.ts` 补合同/权限/注入反例；`packages/server/test/notification-tasks.node.ts` 纳入原 `test/notification-management.test.ts`，使用隔离配置根、SQLite、端口和自有 HTTP 接收端，验证明确分析授权、认领先到/HTTP 应答丢失、原 unknown 保留、重启续报、并行事实以及错误凭据/跨任务/内容升级拒绝。

该 HTTP 用例在原通知 attempt 边界装载符合 AH-188 合同的自有固定样例，不声称已经跑过尚未进入 v2 的真实 producer。Q 合流后须检查 AH-188 原 episode→固定 revision→此消费者；真实来源的 source-evidence 私有附件读取/分析授权不是本票的 `notifications.tasks` 能力。

真实 Webhook 接收、native Bot turn、选模/工具/安全范围和用户展示需原现场窗口逐层证明。AH-189 消费 task/claim/result 实现实际修复分析流程，AH-190 单独批准采用；本票不以 prompt 禁令声称已具备强制工具隔离。

## Exit evidence

所有现场待验集中 [LIVE-OPS-RECEIVERS](LIVE-integration-validation.md#live-ops-receivers)、[LIVE-OPS-OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime) 和原索引 AH-143 段。高级 fallback、集中报告和跨 Bot 交接后置；缺默认出口和真实验收时不能 Done。
