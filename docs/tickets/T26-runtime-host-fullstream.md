# T26 — A8 Host fullStream / bidirectional round trip

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · Phase 1 推理整合出口。** 必须删除 T20 inference 占位；只通过 lower mapper 或最终 response 的测试不能关闭本票。

## Current delivery routing (2026-09-12)

[T37](T37-server-ownership-admission.md)拥有Server证据与执行门；本票负责将它接到真正Host异步准入/流消费者，保持同步session API，不仅在CLI做预检。[T38](T38-identity-write-alignment.md)拥有错误身份writer退场；不在本票另写reconcile或覆盖profile。

完整官方/A/B/官方持续会话与原版App旅程由[T39](T39-native-model-roundtrip.md)编排并签集成证据；本票交付真实输入、原生状态/工具/交付的双向合同和错误行为。发现缺陷仍回本票修，而非由T39另造session。T36的Working语义是并列必要门；T40负责最终发布/卸载。

真实正例必须Server确认box；test2只保留T38冲突反例，不沿用旧heavy或历史回复当成功。原App不改；所有直接发往Server的请求超出Host可截获范围，不能以补丁压住本地box伪装可用。

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
2. **同一 production root + 真实 v4 Unix + SDK mock fetch + Host consumer**。terminal Deferred 未释放时，Host 已见首 chunk，且 response 未结算。buffer-all mutant 必须失败；不以耗时小于某数猜真流。
3. Host 立刻 getModelId/getExecutor/stream，同步得到 fullStream/response/usage/extendedUsage/providerMetadata/invocationId；Array getters 独立、append/clear/非法 state 行为明确，modelId/finish/response 一致。
4. early/late/no reader、取消单 reader、UI/transcript fork 与 slow reader 均不重复 provider/tool effects、不阻塞 completion。output budget 达界可见失败而非 silent drop；EOF/缺 terminal 不成功，usage unavailable 不造账单。
5. 一次 Host 工具调用/结果/无 Human 插入的下一 STEP，经两个 API 的实际请求保真；唯一 Host tool counter、独立 UI/transcript reader。unknown/缺 STEP/重复 STEP/迟到 cancel 不重放旧工具。
6. tool id/name/JSON/serial policy/interleaving/重复 complete 全向量；失败前已释放内容如实记录，不声称零副作用。双 profile root 恰好一次，未知 root/未经批准 patch 零 provider。
7. J13 只记 Host normalize/reject，model terminal 不冒充 delivery；write failure 不改变回复或重跑。真实 preload contribution/import-time fence 与 Node20 package 通过。
8. 推理 `runtime_not_ready`/旧路径调用/compat shim 全部消除；**Astra 审端到端原始计数、barrier oracle、真实入口与 notProven**。offline Done 后才可申请 spec L1，不能自行 live 或让 test1 opt-in。

## 2026-09-12 App 警告反例的当前差额

- Owner 的生产模型确定为 grok-4.6。本轮针对真实 STEP `00000000-0000-4000-8000-000000000123`：先有 SendToUser 进度，之后 Host parallel-tools 拒绝，modeld 记录断连取消；不能用前一条消息关闭工具链验收。
- 已落盘：`createStreamingPromptSession` 将 fail-closed 工具策略写入 canonical `parallelToolCalls:false`；原输出侧的多调用拒绝保留，违约时零 executable release，错误阶段为 normalize。SDK e2e 核对 attempt0/恢复的实际请求参数。
- 已落盘：Host normalized terminal 增加 terminalClass/errorCode/toolCallCount/modelId，rejection 增加stepId。当前warning快照、事件订阅、nonce/request结果对账见 [运行结果观测](../maintainers/run-outcome-observation.md)，沿用原日志owner，不创建第二任务数据库。
- 最新增量：SDK length/content-filter明确失败；纯reasoning/空白/空输出不得以stop成功退出，保留managed failure provenance。`incomplete-response.test.ts` 的5个反例先红后绿，合法tool-only保持成功；已并入现有stream verifier。
- **2026-09-13 live：** grok-4.6 在 Read 之后用 assistant text 收尾，Host 不渲染普通文本。session 在声明了 `SendToUser` 且无其它 tool-call 时，把非空文本折成 Host 可执行的 `SendToUser`；runtime 不自己写 transcript。aux/无该工具的 STEP 不发明交付。
- 结果关联不再只认首STEP：实际Agent＋TURN＋serviceEpoch可关联后续工具/发送/失败；错Bot、错TURN、缺epoch不能猜，跨epoch变unknown。正反例见 `test/outcome.test.ts`，日志与命令仍为原owner。
- 历史1037/0窗口及其部署后续已被新的ownership读取版本推进，旧PID/制品不再在本票充当当前事实；版本、操作、原nonce与最新1069/0等证据只认[readiness](../maintainers/t32-live-enable-readiness.md)。历史随机挑战的受理/未取得完整结果不升级成成功；模型真实两请求合成工具证明也不替代原生Bot/App旅程。本票仍未关闭，本轮文档治理没有新跑这些测试。

