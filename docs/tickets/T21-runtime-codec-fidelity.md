# T21 — Host context / CCS codec fidelity (A3fu + A7)

## Status
**Open · Phase 0。** 保真优先，T22 raw-output 不得成为本票前置。路径均按[实施规格](../roadmap/box-runtime-impl-spec.md#layout)，不补回 POC 路径。

## Goal
把 Host-selected input 保真变为 canonical snapshot，再通过唯一 CCS codec 进入实际 Chat/Responses 请求。保留 root、user-contained/mixed tool results、关联和长尾，不另选历史。

## Module / dirs touched
- `packages/runtime-kernel/src/internal/contract/context.ts`、`src/contract.ts`：canonical 类型/校验/预算。
- `packages/box-runtime/src/internal/host/context-codec.ts`、`host/profile.ts`：仅已批准 ABI decode/root provenance。
- `packages/box-runtime/src/internal/backends/ccs-codec.ts`；必要工具 schema 映射同 owner，不引入第二 raw encoder。
- `packages/box-runtime/test/host-codec.test.ts`、`ccs-codec.test.ts`、`fixtures/`。

## Depends-on
[T20](T20-runtime-layout-cut.md)。T23 尚未提供 Live Backend 时，用真实 SDK + mock fetch 消费此生产 codec；T23/T26 必须把同一 oracle 接入完整生产路径。

## Forbidden
- 1500/8000 字符截断、关键词删行、默认 near-window、store.db prepend、隐式 attachment/tool/schema drop。
- 用额外 Human user 让 continuation fixture 成功；CCS 恢复 raw Responses role=tool；测试 raw encoder 与生产 live encoder 两条路径。
- 根据可疑字段猜 root 为空/重复拼 root；把 Host 私有 shape 或 SDK 类型导出到 kernel。
- 未经 D2 证据/批准加 patch；从 private Host dump 复制 fixture。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs codec`；直接测试为 `bun test packages/box-runtime/test/host-codec.test.ts packages/box-runtime/test/ccs-codec.test.ts`。
2. 真实 AI SDK mock fetch 捕获两个 API 的最终 JSON body：原工具 call → user.content result（含 mixed text）→ 无新 Human turn 的 STEP。独立 expected 断言 id/name/result/isError、顺序与长尾；mapper 输出本身不是 oracle。
3. 覆盖 tool-role/user-contained、长 args/results >1500/8000、空字符串/false/0/中文、正文引用 SAND_HIDDEN/ack-redrive；无静默丢块。明确超过安全 bytes 时拒绝，不截短到成功。
4. 两个自编 Host profile（root 在 state / root 独立）证明 required root 恰好一次；缺失/未知 provenance/不支持内容在 provider 前失败。tools/options/schema 不携 execute/getter；坏 schema 不 catch/continue。
5. 负对照移除结果/尾部/root 或注入额外 Human/raw-tool 后，oracle 必须失败。保留 A1/A2 脱敏与缺 STEP 零 replay 向量，后者在 T26 完整入口复验。
6. `layout` gate 继续通过；提交 request 的合成断言/计数、来源范围和 notProven。**Astra 审 actual SDK body 与 oracle**；本票不是 Host live/端到端 streaming 证明。

## Non-goals / out-of-scope
A6、RouteBinding、provider spend、新 backend、compact/retry、Host store/session loop 重写、默认 live caps。Provider→Host 输出实现归 T26；本票不留另一输出 ABI。

## Related
[spec contracts](../roadmap/box-runtime-impl-spec.md#contracts) · [chain](../roadmap/box-runtime-impl-spec.md#chain) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 0 / Phase 1 §1.2](../roadmap/box-runtime-plan.md) · [ADR D1](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d1--bidirectional-normalization) / [D3](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d3--host-context-and-memory-ownership) / [D4](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d4--fidelity-first-phase-0)
