# T43 — 原生 Webhook 能力资格与事件合同

## Status / Goal

**Planned · Spec-only · 尚无 native qualification。** 将用户确认存在的「Webhook routine 接收 Payload」转成有来源、有版本、可替换的窄能力，固定 grokbox envelope 与缺失证据的表示。Owning contract：[Spec §2](../roadmap/template-ops-automation-spec.md#baseline)、[§5](../roadmap/template-ops-automation-spec.md#payload)。本票是接口资格，不借验证直接开启监控或维护。

## Depends-on / Modules

无新票前置；复用现有 Gateway capability 路由、template-recipe 与 T41 notification policy。

目标：`packages/cli/src/gateway-automation.ts`、`packages/runtime-kernel/src/ops.ts`、`internal/ops/notification.ts`、`ports.ts`、`packages/box-runtime/src/internal/io/template-notify.node.ts`。最小上游事实写入 `docs/upstream-integration.md`，实际用法与限制写入维护手册。private DTO 不穿透 kernel，box-runtime 不 import CLI。

## Work

核实原生 routine 的 create/read/disable/delete、trigger 类型、endpoint/secret 获取与轮换、Payload 原样/文本/包装投影、长度/编码/空对象、运行中重复触发、接收回执、run/result correlation、重试和任务删除语义。分别记录 source-backed / synthetic / native-observed / unknown；不知道就返回能力 gap，不编造接口。

验证 template stage/import/clone 到底复制什么：当前 `routines[].content` 与原生任务是否同一对象、是否默认启用、是否产生独立 endpoint/secret、能否阻止 publisher 的活绑定泄漏。不支持安全导入时落实 blueprint + install-time create 的同一产品路径。

定义 grokbox v1 envelope、错误类别、固定目标 NotificationTransport、原生 capability 版本与失效条件。任何 raw payload 都只能成为受限候选；no arbitrary URL/command，低级错误正文不回显。

## Executable acceptance

实现时新增 `test/native-webhook-contract.test.ts` 和 `packages/runtime-kernel/test/ops-notification-contract.test.ts`，执行：

```bash
bun test test/native-webhook-contract.test.ts packages/runtime-kernel/test/ops-notification-contract.test.ts
bun run typecheck
```

测试文件是本票交付物，目前尚不存在。必须覆盖：JSON/空 Payload/Unicode/超限、未知 schema/危险字段、错 scope、版本变化、native accepted 无 run receipt、signature 能力缺失、429/超时/断连、重定向拒绝、secret sentinel 零输出。Fake 与 Live 实现同一 port，不用 Fake header 假设真实上游支持。

独立授权后，用一次性官方模型测试 Bot 和无害合成 marker 做 create → POST → observed run → report → disable 的原生验收；通过原生支持的接口清理本测试拥有的任务。记录最小安全事实，真实 IDs/URL/secret/私有源码留在受保护现场，不进 git。未执行时声明 `native: not_proven`，不阻塞纯合同与 Fake 测试交付。

## Forbidden / Non-goals

禁止把用户确认功能存在当作所有接口已验证；禁止直接改产品 SQLite、在模板存活 webhook secret、把其他厂商的签名/重试当上游事实。无 Host restart/adopt、无模型兼容探针、无通用任务调度器、无公共 ingress。

## Done evidence / Next

关闭需提供实现路径、测试命令/构建、adapter 能力表及已完成或缺失的 native 证据；没有 native 资格时只关闭 offline 子集，live gate 保留。T44/T45 可据冻结合同推进 Fake 纵切，不替本票编造 live success。
