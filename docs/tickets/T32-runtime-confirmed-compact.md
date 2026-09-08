# T32 — Confirmed overflow / Host compact / one recovery attempt

## Status
**Open · Phase 4，Host compact capability 与 provider qualification 未证明。** 本票不能以候选日志或旧 T14 observation done 作为恢复授权。

## Goal
在同一 STEP 程序中处理 confirmed context overflow：原 attempt 终止、无已放行内容/工具时调用 Host 自有 compact，取得新 snapshot，至多再推理一次。只升级当前 wire 到 v4，不留 v3 兼容路径。

## Module / dirs touched
- `packages/runtime-kernel/src/internal/inference/overflow-recovery.ts`、`step-program.ts`/`step-ledger.ts`、`contract.ts`、`ports.ts` 的 STEP-scoped HostCompact capability。
- `packages/box-runtime/src/internal/backends/provider-error.ts` 的 provider-specific confirmed classifier。
- `packages/box-runtime/src/internal/host/compact.ts`（资格通过才创建）、`context-codec.ts`/`modeld-client.node.ts`/`stream-codec.ts`。
- `packages/box-runtime/src/internal/wire/modeld-wire.ts`、`modeld/server.node.ts`；v4 及对应 exact bridge/profile receipt 接线。
- `packages/runtime-kernel/test/overflow-recovery.test.ts`、`packages/box-runtime/test/overflow-bridge.test.ts`、`modeld-wire.test.ts`；最小公开互操作事实。

## Depends-on
[T24](T24-runtime-route-binding.md)、[T25](T25-runtime-effect-root.md)、[T26](T26-runtime-host-fullstream.md)。另需 **Astra 审过的 Host compact seam（含挂起点可调用性）与非冲突 provider 证据**。不依赖 T29/T30/T31 完成。

## Forbidden
candidate/generic model_error 触发、从 durable 日志重建命令、HTTP payload-too-large 当 context overflow、跨账号/模型重试、改 Host STEP id、清 ledger、第二 summarizer/store.db prepend、错误 bubble 已释放后再偷偷恢复、第二 compact executor。

## Acceptance (executable)
1. 先资格审查实际 Host compact 可在等待 STEP 时被调用、不会因同一 Host loop 等待而死锁；未知/不支持即 blocked/unavailable，不能编造方法。额外 patch 另按 D2 精确审批。
2. `bun scripts/verify-runtime-rebuild.mjs compact` → `bun test packages/runtime-kernel/test/overflow-recovery.test.ts packages/box-runtime/test/overflow-bridge.test.ts packages/box-runtime/test/modeld-wire.test.ts`。
3. 同一 production kernel+wire+Host adapter fixture：attempt0 已终止但未结算 Host STEP；confirmed overflow、released text/tools=0 → 一个 compact-request → 同连接一个 resume-step 新 snapshot → attempt1 → 唯一 Host terminal。模型最多 2 次、compact 最多 1 次。
4. 原 TURN/STEP/binding/ServiceEpoch 固定；recovery nonce/attempt 绑定原连接/期限，消费一次。重复 completion、重连、旧代/错 tuple、旧 snapshot、取消或预算过期不能再次 dispatch。
5. auth+overflow（含 401）、429、generic 400/500、HTTP limit、EOF/timeout/断线/unknown、仅 candidate、已释放工具/文本均零 compact。错误 evidence 不带 raw body/secret，不从 provider 自报 id 关联。
6. compact 不可用、取消、无改善/仍超限、auth/authority 变化、retry 失败停止；原失败不先投递 bubble 再改口成功。Host compact 自身的未知完成如实记录，不虚构回滚。
7. v4 同票替换全部当前 wire caller，v3 拒绝零 effects；无协商降级/legacy decoder。重跑 codec/binding/lifecycle/stream/status/layout 与 Node20 pack；故意重复 resume 或把 401 升格的负例必须失败。
8. **Astra 复审恢复 authority、挂起点、attempt ledger 与负对照**。spec L3 real canary 另授权，仅 test0；offline fixture 不证明真实 compact 已可用。

## Non-goals / out-of-scope
默认每错 compact、Host Memory 产品/summary 实现、跨重启恢复未知 STEP、全 backend 支持、无限重试、全量上下文压缩或自动 live spend。

## Related
[spec recovery](../roadmap/box-runtime-impl-spec.md#recovery-diagnostics) · [wire](../roadmap/box-runtime-impl-spec.md#wire) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 4 §4.1](../roadmap/box-runtime-plan.md) · [ADR D3](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d3--host-context-and-memory-ownership) / [D11](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d11--confirmed-overflow-host-recovery)
