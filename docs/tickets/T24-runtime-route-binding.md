# T24 — RouteBinding / selection fence / STEP program

## Status
**Open · Phase 1。** 唯一内核入口为 `@grokbox/runtime-kernel/inference`；A5 在 request-specific credential/provider effects 前关闭。

## Goal
实现一次 admission/producer、TURN 不可变选择、STEP 去重和拒绝语义。旧 TURN 不能经 TTL、新 STEP 或重启偷偷重绑；不同 Bot 保存不误伤当前 binding。

## Module / dirs touched
- `packages/runtime-kernel/src/inference.ts`、`ports.ts`、`contract.ts`、`selection.ts`。
- `packages/runtime-kernel/src/internal/inference/{route-binding,step-ledger,step-program,stream-state}.ts`。
- `packages/box-runtime/src/internal/host/selection.node.ts`、`io/configuration.node.ts`、`io/authority.node.ts`；单独有界同步读与 Effect 读复用同一 pure parser。
- `packages/runtime-kernel/test/{selection,route-binding,step-ledger}.test.ts`；相关 Fake Layers。

## Depends-on
[T23](T23-runtime-model-backend.md)（传递依赖 T20/T21）。T25 wire/root 消费本票的真实程序，不能另实现一份 server admission。

## Forbidden
main fallback、Host projection 文件族、configRevision 冒充 selectionRevision、首 STEP 请求后才比 modelId、掉线重试、STEP 取消释放 TURN 后再选、旧 id LRU 驱逐重投、每 request 新 Runtime。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs binding` → `bun test packages/runtime-kernel/test/selection.test.ts packages/runtime-kernel/test/route-binding.test.ts packages/runtime-kernel/test/step-ledger.test.ts`。
2. Host selection 捕获后、server canonical read 前的 barrier 修改同 modelId endpoint/ref、删除 opt-in；拒绝且 auth/provider 计数均为 0。其它 Bot 变化不改当前 selectionRevision；无覆盖的 Host 路径保持 exact originalSession。
3. 明确首次选择接受的线性化点；之后普通配置保存只影响新 TURN，不要求跨文件原子事务。credential/authority 等等待后再验证相同 pin、activation、取消；拒绝后的迟到异步完成不能 dispatch。
4. 同 TURN 后续 STEP 使用 bindingId + 原 model/auth/ServiceEpoch；长工具空档、首 STEP abort、credential 改变、idle expiry、服务重启均保留旧身份或显式拒绝。缺 ack/token 不当作新 TURN，零静默 re-pin。
5. key 含 HostEpoch/agent/TURN/STEP；同时保留前一个 STEP 的迟到 cancel。相同 key 同输入只返回 duplicate metadata，改输入 conflict；缺/坏 STEP 拒绝，零旧工具 replay。
6. 同 TURN concurrent STEP 为 turn_busy；不同 TURN 可并发。1024 ledger 或注入小上限满额明确 capacity，旧 id 不被驱逐重跑。Fake TestClock/barrier 证明，不靠等待若干毫秒。
7. ModelBackend.prepare 在 auth 前零外部 effects；只有 admitted 程序消费一个 backend stream。terminal/unknown/拒绝迁移有 oracle，取消后 chunks/success 不回流。
8. `backend`/`codec`/`layout` 回归，移除旧 resolveAssignment/ModelPin lifetime/第二 ledger 的执行 caller；**Astra 审身份、竞态、负对照与单生产路径**。T25/T26 未接通前不宣称 Host end-to-end。

## Non-goals / out-of-scope
WebUI CAS、复杂 revision store、无限历史退休、真实 provider、compact retry、部署或 re-adopt。

## Related
[spec contracts](../roadmap/box-runtime-impl-spec.md#contracts) · [binding](../roadmap/box-runtime-impl-spec.md#binding) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 1 §1.1](../roadmap/box-runtime-plan.md) · [ADR D5](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d5--thin-host-visible-selection) / [D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer)
