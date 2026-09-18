# T45 — 固定现场通知、原生 Webhook 与投递对账

## Status / Goal

**Planned / Spec-only；M3。** [Spec §4/§5.4/§6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。把已固定的故障摘要、ID和取证命令送给配置目标Bot；默认仅提醒，不自动执行取证或Issue。

## Depends-on / Modules

依OBS-02/03证据与视图、T43 transport、T51/T54最小目标合同；Fake可先行，T53/T46完成原生接收集成。不依赖T47/T48/T49/T52/T56/高级多Bot路由。

kernel `internal/commands/ops-notification.ts`及policy/routing；box-runtime原SQLite扩outbox/attempt/budget/claim域、`native-notification.node.ts`，由monitor宿主有界Scope装配。

## Work

同incident/occurrence/阶段稳定workId；准备工作只在固定manifest可读后ready，缺证可partial。冻结evidenceRevision/目标/binding/dataPolicy，默认inline安全摘要足够提醒。最多一主一补充只读command descriptor；不发完整JSON/任意shell，标box-local限制。

发送前短事务预留attempt和可能的唤醒额度，事务外网络。保存native-accepted/definitely-not-accepted/unknown，Bot报告单列。崩溃在attempting先对账，不自动POST；HTTP接受不代表用户收到。可用native claim仅返回安全摘要、验证真实caller与租约；没有能力不伪装身份隔离。

unknown默认不重投/不切备用；确定未接收有限退避，遵守安装/目标/发生周期预算。关闭/撤销阻止未发，不取消用户任务。TTL15min、有限待办与恢复合并摘要、source重放floor及去重退役接OBS-04；目标长期不在线不无限排队，通知失败不递归报警。

## Executable acceptance

待新增：

```bash
bun test packages/box-runtime/test/ops-notification-outbox.test.ts packages/box-runtime/test/ops-webhook-delivery.test.ts test/ops-notification-cli.test.ts
bun test packages/box-runtime/test/alert-observability-store.test.ts
```

临时真实DB/HTTP＋Fake原生Bot，注入prepare/manifest/commit/reserve/POST后崩溃，证明游标/证据不丢，未知不会重复创建工作或唤醒。多进程争领、错误binding/旧revision/预算耗尽/同Bot多alias、禁用、断网、过期恢复、恶意payload均有断言；网络实际bytes通过OBS-03投影。

固定native通知回执与Bot report引用，提醒不执行diagnostic/GitHub/control，无回应不再唤醒。原生模型消耗无法硬限制时明确notProven，不以本地请求数冒充token上限。

## Forbidden / Non-goals / Exit

不sendPrompt代Webhook、不要求Bot常驻poll、不复活旧未知动作、不在SQLite事务内网络/模型。实际目标/消息链看[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)和[OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)；本地callback returned不是交付资格。
