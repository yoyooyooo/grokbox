# T27 — Early status facets / J13 writer boundaries

## Status
**Open · Phase 1 早期。** 主排期紧随 T21，依赖仅 T20；不等 streaming/UI/compact。

## Goal
建立一份 status DTO、六 facets 与安全本地相关性。当前接缝有证据、controller 是否活着、允许 mutation、operation recovery、Host delivery 分开；保留真实 circuit，不留旧聚合 status 兼容解释。

## Module / dirs touched
- `packages/runtime-kernel/src/status.ts`、`contract.ts`、`ports.ts`、`internal/status/projection.ts`。
- `packages/box-runtime/src/internal/io/{observation,journal,authority}.node.ts`、`host/terminal-journal.node.ts`、`wire/modeld-probe.node.ts`、对应 roots readonly wiring；probe 不导入 Host session 或 server。
- `packages/runtime-kernel/test/status-facets.test.ts`、`packages/box-runtime/test/host-journal.test.ts`、`test/runtime-cli.test.ts`。

## Depends-on
[T20](T20-runtime-layout-cut.md)。未接通的 modeld/controller 如实 unknown/not_ready；T24–T28 补真实源，不新增第二 projector。

## Forbidden
把 attested 当总体健康、把 degraded 当 heartbeat、自动清 circuit、旧/新 status DTO 并行、从最近时间戳/provider body 猜 id、provider finish 冒充 SendToUser/App delivery、GET repair/compact 日志、J13 writer 迁到 modeld。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs status` → `bun test packages/runtime-kernel/test/status-facets.test.ts packages/box-runtime/test/host-journal.test.ts`，以及 CLI status 场景。
2. attested+open circuit+无 pending；pending/invalid/unavailable journal；unknown liveness；modeld ready；旧代/缺失/截断事件各有独立 oracle。输出 source/observedAt/gap，不能混成一格 green/degraded。
3. readonly counted ports 的 write/signal/credential/provider/compaction 计数均 0；故意接 repair 或误关 circuit 的负例被抓住。
4. Host append 只写 Host terminal/reject，modeld/control 只写各自事件；watchdog 唯一 compactor。校验角色 allowlist、并发 append/compaction、去重/失败 gap；不搬 J13，不添加 terminal-report IPC。
5. 本地 tuple 相关，不完整字段 unknown，不投射 provider 自报 id。日志/JSON/stdout/stderr 无合成 secret/prompt/error body sentinel。Host journal 失败不阻塞回复、不重跑。
6. 旧 durable 记录不删除，不支持 schema 报 gap；新 status 唯一 projector，不保留旧 watchdog.state 的第二解释。`layout` 及 **Astra 六 facets/角色/负对照复审**通过。

## Non-goals / out-of-scope
真实 controller heartbeat/深层 trace 的无证据承诺、publication watermark 发明、自动恢复、UI、live sampling。深层 diagnostics 归 T33。

## Related
[spec status/J13](../roadmap/box-runtime-impl-spec.md#status-journal) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 1 §1.5](../roadmap/box-runtime-plan.md) · [ADR D9](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d9--early-minimal-t13-facets) · [T13 产品范围](T13-status-honesty-after-adopt.md)
