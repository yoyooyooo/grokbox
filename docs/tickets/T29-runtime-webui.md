# T29 — Shared command/API boundary and second-writer CAS

## Status
**Open · Phase 2 · 默认主链外。** 不是 T28 之后的下一张施工票，也不授权现在做浏览器控制台。T27/T28 的 facts/commands 才是 CLI/API 的业务程序；UI 不得另写一套。依赖满足也不自动开工，须另排期。

## Goal
把未来 UI 必须共用的内核/CLI 边界写死：同一 `commands` / `status`、唯一 `ConfigurationWrite`、第二 writer 才出现的共享短锁 CAS，以及命令边界上的本盒 identity/authz。本票默认压力是这份合同，不是 Overview/Bots/Evidence 产品 UI。

## Kernel / CLI 必须预先暴露（T20–T28 也要守）

- `kernel/commands` 与 `kernel/status` 是 CLI 与未来 API 的唯一业务程序；console 不得成为第二 admission/controller。
- `ConfigurationWrite` 是唯一配置写 port。单 writer 阶段只做 schema/gate、protected stage、read-back/sync/rename 与回执。真实第二 writer 出现时，在**同一入口**加短锁 → canonical 重读 → expected `configRevision` → mutation/publish；CLI 同时接入。不建通用 CAS 服务、revision DB、UI-only lock 或 SQLite SoT。
- 命令边界绑定本盒 runtime root / agentId；拒绝任意 current Profile 拼接或远程 Profile。身份不明不保存。
- GET/只读观察零 write、零 signal、零模型 spend。
- `packages/box-runtime/src/internal/console/`、`roots/console.runtime.ts`、`runtime-roster.ts` 与 browser 资产均为 **later / T29-only**；T20 不建空目录、假 API 或 Playwright。

## Module / dirs touched

仅在本票被显式排期施工时创建，且先合同、后（可选）UI：

- `packages/runtime-kernel/src/internal/commands/configuration.ts` 的第二 writer 短锁 CAS；`io/configuration.node.ts` / `artifacts.node.ts` 共享入口。
- 未来 API root：`packages/box-runtime/src/internal/roots/console.runtime.ts`、`src/runtime.ts` 接线。
- CLI：`packages/cli/src/commands/runtime.ts` / `registry.ts` / `program.ts`；roster bridge 仅在需要同盒 Gateway 只读时才建 `runtime-roster.ts`。
- **不要**在把本票当边界合同时提前铺 `console/browser/**`。

## Depends-on

[T27](T27-runtime-status-facets.md)、[T28](T28-runtime-controller-cut.md)。CAS 可在任何真实第二 writer 出现时提前落到同一入口。浏览器 MVP 不是关闭 Phase 1 或开始本票的条件。

## Forbidden

另建 UI/kernel package 或 React/Query/SQLite 平台、API 直写文件、UI-only lock、通用路径/Profile/exec/RPC、GET 调用 prepare/repair、第二业务程序、把本票当作 T28 后默认主链、T20 创建 `console/`。

## Acceptance (executable) — 边界/合同

1. CLI 已走的 commands/status/config write 与未来 API 是同一 public program；结构检查禁止 console 复制选择/admission/controller。
2. 第二 writer 路径存在时：两个并发进程（CLI + 另一 writer）在 lock 内重读 models/desired + expected configRevision；旧写冲突保留意图，无丢更新、无 old JSON 假回滚。单进程串行不够。无第二 writer 时不假装已有 CAS。
3. 本盒 identity/runtime root 绑定；错盒/远程 Profile/身份不明拒绝写入。
4. 只读观察 counted ports 的 write/signal/credential/provider 为 0。
5. **Astra 审共享入口、CAS 时机与 identity 绑定。** 浏览器 MVP 不是本条关闭条件。访问现役实例不在本票默认授权内。

## Deferred UI MVP

完整产品表面与浏览器验收见 [plan Phase 2](../roadmap/box-runtime-plan.md)（T15 范围）。仅在本票被显式授权做 console 时才适用，且必须挂在上述同一边界上：

- 入口 `grokbox runtime webui run`，只绑定 loopback 与受控 port；拒绝远程 Profile。
- 有限 API：GET status/bots/catalog/events/operation；POST selection/prepare/preview/confirmed apply。无路径/RPC/exec passthrough。
- 独立 console 会话认证（owner-only bootstrap、HttpOnly/SameSite、CSRF、精确 Host/Origin）；不复用 Gateway/provider/daemon 身份。secret 不放 argv/URL/日志。
- same-box roster 经 CLI 窄 callback 复用既有 `GatewayClient`/redaction；box-runtime 不反向 import CLI、不复制 Gateway RPC、不读 Host SQLite。Gateway secret 不回浏览器。
- Overview / Bots/detail / Evidence 只显示 API 事实；draft/saving/saved-awaiting-use/observed 分开。URL 拥有 Bot/tab/filter。route reset 明确禁用。
- process Scope 持有操作/HTTP/owned modeld；关页不停止、重启不从 outbox 重放、关闭 console 不 stop borrowed service。
- Playwright Chromium 仅作 pin 的 dev dependency、由 Bun 测试驱动，不替换既有 runner。缺 browser 环境阻塞 UI proof，不能 skip 后宣称通过。headless reducer/API pass 不能冒充 UI proof。

该小节不进入 T20 骨架，也不在默认主链上产生施工压力。

## Non-goals / out-of-scope

secret/catalog CRUD、chat composer、长期统计图、provider 检查花费、远程控制、后台命令队列、另一 controller、T14b、把 WebUI 当 Phase 1 出口。

## Related

[spec WebUI 边界](../roadmap/box-runtime-impl-spec.md#webui) · [config](../roadmap/box-runtime-impl-spec.md#config) · [tickets](../roadmap/box-runtime-impl-spec.md#tickets) · [plan Phase 2](../roadmap/box-runtime-plan.md) · [ADR D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer) / [D9](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d9--early-minimal-t13-facets)
