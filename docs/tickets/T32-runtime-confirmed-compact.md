# T32 — Confirmed overflow / Host compact / one recovery attempt

## Current integration — 2026-09-17

本票保留已有confirmed-overflow分类、零放行、同STEP一次额外主请求和历史未证范围；**它不再拥有全部compact触发的产品定义**。[Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)将默认本地窗口/旧会话下一消息/手动维护纳入当前目标，[CTX-03](CTX-03-bounded-summary-and-recovery.md)消费本票恢复规则并接到同一维护程序，CTX-01/02/04分别完成策略、Host owner和完整用户入口。新工作均planned，不是已开启运行能力。

旧exact-1环境gate是当前实现事实，不是长期正常配置合同；CTX-04交付时由schema3策略与能力资格替代，故障注入仍off。当前桥默认关闭不等于Host全部原生compact关闭；不应仅开旧gate或重启就宣称旧长会话可持续恢复。下方历史回执保持原版本含义，新施工的目标预算/有界摘要/持久readback由S12与CTX票拥有，不重复建立第二恢复器。

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Partial · failure-recovery substrate.** 恢复内核、classifier、同连接桥和历史默认关闭已存在；真实首请求恢复与稳定日用未由本票关闭。当前新增工作按上方S12/CTX映射推进，不重做已有安全证明、不从历史分支文档推导新live权限。

## Goal / ownership
用户在真实 Grok Bot 换用更小窗口模型后，合格 overflow 能经 Host 原 compact 取得有效新窗口，回到原 managed 模型并继续日用。kernel `step-program` / `overflow-recovery` / ledger 是 attempt、恢复预算、逻辑终态唯一 owner；[T35](T35-host-compact-wait-point.md) 拥有 Host scope/摘要调度/接受 fence/外层 retry 控制；Host 保留摘要策略与 root、工具、Memory、checkpoint 的实际 writer。

