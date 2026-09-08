# T31 — Qualify and implement Cursor SDK ModelBackend

## Status
**Open · Phase 3，qualification 未通过。** Cursor SDK 名称不证明其可禁用 Agent loop/工具或接受精确 snapshot。

## Goal
独立核定具体 SDK/package、local/cloud 运行面与 inference-only 能力，再实现一个 adapter；不依赖 pi 通过，也不把 Cursor 产品能力强装成 ModelBackend。

## Module / dirs touched
- 资格成立后创建 `packages/box-runtime/src/internal/backends/cursor-sdk.ts`；更新 `backends/registry.ts`/`roots/layers.ts`/相应 auth 能力。
- `packages/runtime-kernel/src/internal/selection/models.ts`/contract 的有限扩展，仍一个 parser。
- `packages/box-runtime/test/backend-conformance.test.ts`、自编 `fixtures/cursor-sdk/`；最小公开互操作事实放 `docs/upstream-integration.md`。
- package/lock 仅为 exact qualified SDK，不夹带其它 CLI/agent 依赖或升级。

## Depends-on
[T23](T23-runtime-model-backend.md)、[T24](T24-runtime-route-binding.md)、[T25](T25-runtime-effect-root.md)、[T26](T26-runtime-host-fullstream.md)。不依赖 T29/T30；T32 不等待本票。不因 WebUI deferred 而改合同。

## Forbidden
未核定就启动 cloud Agent/花费/仓库工作；SDK 隐式工具/多步/重试/auto-compact；继承另一用户/session 的 root/history/Memory；复用 Gateway/daemon/Sandbox/quota 凭据；final string shim 或另一个 kernel。

## Acceptance (executable)
1. exact SDK/version/执行面、auth/cancel/stream/state/reset/usage 的源证据与最小能力矩阵先经 **Astra qualification review**。必需能力不成立则 blocked/deferred，不创建貌似可用的 adapter、不将负资格当实现完成。
2. `bun scripts/verify-runtime-rebuild.mjs cursor` → `bun test packages/box-runtime/test/backend-conformance.test.ts -t 'cursor'`；协议 fixtures 自编且对应已核定 API。
3. 通过 production kernel/root，验证 Host-selected snapshot 唯一输入、tool execution/repo 写入/隐式 inference 均 0；stream/tool ids/JSON/serial policy/terminal/usage 按共同合同。
4. 资源/session 归明确 Scope；auth pin/verify、跨 Bot 隔离、cancel/断线/restart 不继续未知请求。复用 native session 需证明精确 reset，不证明则不复用。
5. registry 精确 kind 选择，无失败后转 AI SDK/pi；ready/Layer 构造不自动模型调用。配置/CLI/WebUI 仍共同规则且无 private SDK state。
6. layout/backend/binding/stream 回归与 **Astra 实现复审**；只有另行授权的 spec L2 才能声称 real SDK/provider qualification。无 cloud/现役账户操作默认授权。

## Non-goals / out-of-scope
Cursor Cloud Agent 管理、Sandbox/配额/Gateway 控制、工具执行、Host 替换、通用插件平台、T14b 或新调度器。

## Related
[spec backends](../roadmap/box-runtime-impl-spec.md#backends) · [ports](../roadmap/box-runtime-impl-spec.md#ports) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 3](../roadmap/box-runtime-plan.md) · [ADR D10](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d10--one-modelbackend-port-before-new-backends)