## Non-goals / out-of-scope
Host core/session-store重写、compact retry、新backend、自建WebUI或App代码修改、自动re-adopt、正式live SLA。**原版App真实输入/显示的互通资格在本票范围内**，不是上述UI开发非目标；完整旅程由T39汇合。

## Dual-transcript acceptance delta (2026-09-12)

**Latest owner boundary: Host-only, no App patches/re-sign/injection.** The desktop discoveries below are compatibility requirements, not authority to edit renderer/coordinator. Qualify a Server-confirmed Box identity and original-App path before claiming managed support; an App→Server main-model request that bypasses Host cannot be intercepted by our Host leaf. Local harness retention is not a completed server migration. Server query/update/migration facts are linked from the [harness current home](../maintainers/transcript-harness-box-vs-server.md#current-host-only-boundary-2026-09-12).

Provide T39 with native-consumer roundtrip evidence for official→custom A→custom B→official on the same Bot/session/root, including tools, Memory and checkpoint/reload; T24 owns selection and T39 owns the complete journey, not a second session implementation. A passed custom-only stream or returning an untouched originalSession does not prove official can resume the custom-written durable state. No harness flip, duplicate Bot, transcript splice or silent content drop may substitute for this proof.

Owner observed one canary alternating between old and current App histories. A deliberate temporal→box switch can expose another ledger, but continued alternation is not stable delivery and deleting the canary does not close it. CLI roster/event projection now retains explicit harness (otherwise unknown); `history outcome` brackets each observation with fresh roster reads and accepts `--expect-harness box|temporal` (`--runtime` requires box). Sampled route changes, omissions or mismatches cannot produce an expected-result pass, even with colliding entry IDs and text. See [harness current home](../maintainers/transcript-harness-box-vs-server.md#acceptance-must-not-mix-transcript-sources) for meaning/limits and `test/transcript-route.test.ts` for regression.

This closes a CLI observation gap, not the desktop coordinator/cache defect. The follow-up Mac Accessibility read has now observed the selected test2 window showing the old history, while the Box route is box; the per-IPC order and current coordinator map are still unobserved. Original App-function replay (11 assertions, private grok-bot probe) additionally proves that cached restore and server roster alter the actual `sendPrompt` destination, not only display. Detailed mechanism remains in the [harness current home](../maintainers/transcript-harness-box-vs-server.md#actual-desktop-recheck-2026-09-12); no private App code is copied into this public repository.

**Release dependency, not a new model loop:** V16/V19 require a real App-originated nonce correlated to the intended managed route, followed by tool/SendToUser and the displayed result; test cached startup, reconnect/Host generation change, late server roster, and an unchanged legitimate temporal control. The same per-Agent source decision must govern send/read/subscription/install; a global source event is not enough. This is not deferred as T36 composer cosmetics. Current Host/CLI proofs remain valid for their own surfaces but do not close this desktop dependency.

Preserve the mixed-history Bot as a counterexample and keep clean-Bot production acceptance separate. No store merge, profile rewrite, Bot deletion or Host re-adopt is part of this observation change. Implementation/real App regression of the routing repair is still pending.

Actual Mac App/cache inspection now identifies two desktop writers beyond omitted-harness stickiness: cached temporal restoration and server roster classification/merge. The original-function isolated replay reproduces box→temporal→box with the global legacy source off; details and private evidence stay in [harness current home](../maintainers/transcript-harness-box-vs-server.md#actual-desktop-recheck-2026-09-12) and the sibling research document it links. This is not a production fix. Stable desktop delivery requires authority-aware routing plus old-response/replica fencing; another Host re-adopt alone is not an acceptance strategy.

## Related
[spec Host output](../roadmap/box-runtime-impl-spec.md#host-output) · [chain](../roadmap/box-runtime-impl-spec.md#chain) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 1 §1.2/1.4](../roadmap/box-runtime-plan.md) · [ADR D1](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d1--bidirectional-normalization) / [D7](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d7--true-streaming-in-phase-1)
