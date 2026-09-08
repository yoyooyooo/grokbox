# T28 — One Effect Controller program / finish the core cut

## Status
**Open · Phase 1 控制与整合出口。** 控制能力未闭合前不可开放 UI apply；本票不授权任何 live signal。

## Goal
把预检、lease、guardian、精确信号、等待、commit/recovery 收为一个 Effect operation program；CLI confirmed apply 和 reconcile 只走它，清除旧 inject/heal/manual 执行器与控制占位。

## Module / dirs touched
- `packages/runtime-kernel/src/commands.ts`、`ports.ts`、`internal/commands/{configuration,controller-operation,reconciliation}.ts` 及同目录纯 target/state rules。
- `packages/box-runtime/src/internal/io/{artifacts,authority,configuration,provenance,journal,observation}.node.ts`。
- `packages/box-runtime/src/internal/process/` 与 `roots/{controller.runtime,command.runtime,layers}.ts`；`src/runtime.ts`。
- `packages/cli/src/commands/runtime.ts` 仅 facade routing；`packages/runtime-kernel/test/controller.test.ts`、`packages/box-runtime/test/controller-io.test.ts`、`test/runtime-cli.test.ts`。

## Depends-on
[T25](T25-runtime-effect-root.md)、[T26](T26-runtime-host-fullstream.md)、[T27](T27-runtime-status-facets.md)。T22 独立，任何 live 前须完成。

## Forbidden
LegacyWitness、旧 fallback live ports、多个 coordinator/registry、manual 单独 signal 链、`tryPromise(oldWorkflow)`、每文件一个 Service、guardian 改父 Fiber、Scope 当事务、超时强杀官方/竞争进程、清 circuit 取绿。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs control` → `bun test packages/runtime-kernel/test/controller.test.ts packages/box-runtime/test/controller-io.test.ts test/runtime-cli.test.ts`；真实进程部分必须在 disposable roots/精确自有 PID 下运行。
2. 同一个 program 对无 confirm、错盒、预检缺失、错误 source/profile/compile、错 owner/topology/gateway、PID reuse、lease 冲突返回零 guardian/signal/spawn。首信号前有第二次新鲜复核，不用旧 CLI 参数当权威。
3. direct/transient 为同一 state machine 的真实策略；分别保留 gateway pid、stable Host identity、temporary supervisor 退出、official renewal、独立 guardian parent-death SIGCONT 的断言。不能仅测试函数返回 ok。
4. 每个 Effect acquire/IO/等待/commit 点故障或 interrupt 都有 receipt：signaled/partial/recovery-required/unknown；不造回滚。durable/ephemeral writer 分开；protected publish/read-back、同源 retention 及竞争 artifact 不被破坏。
5. 两次相同确认/ack 丢失/重启用同 operation identity 对账，不能第二次 signal；observer/tick 无隐式 mutation capability。只读观察和日志 compaction 权限分开，J13 writer 不迁移。
6. 结构 gate 证明旧 inject/deactivate/observeAndHeal/legacy manual 入口及 `runtime_not_ready` 控制占位无生产 caller；helpers 只保留批准范围，不改成通用 process executor。
7. 重跑 layout/codec/backend/binding/lifecycle/stream/status，以及 `bun run typecheck`、`bun run build`、`bun run verify:package` 全部通过；未闭合类型/占位/必需 proof 不得关闭 Phase 1。
8. **Astra 复审 exact SHA 的单程序、权限、资源与负对照**；给出 offline 完成与 L1 live-not-proven 的明确分界。无 live adopted canary 不声称已部署/全部官方能力验证。

## Non-goals / out-of-scope
WebUI、自动授予 watchdog 新权限、daemon/SSH runtime mutation、改 launch 产品语义/J13/Bun pin、现役 re-adopt 或测试1赋值。

## Related
[spec Controller](../roadmap/box-runtime-impl-spec.md#controller) · [delete](../roadmap/box-runtime-impl-spec.md#delete) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 1 §1.3](../roadmap/box-runtime-plan.md) · [ADR D8](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d8--effect-root-and-resource-ownership) · [既有 J13/G1/Bun 约束](../decisions/2026-09-07-offline-live-adjudication.md)
