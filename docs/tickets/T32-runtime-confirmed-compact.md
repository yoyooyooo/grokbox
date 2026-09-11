# T32 — Confirmed overflow / Host compact / one recovery attempt

## Status
**Open · Phase 4；Host core的限定等待点资格已固定，runtime接线/provider资格尚未完成。** [接缝资格与死锁边界](T32-host-compact-seam.md)记录直接调用core的条件性source+隔离切片证明、精确挂起点和实现gate；不是已安装capability或live证明。本票不能以候选日志或旧T14 observation done作为恢复授权。

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
candidate/generic model_error 触发、从 durable 日志重建命令、HTTP payload-too-large 当 context overflow、跨账号/模型重试、改 Host STEP id、清 ledger、第二 summarizer/store.db prepend、grokbox near-window/产品CAP、错误 bubble 已释放后再偷偷恢复、第二 compact executor。不得用queued summarizeAction或触发Host外层五轮error retry替代当前STEP-scoped delegate。

## Acceptance (executable)
1. 按[已固定接缝](T32-host-compact-seam.md)实现main runStep等待点的有界delegate，直接复用当前orchestrator/root/stateHandler；对现有pending summary、未审hook/资源链、未ready/旧tuple/取消等返回blocked/unavailable。此次仅证明限定native方法等待关系；完整production bridge、state/metadata保真及取消/晚完成负例仍须通过，额外patch按D2精确审批。
2. `bun scripts/verify-runtime-rebuild.mjs compact` → `bun test packages/runtime-kernel/test/overflow-recovery.test.ts packages/box-runtime/test/overflow-bridge.test.ts packages/box-runtime/test/modeld-wire.test.ts`。
3. 同一 production kernel+wire+Host adapter fixture：attempt0 已终止并确认quiescence但未结算Host STEP；confirmed overflow、released text/reasoning/tools=0 → 一个compact-request → 同连接一个resume-step新snapshot → attempt1 → 唯一Host terminal。目标managed STEP推理最多2次、Host compact invocation最多1次；Host内部summary provider重试独立计数并受总期限约束，不冒充所有HTTP总数≤2。
4. 原 TURN/STEP/binding/ServiceEpoch 固定；recovery nonce/attempt 绑定原连接/期限，消费一次。重复 completion、重连、旧代/错 tuple、旧 snapshot、取消或预算过期不能再次 dispatch。
5. auth+overflow（含 401）、429、generic 400/500、HTTP limit、EOF/timeout/断线/unknown、仅 candidate、已释放工具/文本均零 compact。错误 evidence 不带 raw body/secret，不从 provider 自报 id 关联。
6. compact 不可用、取消、无改善/仍超限、auth/authority 变化、retry 失败停止；原失败不先投递 bubble 再改口成功。Host compact 自身的未知完成如实记录，不虚构回滚。
7. v4 同票替换全部当前 wire caller，v3 拒绝零 effects；无协商降级/legacy decoder。重跑 codec/binding/lifecycle/stream/status/layout 与 Node20 pack；故意重复 resume 或把 401 升格的负例必须失败。
8. **Astra 复审恢复 authority、挂起点、attempt ledger 与负对照**。spec L3 real canary 另授权，仅 test0；offline fixture 不证明真实 compact 已可用。

## Non-goals / out-of-scope
默认每错 compact、Host Memory 产品/summary 实现、跨重启恢复未知 STEP、全 backend 支持、无限重试、全量上下文压缩或自动 live spend。

## Live residual
Owner **unlocked** GATE + live overflow dogfood 2026-09-11 evening ([readiness](../maintainers/t32-live-enable-readiness.md)). Default-off is unchanged. Near-`SNAPSHOT_JSON_MAX_BYTES` fills fail `stream_invalid` (`normalize/stream_shape`, eventCount 0) before CCS overflow codes — still not an overflow recipe. test0 transcript polluted; overflow canary is **test2** (`harness=box`). `harness=temporal` skips the patched `createSession`. Bounded CCS luna ping still completes **ok**. Grok absorb landed a **default-off** modeld CCS intercept (`GROKBOX_MODELD_OVERFLOW_CANARY_AGENT` + `GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS`) that emits allowlisted `context_length_exceeded` without upstream; it is not real provider W and not a mini Sub2API patch. Live test2 with canary on (generation `de0e870b-…`) produced **no first_chunk**, `model_step_terminal` cancelled/`disconnected` eventCount 0 attempt 0, Host retry storm, **no resume**. Canary env restored **unset**. Next lever: live `bindHostCompactHook` / D2 slot (Host CF), not another overflow pad.

## Related
[spec recovery](../roadmap/box-runtime-impl-spec.md#recovery-diagnostics) · [wire](../roadmap/box-runtime-impl-spec.md#wire) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 4 §4.1](../roadmap/box-runtime-plan.md) · [ADR D3](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d3--host-context-and-memory-ownership) / [D11](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d11--confirmed-overflow-host-recovery)
