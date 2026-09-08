# T26 — A8 Host fullStream / bidirectional round trip

## Status
**Open · Phase 1 推理整合出口。** 必须删除 T20 inference 占位；只通过 lower mapper 或最终 response 的测试不能关闭本票。

## Goal
Provider canonical events 真实流回原 Host session/fullStream/response/usage 合同，由 Host 继续存会话、工具循环与 SendToUser。完成整条双向链，不新增 Agent loop。

## Module / dirs touched
- `packages/box-runtime/src/internal/host/{session,context-codec,stream-codec,modeld-client.node,terminal-journal.node}.ts`、`src/preload.ts` 接线。
- `packages/runtime-kernel/src/internal/inference/stream-state.ts`；若改 contract，全部 caller 同票切换。
- `packages/box-runtime/test/host-session.test.ts`、`host-fullstream.test.ts`、`runtime-pipeline.test.ts`、自行编写 Host consumer/profile fixtures。
- pack/import gate 及必要 runtime inference facade 的占位撤销。

## Depends-on
[T21](T21-runtime-codec-fidelity.md)、[T24](T24-runtime-route-binding.md)、[T25](T25-runtime-effect-root.md)、[T27](T27-runtime-status-facets.md)。复用 T27 的 J13 writer 协议，不能因此迁移 writer。

## Forbidden
最终 parts 回灌假 streaming、40ms fork delay、fullStream tee 驱动 response/usage、requireStepId=false/lastHandle、并行 PromptSession shim、内部 toolCalls 别名、假 usage、Host 内 Effect/SDK、runtime 代执行工具/store/SendToUser。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs stream` → `bun test packages/box-runtime/test/host-session.test.ts packages/box-runtime/test/host-fullstream.test.ts packages/box-runtime/test/runtime-pipeline.test.ts`；回归 codec/binding/lifecycle/status/layout。
2. **同一 production root + 真实 v3 Unix + SDK mock fetch + Host consumer**。terminal Deferred 未释放时，Host 已见首 chunk，且 response 未结算。buffer-all mutant 必须失败；不以耗时小于某数猜真流。
3. Host 立刻 getModelId/getExecutor/stream，同步得到 fullStream/response/usage/extendedUsage/providerMetadata/invocationId；Array getters 独立、append/clear/非法 state 行为明确，modelId/finish/response 一致。
4. early/late/no reader、取消单 reader、UI/transcript fork 与 slow reader 均不重复 provider/tool effects、不阻塞 completion。output budget 达界可见失败而非 silent drop；EOF/缺 terminal 不成功，usage unavailable 不造账单。
5. 一次 Host 工具调用/结果/无 Human 插入的下一 STEP，经两个 API 的实际请求保真；唯一 Host tool counter、独立 UI/transcript reader。unknown/缺 STEP/重复 STEP/迟到 cancel 不重放旧工具。
6. tool id/name/JSON/serial policy/interleaving/重复 complete 全向量；失败前已释放内容如实记录，不声称零副作用。双 profile root 恰好一次，未知 root/未经批准 patch 零 provider。
7. J13 只记 Host normalize/reject，model terminal 不冒充 delivery；write failure 不改变回复或重跑。真实 preload contribution/import-time fence 与 Node20 package 通过。
8. 推理 `runtime_not_ready`/旧路径调用/compat shim 全部消除；**Astra 审端到端原始计数、barrier oracle、真实入口与 notProven**。offline Done 后才可申请 spec L1，不能自行 live 或让 test1 opt-in。

## Non-goals / out-of-scope
Host core/session-store 重写、compact retry、新 backend、UI、自动 re-adopt、正式 live SLA。

## Related
[spec Host output](../roadmap/box-runtime-impl-spec.md#host-output) · [chain](../roadmap/box-runtime-impl-spec.md#chain) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 1 §1.2/1.4](../roadmap/box-runtime-plan.md) · [ADR D1](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d1--bidirectional-normalization) / [D7](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d7--true-streaming-in-phase-1)
