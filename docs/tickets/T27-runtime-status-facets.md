# T27 — Early status facets / J13 writer boundaries

## Status
**Open · Phase 1 早期。** 主排期紧随 T21，依赖仅 T20；不等 streaming/UI/compact。本票在默认主链上；T29/WebUI 不在。

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

## 2026-09-13：服务范围与查询运行根对齐

真实`runtime status`不再把任意健康socket视为当前安装ready。复用T40的service-info/rootId，modeld facet增加可选的`scope`、`serviceEpoch`及实际观察时间；真实adapter输出matched/mismatch/unavailable/not_observed。匹配才ready，已知不匹配为false，旧服务/无法读取身份为null，只有确认路径缺少才按未运行报告；非法父路径/访问错误不是缺少。原始health仍只证响应能力，不变成准入依据。

CLI显式GROKBOX_RUN_ROOT必须传给同一观察器；无显式覆盖时保留原默认/injected adapter，避免新代码绕过测试或embedding选定的runRoot。`runtime-service-status.test.ts`用真实disposable Unix服务覆盖匹配/不同根/旧服务/无效目录/缺失；投影对未知scope和不安全epoch做白名单处理。所有status操作保持只读，不create/repair/clear circuit；T40的packed启动回执也观察对应service generation。schema保持兼容的字段增量，不新建第二状态解释器。固定计数和源码身份留来源票/日期回执；当前实际加载与未验项唯一索引到 [LIVE-MODELD-CUTOVER](LIVE-integration-validation.md#live-modeld-cutover)。

## T41复用边界（2026-09-12）

持续采集和SQLite/incident归[T41](T41-continuous-observation-and-alerting.md)。本票继续拥有原执行/控制事实及status语义，不迁J13、不让monitor重写Host terminal。T41可引用/索引现有安全事件；新增collector/incident事件有独立role和scope，不冒充provider或Host消息。GET仍零持久写；后台显式启动的collector写自己的观察是另一能力，不由GET隐式获取。

Box身份、Bot身份、source epoch、观察时间/lastSuccess/gap字段可被CLI与未来API同义消费；不在前端派生另一套健康判断。SQLite中旧projection无法授权当前执行，也不是已采到完整历史的保证。

## Non-goals / out-of-scope
真实 controller heartbeat/深层 trace 的无证据承诺、publication watermark 发明、自动恢复、UI、live sampling。深层 diagnostics 归 T33。

## Related
[spec status/J13](../roadmap/box-runtime-impl-spec.md#status-journal) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 1 §1.5](../roadmap/box-runtime-plan.md) · [ADR D9](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d9--early-minimal-t13-facets) · [T13 产品范围](T13-status-honesty-after-adopt.md)
