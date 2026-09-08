# T29 — Shared WebUI/API boundary and second-writer protection

## Status
**Open · Phase 2。** 只有 T27/T28 的事实/命令 owner 可供 UI 使用；不在 UI 上补另一套业务程序。

## Goal
交付同盒 Overview、Bots/detail、Evidence 三个表面。CLI/API 共同配置入口在第二 writer 出现时补轻量防覆盖；prepare/confirmed apply/receipt/lifetime 与 CLI 同义。

## Module / dirs touched
- `packages/box-runtime/src/internal/console/{api,auth.node,client}.ts`、`console/browser/{main,state,overview,bots,evidence}.ts`/HTML/CSS。
- `packages/box-runtime/src/internal/roots/console.runtime.ts`、`src/runtime.ts`。
- `packages/runtime-kernel/src/internal/commands/configuration.ts`、相关 public command/contract；`io/configuration.node.ts`/`artifacts.node.ts` 的共享短锁 CAS。
- `packages/cli/src/registry.ts`/`program.ts`/`commands/runtime.ts`、`commands/runtime-roster.ts` 的显式 local Gateway 只读 bridge；`scripts/pack-runtime-helpers.mjs`。
- `packages/box-runtime/test/{console-api,console-state,console-browser}.test.ts`、`test/runtime-cli.test.ts`/`packaging.test.ts`。Playwright Chromium driver 只作 pin 的 dev dependency，由 Bun 测试驱动，不替换既有 runner。

## Depends-on
[T27](T27-runtime-status-facets.md)、[T28](T28-runtime-controller-cut.md)。T28 包含 inference/core gates；只读能力也不可绕过 console auth。

## Forbidden
另建 UI/kernel package 或 React/Query/SQLite 平台、API 直写文件、UI-only lock、通用路径/Profile/exec/RPC、GET 调用 prepare/repair、凭据复用/URL/argv 暴露、自动 outbox、browser/HTTP request 拥有 apply 生命周期。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs console` → console-api/state/browser 的真实测试；缺 browser 不 skip 成功。`bun run build`/`verify:package` 验证 Node20 同一 CLI 发布包可提供静态资产。
2. `runtime webui run` 只允许 loopback 和受控 port，拒绝远程 Profile；同盒 roster 与 runtime root/agentId 核对，身份不明不保存。CLI bridge 强制 local discovery/transport、复用既有 GatewayClient/redaction 后注入窄 callback；box-runtime 无 CLI 反向 import/重复 Gateway RPC 实现。
3. 独立 owner-only bootstrap login、HttpOnly/SameSite session、CSRF、精确 Host/Origin、body/rate limits 与安全 DOM 渲染均有正反例；日志/响应无 secret、apiKeyRef/credential URL、原始 provider body。GET 的 write/signal/模型 credential/provider counts 为 0；只读 roster 使用独立 Gateway auth 能力，secret 不回浏览器。
4. 实际两个并发进程 writer（CLI/API），在 lock 内重读 models/desired + expected configRevision，旧写冲突保留意图；无丢更新、无 old JSON 假回滚。单进程串行测试不够，不引入通用事务平台。
5. prepare 不 apply；confirmed apply 一次性绑定 exact target/revisions/operationId/期限。drift、double-click、ack 丢失、reload/断线只查同 receipt，不再次 dispatch；ok/HTTP 200 不能抹掉 recovery-required。
6. process Scope 持有操作/HTTP/owned modeld；关页不停止、重启不从 outbox 重放、关闭 console 不 stop borrowed service。两种所有权在实际 local fixture 中验证。
7. 浏览器实际操作登录→选择→保存→saved-awaiting-use→有证据的 observed；旧 revision/失败草稿保留、URL Bot/tab/filter 恢复、unassigned=official、route reset 明确禁用。缺 delivery/usage 显示 unknown，不从缓存猜。
8. CLI/API 返回同一语义 DTO；layout/control/status/stream 回归，**Astra 审 auth、CAS、生命周期和 browser proof**。访问现役实例不在本票默认授权内。

## Non-goals / out-of-scope
secret/catalog CRUD、chat composer、长期统计图、provider 检查花费、远程控制、后台命令队列、另一 controller、T14b。

## Related
[spec WebUI](../roadmap/box-runtime-impl-spec.md#webui) · [config](../roadmap/box-runtime-impl-spec.md#config) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 2](../roadmap/box-runtime-plan.md) · [ADR D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer) / [D9](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d9--early-minimal-t13-facets)
