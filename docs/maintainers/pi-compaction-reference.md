# Pi compact 实现参考与 grokbox 差异

**参考审查：2026-09-17；不是运行手册或功能完成证明。** 当前产品决策归 [ADR](../decisions/2026-09-17-local-context-maintenance.md)，实现合同归 [Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)。不要直接修改生产参数或运行 Pi 来代替 grokbox 的 Host 状态维护。

## 固定参考，而非浮动 main

检查的发布包：`@earendil-works/pi-coding-agent@0.85.1`，声明 MIT。官方 [v0.85.1 release](https://github.com/earendil-works/pi/releases/tag/v0.85.1) 与 Git tag 解析到 `d981de1229ef899957bbe968bc8dcda02a21f477`。本次逐段检查的是该已安装发布包的 JS；以下源码链接用于公开定位，不声称 TS 与编译 JS 的字节相同。安装路径、用户模型配置、凭据和真实会话不进入本页。

| 发布包相对路径 | 本次检查字节 SHA-256 | 定位范围 |
|---|---|---|
| `dist/core/agent-session.js` | `fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f` | prompt 821–949；自动判定 1634–1728；执行/重建 1739–1867 |
| `dist/core/compaction/compaction.js` | `3d5f1f2a3e801c965214717b6abad1839239b4a030517bffdf0c8eff25df5c2a` | 默认/估算/阈值 74–165；切点/prepare/compact 函数 |
| `dist/core/session-manager.js` | `ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3` | buildSessionContext 与 appendCompaction |

公开源码：[`agent-session.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts)、[`compaction.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/compaction.ts)、[`session-manager.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts)、[compaction 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/compaction.md)。版本升级须重读，不以这里的行号或浮动分支给新版本背书。

## 行为对应表

| Pi 0.85.1 中检查到的机制 | grokbox 采用 / 调整 | 证明入口 |
|---|---|---|
| `prompt()` 在构造新 user 消息前等待 `_checkCompaction(lastAssistant, false)`；该路径可检查中止响应 | 新输入是旧会话维护机会；额外覆盖没有 assistant 的首请求，并把本次输入/注入计入预算 | CTX-A01/A03 |
| agent loop 的 context transform 检查工具结果之后的待发消息 | 不只在 TURN 尾检查；下一次主模型 HTTP 前必须已经合格 | CTX-A04 |
| `shouldCompact` 比较 `contextTokens > contextWindow - reserveTokens`；默认 enabled，reserve=16384，keepRecent=20000 | 用本地窗口控制；保留易解释的预留/近期预算，但按真实输出预算及最终请求额外限制 | CTX-A02/A05 |
| 估算优先最近有效 usage + 后续消息；error/aborted/全零 usage 不作为基线；无 usage 可纯估算 | 错误不清零；基线还绑定 root/模型/编码/策略，unknown 不造精确值 | CTX-A03/A06 |
| 自动判定避免用最近 compact 之前的消息 usage/error 重触发；错误的旧模型也不能直接驱动新模型恢复 | 用 root revision/compaction boundary 而不只比较墙钟；切模型按新窗口重新 preflight | CTX-A06/A07 |
| 合法 cut point、近期保留与 split-turn prefix summary | Host 合法分区/工具组；不移植 Pi session 格式，不按数组下标盲切 | CTX-A08/A09 |
| `appendCompaction(summary, firstKeptEntryId, ...)` 后 `buildSessionContext()` | 映射到 Host archive/carrier/root/checkpoint；新进程回读验收 | CTX-A12 |
| overflow 恢复受一次尝试限制；失败消息保留历史但不污染恢复输入 | 复用 T32 更窄的零放行/同 STEP 合同；不照搬对 partial/length 的继续策略 | CTX-A13 |
| 手动和自动经过共享的摘要生成底层 | 共享一套维护程序，手动操作使用独立 operation，不伪造 native STEP | CTX-A14 |

以上是对代码行为的有界解释，不等于 Pi 能处理任意大小输入、所有错误或所有插件组合。尤其不能把“调用检查函数”提升为“每一次新消息都会进行摘要”。

## 必须补强，而非照抄

**完整待发输入。** Pi 上述 prompt 检查点早于追加新消息；grokbox 在旧历史维护时预留新输入，最终将 system/tools/pins/Memory/附件/工具结果及协议投影一起计量。没有最近 assistant 也不能跳过。

**估算与实际用量分开。** Pi 的字符启发式用于估计，不是跨 tokenizer 的上界证明。我们保留来源、误差/安全余量；有效 usage 的缓存字段按 adapter 语义避免重复累计，reasoning 是输出子集。Host 大窗口先有有界本地计量/分段，不能先制造超限 IPC 快照再请求维护。

**输出预留与目标预算。** 固定 reserve 不能小于本次实际允许的输出预算；小窗口配置不得产生负输入预算。新摘要必须在同一个最终编码器下低于目标，不仅更新 tokenBefore 或看到消息数下降。

**依赖与取消。** grokbox 的 Host/modeld 是两个进程，root 会被下一 STEP 复用；需要真实 root owner、generation/revision fence、摘要 source 与等待者寿命、有限请求/期限和 crash 对账。不能直接复制进程内布尔值或数组替换来承担这些职责。

**摘要路径和持久化。** 专用摘要请求拥有可信 purpose、独立身份和预算、无业务工具；Host 决定分区/摘要格式并写 root。长期历史分段/合并不是新的 Agent loop；不能以 provider backend 自己的 auto-compact 掩盖 Host 中仍然很大的窗口。

## 当前 grokbox 复用与真实差额

基线：`7994b92`（包括统一配置和 reasoning schema v2/wire v7）。后续源码变化须重新核对下表；本页不记录运行中的 PID、endpoint 或原始事故标识。

| 当前源码 | 已有性质 | CTX 接收的差额 |
|---|---|---|
| `kernel/internal/inference/overflow-recovery.ts` | 同 tuple、零放行、一次恢复；无 HostCompact 即拒绝 | 主动/手动维护与失败重试账本分离，共用实际维护程序 |
| `kernel/internal/inference/step-program.ts` | 绑定/准入/auth/取消与模型调用 | 首请求/工具后预算门，摘要请求独立寿命，policy pin |
| `box-runtime/internal/host/compact.ts` | live slot、root owner guard、同连接新 snapshot | 不只接受 active STEP；pending 协调、目标预算、prepare/validate/accept/checkpoint 分层 |
| `box-runtime/internal/host/live-slices.ts` | provider 前注册；managed 活跃时抑制两处原生后台启动 | 不能只有抑制而无替代推进；补安全点维护并保留 official 对照 |
| `box-runtime/internal/roots/modeld.runtime.ts` | exact-1 环境开关接入现有恢复桥 | 新配置/资格取代普通功能开关；故障注入不随之开启 |
| `kernel/internal/selection/models.ts`、`host/session.ts` | 模型容量、selection pin、Host extendedUsage | 本地工作窗口不冒充模型能力；有效策略与模型选择独立按域计算 |
| `box-runtime/internal/backends/ai-sdk.ts` | 已有最终请求字节与工具声明门 | 增加预算复核，不能在 fetch 中直接改写历史或发 compact |

路径以 `packages/runtime-kernel/src` / `packages/box-runtime/src` 为根。源码/协议已有不代表新 CTX 能力存在。完整当前配置只看 [配置指南](../configuration.md)；这里的新增测试编号和模块差额属于待实现 S12。

## 参考与测试的边界

后续 CTX-01 建立少量可审的合成向量：128000/16384 阈值相等与 +1、500K→128K、错误后有效 usage+增量、完全无 usage、安全切点与旧 compact 边界。向量独立给出 expected，引用参考版本，但 CI 不执行全局 Pi、不下载源码、不依赖它的会话/配置。复制或改编 MIT 代码时保留必需许可/归属；优先实现最小纯合同，不引入完整 Pi SDK/agent loop。

Pi 参考版本、meter、Host 编码/root 接缝、provider 输出语义、配置默认值或选择 pin 变化，都会使相关对照与 CTX 证明需要重验。源码比较、纯函数测试、完整 grokbox 离线链、原生资格及 live 结果是不同证据等级。
