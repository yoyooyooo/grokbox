# FEAT — 同通道模型推理设置

Status: implemented; final offline qualification in progress; not deployed.
Source branch: `feat/model-reasoning-policy`, based on v2 `f8c82c0`.
Authority: [Spec S11](../roadmap/box-runtime-impl-spec.md#model-reasoning-policy), [ADR](../decisions/2026-09-17-model-reasoning-policy.md). This ticket does not authorize runtime adoption, live model calls or publication.

## 实现范围与出口

| 范围 | 实现与离线 oracle |
|---|---|
| 配置/命令 | schema v2 structured assignment；v1 只读归一化；显式 use/default/reset/migrate；未知字段及 unsupported effort 在写入和外部 I/O 前拒绝；CAS 复用 |
| 能力 | catalog 的明确 wire effort 白名单，unknown/unsupported 区分；Pi 只接受显式身份映射，不从 boolean/model name 推断 |
| TURN 身份 | policy/capability 纳入 selectionRevision；deep-frozen resolved record；冷恢复验证完整选择；同 STEP 不因改档重跑 |
| 请求编码 | 锁定 SDK 的 Grok Responses 丢档反例；SDK settings merge；实际 fetch 前 Chat/Responses 白名单编码、冲突拒绝、保留 wire model/并行/预算/工具 |
| 观测 | configured-next-turn 查询，requested/emitted 与 Provider unknown 分层；bounded SDK warnings；reasoningTokens 为可选 completion 子集；CLI/Host/daemon 标题 e 独立 |
| 协议 | wire v7；旧 v4/v5/v6 有限只读诊断，不能执行；原 Host prompt envelope/ownership/Effect owner 不变 |
| 隔离集成 | actual Host hook → Unix → production modeld → fake HTTP；磁盘 TURN high/high → cold high → new TURN xhigh；回执与重复请求计数验证 |

新增 executable suites：`reasoning-selection.test.ts`、`reasoning-backend.test.ts`、`reasoning-command.test.ts`、`reasoning-binding.test.ts`、`reasoning-unix.test.ts`、`reasoning-packed.test.ts`。测试只使用合成凭据、owned temporary roots 与可控 Provider，没有现役 Host/Bot 写入或真实模型消费。

## 非 live 关闭要求

完成 pinned Bun 1.3.14 / 最低 Node 20.17.0 的类型、全库、打包及 Host import fence 复验并在本票记录结果。早期 Bun 1.4.2 定向绿色不是 pinned release gate。代码作者自审不能代替项目所要求的独立复审；独立 reviewer receipt 当前 `not-recorded`，属于本票非 live blocker，不能改名塞进 LIVE。

## 需要真实环境的出口

只在 [LIVE-REASONING-CUTOVER](LIVE-integration-validation.md#live-reasoning-cutover)、[LIVE-REASONING-PROVIDER](LIVE-integration-validation.md#live-reasoning-provider)、[LIVE-REASONING-HOST-APP](LIVE-integration-validation.md#live-reasoning-host-app) 记录实时状态与回执。必须先映射到固定 v2 集成提交，再单独确认对象、预算、窗口及回退制品。没有经过资格验证的 Provider 回报时，执行档位保持 unknown；tokens/时延不是 xhigh 证明。
