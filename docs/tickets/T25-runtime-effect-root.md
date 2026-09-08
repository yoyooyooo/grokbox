# T25 — Long-lived Effect root / A9 / v3 modeld transport

## Status
**Open · Phase 1。** 引入生产长寿命根时同票关闭 acquire/finalizer；不留“之后再修 A9”。

## Goal
让唯一 kernel 运行在有完整资源 ownership 的 modeld root，Host/client 与 server 物理分离；只提供 v3，无旧 wire/response-only server。

## Module / dirs touched
- `packages/box-runtime/src/internal/roots/{layers,modeld.runtime,command.runtime}.ts`、`src/runtime.ts`。
- `packages/box-runtime/src/internal/modeld/server.node.ts`、`wire/modeld-wire.ts`/`modeld-probe.node.ts`、`host/modeld-client.node.ts`；root 的 ModeldControl ensure 与只读 probe 分开。
- 必要 `io/authority.node.ts`/`configuration.node.ts`/`credentials.node.ts` 接线；无业务规则迁进 adapters。
- `packages/box-runtime/test/modeld-wire.test.ts`、`modeld-lifecycle.test.ts`、`runtime-pipeline.test.ts`、`fixtures/`；`test/runtime-cli.test.ts`。

## Depends-on
[T24](T24-runtime-route-binding.md)。ModelBackend/STEP 程序来自 T23/T24，资源 root 不复制它们。

## Forbidden
`tryPromise(bindUnixKernel)` 返回后才注册 finalizer、全流程 uninterruptible、每请求 ManagedRuntime、无 owner timer/Fiber、旧 v2 协商/fallback、terminal.parts、竞争 socket 搬移还原、借用服务 stop、process-name kill。

## Acceptance (executable)
1. `bun scripts/verify-runtime-rebuild.mjs lifecycle` → modeld-lifecycle/modeld-wire；同时 `binding`、`backend`、`layout`。
2. allocation→listen→readiness 的每个间隙注入 failure/interrupt/late callback；正常 release 条件下 owned listener/socket/fiber/lease 计数必须归零，旧 late-bind 泄漏 mutant 必须失败。单独注入 release 自身失败时应返回 cleanup gap/失败并阻止 falsely-ready；不能拿该分支豁免普通路径泄漏或宣称成功关闭。
3. 真实 Node20 disposable Unix process 覆盖 startup/abort/stop 重入/competing path/borrowed service。验证底层 close 对 pathname 的实际影响；不能先移动对手文件再恢复。不能证明则 blocked，不放宽 ownership 断言。
4. v3 exact-key/UTF-8/size/sequence/malformed/extra frame 拒绝；v2 明确拒绝，零 auth/provider。health 只证明服务 readiness；旧协议或不答 health 的已连接服务仍不能被清理。modeld graph 不提供 ConfigurationWrite/ControlResources，测试须证明写/信号 capability 不可解析，而非仅这次没有调用。
5. 同 TURN 缓存 ServiceEpoch/bindingId；重启的旧 STEP/新 STEP 均不重握旧 TURN。server 只把 frame/sink 接 `runStep`/`cancelStep`；同一 runtime/Layer graph，无 server-local registry。
6. backpressure、partial socket timeout、不同资源预算、stop deadline、driver 不配合/迟到成功均有明确收尾与 unknown；不把取消当远端已经停止。
7. `runtime modeld run` / prepare 复用同一 root；新建服务由 foreground process 持有，borrowed 不释放。signal listener 注册/移除对称，import 或 Layer 构造不发 provider 请求。
8. actual CLI + Unix + SDK mock 的 root 证明及构建/Node20 package 检查；**Astra 审 Scope 树、partial acquire、协议与关闭证据**。Host fullStream 完整出口仍由 T26 关闭。

## Non-goals / out-of-scope
Host effect 化、controller 重写、WebUI、旧协议 migration shim、无限 shutdown、真实 provider/adopt 或跨重启 exactly-once。

## Related
[spec wire](../roadmap/box-runtime-impl-spec.md#wire) · [Effect root](../roadmap/box-runtime-impl-spec.md#effect-root) · [proof](../roadmap/box-runtime-impl-spec.md#proof) · [plan Phase 1 §1.3–1.4](../roadmap/box-runtime-plan.md) · [ADR D8](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d8--effect-root-and-resource-ownership)
