# T35 — Managed STEP scope / HostCompact wait-point

## Current integration — 2026-09-17

本票保留provider前有效slot、root/callback fence、pending协调和native外层retry的既有实现/未证范围。[Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)接受默认本地维护和旧失败会话下一消息恢复；[CTX-02](CTX-02-host-context-maintenance.md)承接新的root/operation能力、空闲手动安全点、候选先验证后accept/checkpoint、已有pending有界收口，CTX-03/04接摘要与用户旅程。不能仅保留抑制后台摘要的patch而无替代推进机制。

新系列是planned，不表示原生接点已资格化；T35旧证明可复用但不能替新safe point/持久化/独立review签字。基础proactive已是当前产品义务，不再按本票早期非目标后移；后台预生成优化与更多ABI仍不作前置。实施范围与新增proof只写CTX票，不在本票再开第二施工队列。

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**In progress · Phase 4 · implementation authorized 2026-09-12.** Owner 已要求按 R2 继续，先治理 Spec/Ticket、回收必要旁支，再实施；不再等 A/B/C。权威是 [Spec S0](../roadmap/box-runtime-impl-spec.md#stable-delivery)，本票拥有 Host 生命周期/接点差额，T32 仍拥有恢复决策与预算。离线实现授权不是任意 live 启用。

**2026-09-13 现场：** test0 managed admit 失败后 Host 以新 turnId 约 5s 间隔再 hook 四次。这是 native 外层 TURN 重试。当时 stream 抛的不是 managed-failure 集合中的 InvalidHostStateError。T39 将已 invalid 的 stream 改为 InvalidHostStateError，本票不另造 retry owner。完整 overflow 合同仍未关。

## User blocker
长会话换小窗口模型，首个请求就可能overflow。历史基线`pre-publication-revision`有注册过晚/已有background阻塞；当前工作树已前移注册并增加寿命/重试控制，不能重做历史缺陷。剩余是实际pending-background的可推进协调、原生接受/fence与真实恢复闭环；仅增加日志或调大等待不能关闭。

## Reuse / delta
复用现有 Host hook、slot、root snapshot codec、v4 同连接与 kernel STEP ledger，不新建 orchestrator/状态库。

1. 在有效 STEP id、ctx、root 均建立后、provider 真正启动前注册能力与清理；不得捕获未初始化变量或占位 slot。
2. managed 分支协调 approaching-limit / responseSummaryLaunch / 已有摘要，同一实际 root 不并发接受。已有独立可完成 external 工作有界收口后重取窗；self/未知依赖不盲等、不抹 Promise。official 分支保持原行为。
3. Host 外层不对已结算 managed 失败额外发起推理 retry；内核至多两次 attempt 的预算不能被 native STEP 替换绕开。
4. 取消、期限/身份/generation 失效与退出使旧能力无效；root 接受之前有真正 writer fence。仅禁发 resume/Promise.race 不能证明迟到摘要没改活 root。已改/未知 effect 如实报告，隔离仅限受影响 root。
5. 小补丁不足时接管完整相关 runStep 段；不为目录/名词一致性另造通用 Harness。所有新增切片经 exact profile、唯一 anchor 与生命周期资格。

## Module / dependency
`packages/box-runtime/src/internal/host/{live-slices,profile,compact,session,modeld-client.node}.ts` 及必要同目录 helper；`preload.ts`；owned Host-shaped tests。依赖 [T32 seam](T32-host-compact-seam.md) 的当前 release-profile 资格、连续性 F1/F2 和既有 kernel identity。涉及 wire/父预算的改动由 T32 接收，不平行定义。

## Acceptance
- **V03**：owned fixture 按实际 Host 顺序执行而不是先人工注册，首请求立即 overflow 可取得 slot；旧 late-register 为红。每个 capture 已有效，正常/异常退出均 dispose。
- **V04**：background/external/self 交错、两个 root 并发、official 负对照；同 root 不竞争写，常见合法路径能推进。
- **V08/V09**：取消在摘要前/中/接受前后、root 更换、generation 失效、断连迟到；旧结果无越权接受或重复 resume，未知副作用不能伪回滚。
- **V11**：managed terminal 后 native 不追加 inference；official 原错误行为不被改坏。
- 与 T32 合成 **V05/V07**：同绑定恢复、父预算、唯一终态；source 和实际 packed 都测。
- exact-SHA 独立 review 和 release profile 原生资格；未满足不可 live。获准 live 检查点见 readiness，不以 overflow_candidate / 消息数下降关闭。

## Current ownership integration / next

本票继续拥有原生root/摘要/外层retry，新增[T37](T37-server-ownership-admission.md)拥有归属证据及失效原因。二者在真实准入/生命周期上连接：provider前已有有效root与归属；同TURN普通模型配置变动不夺取root或触发新attempt，正式owner/Host代失效才fence迟到接受。不能因为T37读取成功就认为所有异步mutator都受保护。

T38移除错误本地harness保护后，原生identity变化必须传播至既有slot，不靠永久本地box维持能力。test2仅作冲突零效果校准；真实长会话验证使用确认box的批准对象。T39消费本票恢复前后续聊/活动/工具证据，T40消费正常启用与退出边界，不重写本票程序。

下一源码差额：pending独立external与self依赖区分、已开始摘要的收口/迟到接受、真实outer retry与取消。使用现有失败反例及source/packed/native层级补齐；新归属门改变关键路径后旧review需重新对应。当前证据仅为历史已实现子集，本轮没有新live或复跑。

## Historical evidence / versioned receipts

### 最新生产补齐：最终 TURN 决策门

已定位旧 gate 只拦 `isRetryableProviderError`，而实际 `shouldRetryTurnAttempt` 还可调用 automation policy；这正是新 TURN 放大重试的漏口。新增可选 exact slice `managed-turn-retry-gate`，在最终策略入口识别进程内 managed failure provenance，先于任何 automation callback 拒绝。ordinary/official 错误与取消/缺 hook 行为不改。

`host-managed-turn-retry.test.ts`：owned 反例先得到 4 次 TURN，修复后只 1 次；并从 source SHA `307de399…` AST 提取实际 `shouldRetryTurnAttempt`＋`runWithTransientRetry`，验证 managed/保留 cause 的包装失败各 1 次，official 4 次。无真实 Host 启动/网络。新用例已进入原 compact verifier，本轮 Compact **79 pass**。这是 V11 的精确策略/循环子证明，不能提升为真实 App/automation 完整失败链已通过。

既有 pending background 的完整协调、原生全部 callback、真实 overflow→同模型恢复仍未 closed。本轮新 live send 与后续历史读取被工具安全检查拦截，没有新全链结果；独立 Astra review 容量不足。最新制品/源码稳定性、运行代变化与 E09 红项统一见 [readiness 当前生产补齐](../maintainers/t32-live-enable-readiness.md)，不使用下方历史版本/计数签当前发布。

### 当前增量（grok-4.6 真实验证轮）

当前 Host `307de399…` 已通过直接源码核验、全部精确切片/语法测试及真实 AST 摘要＋同步 state mutator 的成功/取消/root 换代三案，见 [T32 seam 当前资格](T32-host-compact-seam.md)。新版 mainSessionOptions 的 modelId/executorProfile 选择已适配，身份插入不覆盖原生选模。SDK e2e 已补原 tools/options 恢复保真。当前9文件回归62 pass。

已使用新制品真实 profile-write/re-adopt，并将 modeld 切到独立 Pi xai 凭据引用；准确代/哈希/范围/结果归 [readiness](../maintainers/t32-live-enable-readiness.md)。**历史下述“未部署/旧 pin 红/模型不可用”已不代表现在。** 普通 managed 现场曾在旧凭据 SDK 失败后产生新的 TURN 重试，证明目前 managed failure gate 尚未控制完整 native 外层链；V11 不可关闭。新凭据 SDK 已200，但切换后的 Bot 测试被工具检查拦截，未取得新的完整 e2e 结果；gate/injection 仍关。

下一责任：真实 canary 同代证据、外层重试入口、pending background 与正式运行配置。局部 native proxy 资格不证明所有异步回调/别名均已隔离；Astra 复审没有成功返回，不签正式关闭。

### 前一轮工作树证据（历史快照）

2026-09-12，基于 `pre-publication-revision` 的未提交工作树；不是该 commit 本身、已部署候选或独立 review 完成声明。

- 已核验的工作树包含 provider 前 slot 注册、实际 managed stream 标记、两个 mid-STEP summary 入口协调、managed failure provenance/native retry gate，以及 Host/client/modeld 的剩余预算传递。常见 pending background 的完整收口仍未闭合，不能把局部协调当完整 V04。
- 本轮进一步补齐 `compact.ts`：调用摘要前检查旧 STEP；用同一 root 当前 owner fence 旧 delegate；compact 无论成功、无改善还是错误，返回时立即撤销保存的 root/state 方法引用。外部 provider/archive 已有副作用不伪装回滚。`host-compact-lifetime.test.ts` 新增 5 个反例，连同现有寿命/协调/retry/control/budget 测试共 **32 pass**。
- 新 `host-compact-pipeline.test.ts` 使用 owned Host 顺序 fixture → 真 `bindHostSessionHook`/client → local-real Unix → production kernel/真实 AI SDK + 显式 mock HTTP；400 structured overflow 触发一次 Host-owned 合成摘要、实际 resume-step、同模型 attempt1 与唯一逻辑 terminal；401 带相同 overflow 字段也只一次 provider effect、无 compact/resume。断言原窗/新窗、metadata、单 run-step 和资源归零。两用例已过，合计 **34 pass / 0 fail**；没有 test client 手工生成 resume。它不是原生 summary、真实外网 provider 或 App delivery 证明。
- 新用例已接入 `bun scripts/verify-runtime-rebuild.mjs compact`。本轮该入口 **39+34 pass / 1 fail**，失败是原生 source pin：期望 `2ede71e2…`、实际 `307de399…`。未修改/跳过该断言；测试跳过也不允许 compact 门变绿。同步输出 worktreeDirty 与真实依赖/未证项。
- pinned Bun 1.3.14 两次 pack 相同，preload `b1b31db8e4557d17e35052bf327c3d8a62fcdd7b07a29dfde614e3ce42d13211`；source continuity **61 pass**、packed **35+11 pass**，E09 pass。这里的 packed continuity 不是新 Compact 的完整 packed/native e2e。
- owner 已明确允许必要 Host 切换/re-adopt 和 CLI send e2e，无需再请求同一授权。指定替代模型 `ccs-sub2api-xai/grok-4.5` 的 Pi 认证检查为 ready，但实际无工具探针返回 **404 model_not_found / 当前 group 无支持账号**；luna 不再用于新测试。实际渠道状态/费用边界归 readiness；不擅换 provider。
- 标准 profile-observe 已进一步找到真实 recipe 失败：磁盘 Host `307de399…` 的 create-session 唯一，但 agent-id `findInWindowCount=0`，applyCode=find-missing；不是只要改 SHA 即可。profile-propose 生成 2 个未批准/未发布文本候选，仍需接缝资格；本机收据路径/digest 归 readiness。未绕过直接源文件的外根读取限制，没有写原生 Host 文件或发送进程信号。
- **下一动作**：对 agent-id 新接点做实际语义核对，再资格化当前 Host 的真实启动、同步 mutator/异步回调、摘要接受与 native retry 合同；闭合 remaining background / 正常配置差额后按已有授权部署候选。当前未新做 re-adopt，也没有宣称生产可用。

## Forbidden / not here
不手清 circuit；不为调查 unload；不盲开 GATE；不并行自制摘要器或从 store.db 拼 prompt；不将专用 summarizer 送回等待中的 STEP；不让旧竞态变新测试正确答案。
T36当前会话Working语义、完整proactive泛化、更多provider、跨重启恢复未知STEP不属本票；T36不是可以忽略的视觉小项，T39旅程须与本票一起验证。确实影响本票日用路径的容量/usage 依赖仍不得跳过。
