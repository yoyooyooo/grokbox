# T33 — Source-scoped diagnostics / delivery evidence gaps

## Status
**Open · Phase 4。** T27 最小 facets 已先交付；深层观察不要求 compact 或所有 backend 完成。

## Goal
在同一 status/observation owner 下扩展安全关联、retention/cursor/gap、operation 与 Host delivery 观察。每条推断必须有同源证据；没有能力就明确 not_observed。

## Module / dirs touched
- `packages/runtime-kernel/src/status.ts`、`contract.ts`、`internal/status/projection.ts`。
- `packages/box-runtime/src/internal/io/{observation,journal,provenance}.node.ts`；可靠 Host 只读事实使用同 owner 的窄 adapter，不增加 writer。
- T29 浏览器 MVP 若已显式落地，只更新 `packages/box-runtime/src/internal/console/browser/evidence.ts` 的 safe DTO 消费；未落地不创建 `console/` 或另一 UI。
- `packages/box-runtime/test/diagnostics.test.ts`、`packages/runtime-kernel/test/status-facets.test.ts`、合成 source/epoch fixtures。

## Depends-on
[T27](T27-runtime-status-facets.md)、[T28](T28-runtime-controller-cut.md)。不依赖 T32/T30/T31；UI 消费可后接。

## Forbidden
时间最近邻拼因果、用进程 PID/model finish 当 App delivery、缺日志当零调用、自动补发模型/SendToUser、改 Host publish cursor、SQLite 审计权威、日志 body dump、以观察功能偷偷 repair/adopt。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs diagnostics` → `bun test packages/box-runtime/test/diagnostics.test.ts packages/runtime-kernel/test/status-facets.test.ts`。
2. source id/epoch/sequence/observedAt/cursor 定义清晰，retention、缺页/截断、source 重启、错误 generation、pending/unknown operation 有独立 vectors；不能跨代合并成完整时间线或精确错误率。
3. 有 source-backed Host watermark 能力时，只读核对同一来源；没有则明确 not_observed 并记录缺口。unsupported fallback 分支必须有测试，但不能拿它声称 delivery capability 已完成。
4. provider terminal、Host normalized、SendToUser executed、App observed 分层；模型已结束但未见交付时零 replay/repair/signals/credential/provider effects。counter 负例可抓住误触发。
5. journal/compaction 并发保持 J13 分工，截断或不支持的历史 schema 只报 gap，不删除历史或猜补关联。JSON/UI/log/export 均只用安全 DTO。
6. 复跑 status/control/layout；**Astra 复审 claim ceiling、来源/缺口与负对照**。真实 Host 读取/现役观察若需要，另获授权；未证明能力保留 blocked/未完成项，不能用全绿关闭产品义务。

## Non-goals / out-of-scope
新 trace/analytics 平台、收费计量、authoritative SQLite、Host/store writer、自动恢复、compactor 产品或 provider SDK 行为改造。

## Related
[spec status/J13](../roadmap/box-runtime-impl-spec.md#status-journal) · [recovery/diagnostics](../roadmap/box-runtime-impl-spec.md#recovery-diagnostics) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 4 §4.2](../roadmap/box-runtime-plan.md) · [ADR D9](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d9--early-minimal-t13-facets)