## Reuse / implementation delta
- 已有：structured overflow 分类、无放行内容/工具门、同 STEP 一次 compact + 至多 attempt1、tuple/nonce/binding/epoch 校验、v4 control frame、exact-1 GATE、source/packed Host client。
- **期限**：从父 STEP 剩余预算分配摘要、校验、attempt1 与结算预留，贯穿 Host/modeld；不用固定 5 秒定义整个恢复，不无限续租，不比较跨进程 monotonic 原点。
- **资源/取消**：attempt0 静止再摘要，保留逻辑 ledger 占用但释放摘要所需 producer/锁/容量；实际 root 的 late acceptance 由 T35 fence。已开始/已更新/未知副作用诚实区分，不把断连称回滚。
- **snapshot**：同 active root 的合格 carrier/system/tail/metadata/tool 关联；验证结构、改善与目标预算。字符串、digest 改变、消息数下降不足以合格。unknown 不能冒充 qualified。
- **唯一结算**：原 TURN/STEP/binding/selection/ServiceEpoch 至多恢复一次；恢复失败不换 native STEP/主模型，不由 Host 外层再试。
- **发布**：能力 opt-in 与故障注入分开，批准 Bot 的正常配置持续生效；全局临时 GATE 不是 Bot-scoped 稳定配置。复用现有配置/admission，在 [LIVE 原生连续性条目](LIVE-integration-validation.md#live-context-native-continuity)维护当前现场缺口与回执链接；固定制品/支持范围/安装停用/有限真实旅程写日期报告。

## Module / dependencies
kernel `internal/inference/{step-program,overflow-recovery,step-ledger,route-binding}.ts`、contract/ports；box-runtime `internal/modeld/{server.node,same-connection-compact}.ts`、wire、Host compact/client 和 modeld root。依赖 T24/T25/T26 的实际合同、[Host seam qualification](T32-host-compact-seam.md)、T35 与连续性日用必需子集；不依赖完整 T29/T30/T31。

## Acceptance
1. V05/V06/V09：合格零放行 overflow → 一次 compact → 一个匹配新 snapshot → 原绑定 attempt1 → 唯一 terminal。401/429/413/普通 400/500/EOF/超时/取消/已有正文思考工具/无改善/二次失败均不新增恢复或主模型 fallback。
2. V07：可控时间验证慢于旧 5 秒但在父预算内可完成；过总预算不能 resume/attempt1，不靠 heartbeat 延期。
3. V08/V11：取消阶段与 native 接受 fence 联测；未知 effect 不重放，Host 外层不扩大次数，official 对照不退化。
4. V10/V13：合法新窗口、实际 SDK 编码、source/本次 packed 一致；旧 dist/错 profile/零 case 不通过。真实 provider 结构化拒绝资格与合成 canary 分开记录。
5. 稳定候选还需 V01/V02/V12–V19 对应范围：per-Bot 路由、多 TURN/工具/必要 aux/Memory/checkpoint/reload、真实产品入口、持久正常启用与安全退路。判据与方法由原连续性文档承载，现场进度只由 LIVE 承载，不另建 ME 票。
6. exact-SHA 独立 review；live 前按 S9.3 检查当前授权、身份/profile、制品、Bot/成本范围和停止条件。临时验证结束复原且注入关闭；稳定 rollout 另有明确范围。

## Current next action — Server-authoritative rollout

恢复内核已有实现继续复用；下一真实恢复候选须先满足[T37](T37-server-ownership-admission.md)准入和[T38](T38-identity-write-alignment.md)身份写入门。test2已证Server temporal/local box，不再是正向heavy canary。合成overflow、真实provider拒绝、原生compact资格仍分层，不能将只读ownership确认当恢复通过。

[T39](T39-native-model-roundtrip.md)在官方/A/B/官方旅程中消费本票的小窗口/恢复证明；普通模型切换只影响下一TURN，当前attempt0/compact/attempt1保持捕获模型，正式归属失效则按T37/T35真实fence停止后续效果。新增目标窗口更小不能静默截窗或新建会话。正常Bot-scoped启用与注入关闭交[T40](T40-persistent-release-and-rollback.md)持久发布验证。

本票下一责任是已有后台摘要协调与真实恢复缺证，不重新做已通过的内核；固定候选与统计保留在对应来源回执；当前现场已验/未验与下一步只看 LIVE。本轮没有新执行source/live测试。

## Historical evidence windows — not the current task queue

**当前现场进度只看 [LIVE-CONTEXT-NATIVE-CONTINUITY](LIVE-integration-validation.md#live-context-native-continuity)；以下是前轮固定版本的历史证明，不是当前候选或状态表。** 本轮补 final TURN retry gate（T35）、managed 缺 TURN 拒绝（T24）、plain reasoning 的 Responses 续聊投影、真实 HTTP 错误分类；compact **79 pass**、stream **27 pass**、结果/工具/Host 生命周期等定向组 **91 pass**。新增 source-before/after 验证门，移动的源码不能签绿。

当前仍不是 release：最新 contract-e2e **60 pass / 1 E09 fail**，另一个有明确旧 source digest 的 artifact 窗口曾 **35+11 pass**，两者不能混签；本轮真实 send/历史复核及凭据验证遇工具安全拦截，未绕过；独立 Astra review 无容量。凭据持久引用命令已落源码但未实测；`runtime start` 仍未实现，不能冒称自动恢复/安装已完成。原生 pending-background、完整真实恢复/必要 Memory/reload 与有限日用旅程的原验收保持未决。

2026-09-12 latest working-tree refresh，基于 `pre-publication-revision`，**未提交；本轮已真实 re-adopt Host 并替换 modeld，但尚非稳定放行**。该次制品/凭据引用/现场收据保留原日期回执；当前结果统一从 [LIVE](LIVE-integration-validation.md#live-context-native-continuity)进入，Host scope 行为证明归 [T35](T35-host-compact-wait-point.md)。

- 已有 budget 从固定 5 秒转为父剩余窗口内为 resume/attempt1 保留预算；慢于旧等待但未超父预算的用例通过。原生生命周期总预算及 native summary 实际资源收口仍须资格化，不把局部通过提升为完整日用。
- 新隔离 e2e 真走 Host session/client → Unix server → kernel → AI SDK mock HTTP；400 首请求溢出，经 Host-owned synthetic summary、实际同连接 resume-step，原模型 attempt1 成功；401+overflow 冲突只一次请求，无恢复。不是 fake client 回传预设 resume，也不是真实 provider/App 证明。
- 原 73+1 的 native source pin 红项已通过真实资格处理，不是直接换 pin：当前 307de399 Host 的 agent-id 模型选择形状变化已修复，两分支回归先红后绿；真实 AST 摘要/同步 mutator 成功、取消、root 换代三案通过。9 文件当前回归 **62 pass / 0 fail**，新 agent-id 用例也已进入统一 compact runner。独立 review 仍未取得有效结论。
- 本轮 SDK e2e 扩展发现恢复时原 tools/options 会丢失；kernel 现在保留原已受理能力/生成选项，只接受 Host 新窗口，并核对 profile/ABI 后重算 digest。真实 SDK attempt0/1 body 回归先红后绿。当前 preload `5d5b85c8…`，CLI `f6425761…`；完整版本/验证统计由当次来源回执保存，不能拿旧制品测试给新运行代背书。
- owner 已明确允许必要 Host 切换/re-adopt 与 CLI send；后续批准的 **ccs-sub2api-xai/grok-4.6** 的 Pi 和相同 SDK 适配器真实 smoke 均成功。现场旧 modeld 使用另一凭据，box canary 在 SDK 失败且 native 外层出现新 TURN 重试；不能把有回复的 official/temporal 探针算 managed 成功。
- 已实际发布 profile/re-adopt，Host route/attested；随后通过 canonical saveRuntimeModels 给 grok4.6 独立 XAI credential ref，保留其他模型旧引用，精确替换 modeld 且 health ready，gate/injection 均关闭。切换后新 Bot 请求被工具安全检查拦截、未受理，因此新凭据下 Bot→工具→SendToUser 与真实恢复仍未通过；安装重启凭据加载也未资格化。
- 下一动作：在当前固定 Host/modeld/profile/独立凭据引用上做新 nonce 的限定 canary；定位外层 retry 真实边界，完成日用工具/必要 aux/reload 与正常安装。E07 完整矩阵、E10/E11/native、生产窗口、已有 background 收口和正常 Bot-scoped 持久启用仍有差额。真实 overflow GATE 不因普通模型可用自动打开；Git 提交/旁支清理仍未执行。

## Related / deferred
[T35](T35-host-compact-wait-point.md) · [Spec S0/S6/S9](../roadmap/box-runtime-impl-spec.md) · [连续性](../maintainers/managed-context-continuity.md) · [LIVE](LIVE-integration-validation.md#live-context-native-continuity)。T36的Working语义是并列生产门，不仅是像素；它不替代本票恢复，T39最终旅程同时验证二者。禁止无预算大 prompt、4 MiB pad 伪造 overflow、手清 circuit、store.db prepend、平行 compressor 和未知 STEP 跨重启自动恢复。
