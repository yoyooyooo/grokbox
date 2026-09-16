# T45 — 通知 outbox、原生 Webhook 与交付对账

## Status / Goal

**Planned · Spec-only。** 把已提交监测 incident 可靠推给已配对 template bot，区分原生接收、Bot 领取、报告送达和未知结果；重复唤醒不重复维护。Owning contract：[Spec §5](../roadmap/template-ops-automation-spec.md#payload)、[§8](../roadmap/template-ops-automation-spec.md#storage)。

## Depends-on / Modules

依 T43 冻结 port/能力合同；T44 真实来源可并行，以 synthetic committed incident 先做纵切。复用 T41 原 SQLite 与 notification policy，不开新 DB。

`packages/runtime-kernel/src/internal/ops/notification.ts`、`internal/commands/ops.ts`；`packages/box-runtime/src/internal/ops/automation/notify.ts`、`internal/io/template-notify.node.ts`、`monitor-store.node.ts`、`internal/roots/monitor.runtime.ts`；CLI `commands/ops.ts` 只转参数/输出。

## Work

同一 T41 事务提交事件、incident 与 outbox，再在事务外发送；原 store 扩展 migration/read-only 查询/retention。固定 scope/bindingRevision/target secret ref；投递 lease、稳定 deliveryId、到期与 supersede、速率与优先级合并均可恢复。

Bot claim 验证真实记录、精确安装/Bot/routine、受信 caller scope、到期/去重；不可猜 reference 不是权限。诊断和用户报告阶段分别 checkpoint，claim 丢失后先 reconcile，旧 revision 不能覆盖新 incident。原生报告回执按能力显示 delivered/not_observed，不从 Bot 声称或 HTTP 200 推断用户已读。

unknown 发送先查原生事实；没有查询/幂等时默认不盲重试，用户明确允许重复通知后才按预算重试。即便本地动作去重，原生重复触发的模型成本仍需披露，不承诺 exactly-once inference。来源文本诱导、拒绝事件或通知自身错误不能递归制造告警风暴。

## Executable acceptance

本票创建下列测试后运行：

```bash
bun test packages/box-runtime/test/template-notification-outbox.test.ts packages/box-runtime/test/template-notification-transport.test.ts test/ops-delivery-cli.test.ts
bun run typecheck
```

必须覆盖提交前/后崩溃、发送成功但 ACK 丢失、乱序/重复、租期过期双 worker、旧绑定/错 Bot/克隆、scope 更换、429/超时/3xx、DB 锁/满、进程恢复、rate limit/critical 保留配额、retention 后旧 reference。HTTP、原生 run、报告和维护计数分开断言。

secret sentinel 在请求中可以进入受控 adapter，但不能出现在 stdout/stderr/事件/异常/模板；固定目标不能被 Payload 换成内部服务或重定向目标。通知重试过程对 ControlResources/provider/model selection 的调用为 0。临时真实 SQLite/本地 Fake HTTP 与 packed Node 验证同一程序，不以直接调用 reducer 代替实际 CLI 路径。

## Forbidden / Non-goals

不做任意 URL 通知器、通用公网 receiver、第二 Server scheduler，不直接 `sendPrompt` 代替原生 Webhook 资格，不把 ack/snooze 当恢复，不以重投通知重做工具或维护。

## Done evidence / Next

关闭需 state machine、数据库 migration/故障测试、source 与 packed composition 证据；native Bot/run/report 的真实闭环仍由 T43/T50 分层签署。T46 消费配对接口，T47 消费 claim，不建立旁路。
