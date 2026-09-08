# T30 — Qualify and implement pi RPC ModelBackend

## Status
**Open · Phase 3，qualification 未通过。** 不从“pi 有 RPC”推断存在 inference-only backend；不能闭眼安装/接线。

## Goal
先证实一次明确 snapshot 的推理能满足共同合同，再接入一个 pi-rpc adapter；不把 Pi Agent loop 引进 Host。

## Module / dirs touched
- 资格成立后才创建 `packages/box-runtime/src/internal/backends/pi-rpc.ts`；更新 `backends/registry.ts`/`roots/layers.ts` 与 auth adapter 的对应能力。
- `packages/runtime-kernel/src/internal/selection/models.ts`/contract，仅新增必要的有限 backend/auth 配置；同一 parser，不加第二模型库。
- `packages/box-runtime/test/backend-conformance.test.ts`、自编 `fixtures/pi-rpc/`；最小公开互操作事实放 `docs/upstream-integration.md`。
- package/lock 仅用于已核定的精确依赖，Bun 更新，不引入私有 runner 作为 CI 依赖。

## Depends-on
[T23](T23-runtime-model-backend.md)、[T24](T24-runtime-route-binding.md)、[T25](T25-runtime-effect-root.md)、[T26](T26-runtime-host-fullstream.md)。不依赖 T29/T31，也不阻塞 T32；不因 WebUI deferred 而改合同。

## Forbidden
猜 JSON-RPC 2.0/Codex app-server 方法、hidden root/history/Memory、tools execution、auto-compact、SDK/CLI retry、repo 修改、跨 Bot session 复用、把完整 Agent final string 包成 inference、另建 binding/STEP ledger。

## Acceptance (executable)
1. 先提交 exact protocol/package/version/运行面、prepare/infer/stream/cancel/auth/usage 能力矩阵与 source-backed 反例；**Astra qualification review** 后才实现。不能满足 inference-only 则本 adapter blocked/deferred，资格报告可交付但不标 adapter done。
2. `bun scripts/verify-runtime-rebuild.mjs pi` → `bun test packages/box-runtime/test/backend-conformance.test.ts -t 'pi'`；fixture 精确模拟已核定协议，不凭命名自造消息。
3. 经过同一 public kernel/root 的显式 snapshot/selection/auth/STEP，实际计数工具执行=0、额外 inference=0、隐藏 history/root=0、repo 写入=0；不是直接测孤立 helper。
4. 取消、子进程退出、服务重启、auth 身份变化、交错工具 id、unknown terminal、missing usage 与输出预算都遵守共同 conformance。backend resource 归 service/TURN Scope，原 Host id 不被 native session id 替换。
5. 未注册/未证明能力拒绝，无 failover；正常 ready/Layer 构造零模型请求。新配置只更新现有 parser/API 安全 catalog，不在 CLI/UI 增加私有规则。
6. 复跑 layout/backend/binding/stream；公开只放合成 fixture/最小事实。**Astra 复审实现与证据**，真实 runner/provider 资格另需 spec L2 授权；fake 不证明真实协议可用。

## Non-goals / out-of-scope
Pi 整个 Agent、任意 command/plugin loader、工具执行、Host compact、改 Host/store、后台云 Agent 外派、为兼容而弱化 ModelBackend port。

## Related
[spec backends](../roadmap/box-runtime-impl-spec.md#backends) · [ports](../roadmap/box-runtime-impl-spec.md#ports) · [proof/live](../roadmap/box-runtime-impl-spec.md#review-live) · [plan Phase 3](../roadmap/box-runtime-plan.md) · [ADR D10](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d10--one-modelbackend-port-before-new-backends)
