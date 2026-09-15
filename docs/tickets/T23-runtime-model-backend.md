# T23 — One Effect ModelBackend / auth port (T16 foundation)

## Status
**Open · Phase 1。** 在新 backend 前先交付 DI 合同；不是保留 ModeldDriver.complete 的兼容包装。

## Goal
用 AI SDK + behavioral Fake（和显式 echo）建立同一个 ModelBackend prepare/infer 与 scoped auth 合同。根选择实现，kernel 拥有准入；此票不把未完成 kernel/root 宣称可 serving。

## Module / dirs touched
- `packages/runtime-kernel/src/ports.ts`、`contract.ts`、`selection.ts`、`testing.ts` 及所属 internal 文件。
- `packages/box-runtime/src/internal/backends/{registry,ai-sdk,openai-prompt-adapter,openai-events,provider-error,echo}.ts`。
- `packages/box-runtime/src/internal/io/credentials.node.ts`、`roots/layers.ts`。
- `packages/runtime-kernel/test/backend-contract.test.ts`、`packages/box-runtime/test/backend-conformance.test.ts`、`openai-prompt-adapter.test.ts`。

## Depends-on
[T20](T20-runtime-layout-cut.md)、[T21](T21-runtime-codec-fidelity.md)。消费程序 T24、长期生产 root T25 接同一合同，不新造转换 port。

## Forbidden
- ModeldDriver/As1GeneratePort + ModelBackend 双合同、complete[] 桥、accepts 扫描/fallback、SDK maxRetries、server-side tools、Agent loop。
- 每 helper Service、每请求 Runtime、provider schema/SDK 类型流进 Host/kernel DTO。
- prepare 读 auth/环境或发网络；静默丢 schema/工具名；raw Cause/body/snippet 外泄。
- Fake 成为生产 fallback；echo 绕过 admission 或硬编码 fixture usage 充账单。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs backend` → kernel backend-contract + box-runtime backend-conformance；同时重跑 `codec` 与 `layout`。
2. prepare 零 credential/network，返回同一 PreparedCall；infer 只消费一次 cold Stream。Fake 和 SDK mock 接相同 port/conformance，不替换业务规则。精确 kind 查找，未知 kind 明确拒绝。
3. Fake auth pin/verify 与真实本地合成 secret file reader 覆盖 no-follow/nonblocking/regular-file、fingerprint、修改/缺失/取消；secret 仅可在 adapter lease 内使用，不进入 wire/DTO/日志。Scope 关闭释放 lease，无中途刷新/换账户。
4. 真实 SDK mock fetch 消费 T21 的唯一 codec；实际 egress bytes 超限为零请求。工具只带 schema，无 execute；多 reader/重消费/错误重试的请求计数不增加。
5. 流事件验证 interleaved ids、name 关联、冲突/缺名/坏 JSON、EOF、usage 缺失和固定 error whitelist；auth+overflow 冲突不升格 confirmed。canonical events 不携 Host finish.response。
6. root Layer 构造不发模型请求，不读取未被请求使用的 auth；临时测试 Scope 不冒充生产 root。移除旧 as1/default/complete API 与 raw encoder 旁路的所有 caller。
7. `typecheck`/相关 tests/build 与 **Astra port、credential、SDK boundary 复审**；T24/T25/T26 未完成处明确 notProven，不能以本票接线默认 live。

## Non-goals / out-of-scope
完整 RouteBinding/STEP ledger、A9 production listener、Host fullStream、pi/Cursor SDK 安装、WebUI、compact 或任何真实 spend。

## Related
[spec ports](../roadmap/box-runtime-impl-spec.md#ports) · [config](../roadmap/box-runtime-impl-spec.md#config) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 1 §1.3](../roadmap/box-runtime-plan.md) · [ADR D8](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d8--effect-root-and-resource-ownership) / [D10](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d10--one-modelbackend-port-before-new-backends)
