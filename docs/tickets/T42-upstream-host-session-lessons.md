# T42 — 外部 Host 会话坑记录（grok-bot-setup）

## Status
**Record / incubate · 2026-09-13。** 不是当前主链施工票，不授权改 Host 补丁形态、不授权打 temporal/Gateway proxy、不授权整盒 Provider 开关。只把 [BlockedPath/grok-bot-setup](https://github.com/BlockedPath/grok-bot-setup) 里值得对照的 Host 会话合同坑记下，方便以后展开。关闭条件由后续 owner 在本票或并入 T21/T23/T26 时另定。

## Why this exists
外部项目同样挂钩 Host `createSession`，用一份 OpenAI Chat Completions 适配器换掉 Cursor 推理流。他们整盒切换、直接改 `host-main.cjs`，管不了 temporal，也做不到逐 Bot。我们更细（confirmed_box + `models use --for`）。仍值得记下他们已经撞过的 **Host ABI** 坑，避免以后换 Provider 或隐私模式时重踩。

上游材料（不 vendoring、不当公共 CI 依赖）：

- `docs/GUIDE_CUSTOM_INFERENCE.md` §4 Three bugs、§9 message/tool conversion、§10 host restart
- `docs/GROK_BOT_CLAUDE_FIXES.md`（stream 合同、usage、Redacted、tool id、assistant-last）
- `xai-prompt-session.cjs`（他们的 session 实现）

## Already aligned（不要再抄）

| 他们的坑 | 我们现有位置 |
|---|---|
| `getState()` 返回 `{ messages }` → `plainMessages.map is not a function` | [`session.ts`](../../packages/box-runtime/src/internal/host/session.ts) `getState`/`getMessages` 为数组 |
| 工具 `parameters.jsonSchema` 未拆 → HTTP 400 object root | [`context-codec.ts`](../../packages/box-runtime/src/internal/host/context-codec.ts) Host 工具 registry unwrap |
| `stream()` 异步、`response`/`fullStream` 抢同一份 chunk | 同 `session.ts` 同步 handle + 独立 replay |
| usage 用 OpenAI `prompt_tokens`；缺 `response.modelId` / `response.messages` | `normalizeHostUsage`、finish `HostResponse` |
| hook `require` 失败 fallback Cursor | 配置错误 **不** 静默回官方（T24） |
| 改磁盘 `host-main.cjs` + 升级再注入 | preload；见 [T40](T40-persistent-release-and-rollback.md) |
| 整盒一个 Provider | [T24](T24-runtime-route-binding.md) 逐 Bot |
| 杀 `sand-supervisor` | 禁止；官方 supervisor 拉 Host |

## Parked for later（换 Provider / 隐私模式再展开）

展开时写回本票或并入下列 owner，不要另起平行 session 实现。

| 点 | 何时才值得做 | 可能落点 | 不要做成 |
|---|---|---|---|
| Host 内部 `sand-default` / flash 等 id | 摘要/内部 session 打到错误模型时 | 选模/aux 资格，不是一律映射 grok-4.6 | 未知 id 全改成生产模型 |
| 隐私模式 `Redacted*` | managed 因 Redacted 变 `unsupported_content` | codec unwrap 对齐 Host `unsafe_always_allowed` 用途 | 静默丢字段 |
| Provider 侧 tool id `[A-Za-z0-9_-]` | 上 Claude 等拒 LF/符号 id | **仅** provider encode；Host 关联仍用原生 id | 改写 Host toolCallId |
| assistant 收尾补 `(continue)` | 目标模型拒 prefill | CCS/该 backend | 污染 Host 历史 |
| Host 重启后 App 硬刷 gateway token | 客户端重连/replica | 操作说明；不是推理层 | 当 Host 补丁能根治桌面 echo |

## Forbidden
- 把本票当成下一刀实现授权或 T39/T40 前置。
- 吸收他们的 in-place host-main 补丁、整盒 `adapters use`、失败回 Cursor、temporal/Gateway MITM。
- 把外部仓库或 `xai-prompt-session.cjs` 引进公共构建。

## Related
- [T21 codec](T21-runtime-codec-fidelity.md) · [T23 backend](T23-runtime-model-backend.md) · [T24 选模](T24-runtime-route-binding.md) · [T26 fullStream](T26-runtime-host-fullstream.md)
- [`session.ts`](../../packages/box-runtime/src/internal/host/session.ts) · [`context-codec.ts`](../../packages/box-runtime/src/internal/host/context-codec.ts) · [`ccs-codec.ts`](../../packages/box-runtime/src/internal/backends/ccs-codec.ts) · [`session-hook.ts`](../../packages/box-runtime/src/internal/host/session-hook.ts)
- 外部对照：https://github.com/BlockedPath/grok-bot-setup
