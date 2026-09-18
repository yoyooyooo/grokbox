# T43 — 原生 Webhook 与 Routine 能力资格

## Status / Goal

**Partial qualification；2026-09-18：已完成4项固定源函数隔离探针，真实HTTP/唤醒/模型与配对链仍未验收。** [Spec §5.4/§10.1](../roadmap/template-ops-automation-spec.md#payload)拥有合同。验证Grok Bot原生事件唤醒，不新增scheduler，不把普通sendPrompt或模板正文当Webhook能力。

## Depends-on / Modules

可与OBS-00/T51并行；给T53通用Routine和T45固定目标transport提供合同。kernel `routines.ts`/ports；CLI `gateway-automation.ts`；box-runtime `io/native-notification.node.ts`，装配不能形成box-runtime→CLI导入。

## Work

核对原生routine/automation/trigger映射、exact IDs/revision、disabled创建、read/update/enable/disable/delete、认证/大小/编码、payload进入Bot的形状、接受与run/report关联、是否有CAS/幂等及clone/import隔离。保存最低公开兼容事实和合成fixtures，不把私有上游源码当公共依赖。

内部NotificationEnvelope不是上游DTO；只允许已绑定endpoint/secretRef，无任意URL、重定向或凭据回显。原生不支持签名/去重/调用身份就明确unsupported/notProven，不照搬其他产品Webhook语义。模型唤醒前无法拒绝伪造流量时披露成本/信任边界，不能开放自动维护。

默认brief载荷足以提醒，不要求完整JSON或诊断工具；原生caller身份/工具隔离资格与简单通知分开。普通聊天使用custom model不证明Webhook回合使用它，交T55单独资格。

## Executable acceptance

已新增`packages/box-runtime/test/native-routine-qualification.test.ts`，显式`GROKBOX_TEST_NATIVE_HOST=1`时对照既有固定源SHA，仅执行选定函数与受控边界；4项通过、0失败，29断言。默认公共测试跳过，不复制或依赖私有源码构建。它不启动Host，不读取真实Bot状态，不代替下面的原生HTTP旅程。上游事实文档的本轮更新被工具拦截，仍为待同步项，没有记为已落盘。

待新增：`packages/runtime-kernel/test/native-routine-contract.test.ts`、`test/native-webhook-adapter.test.ts`。运行这两项及`bun run typecheck`。Fake native/临时HTTP验证错身份、旧revision、无认证、超大/未知payload、编码、禁用、重定向和ACK丢失；真实POST参数不能来自自由文本。

原生证明须另获一次性Bot/请求/费用/清理授权，使用实际CLI disabled→enable→POST→run/report→update→disable，清理只涉及已终结测试资源。没有权限就保留native未证，不阻塞Fake合同施工。

## Forbidden / Non-goals / Exit

不创建现役Routine、不复制endpoint/secret、不自动选模或启用Host，不触发Issue。交付adapter能力表/原生版本失效条件/source-fixture测试，实际资格只登记[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)。
