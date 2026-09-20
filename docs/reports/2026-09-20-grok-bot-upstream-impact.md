# 2026-09-20 Grok Bot 上游版本变化对 grokbox 的影响

## 范围、证据与结论

本报告是本次只读分析的固定记录，不是新的产品合同、当前部署状态或实施授权。目标是 `~/.devspace/worktrees/feat__box-runtime-v2-17d4f799` 当时的实际文件，包括未提交的 CLI / management Server / Web / materials / protection 改动；不是仅对 Git HEAD 做结论。

**有实质影响，但不是整个 CLI 已失效。最紧急的是新 Host 与现有注入配方不兼容；其次是旧 Memory RPC 已移除而生命周期材料回退仍依赖它。新材料查询、历史 tail 与许多基础 Gateway 方法不应被一起判为失效。**

检查仅涉及源码、Git 信息、文件哈希、纯内存切片预检及隔离测试。本次没有访问实际 Gateway HTTP、读取用户消息或密钥、发送消息、调用模型、启动管理服务、采用 Host、修改 harness 或切换全局 CLI。**磁盘 Host 文件不是正在运行进程实际加载该版本的证明。**

### 固定基线

| 对象 | 本次观察 | 不能推出的结论 |
| --- | --- | --- |
| grokbox 工作树 | HEAD `a3e9131`，大量 staged / unstaged / untracked 改动；本次使用实际文件 | HEAD 单独可复现本次所有结果 |
| `~/code/grok-bot` | `6a2d4d2`，2026-09-20 捕获 App 0.57.1 的提交 | 已确认官方最新发布、或穷尽所有中间版本 |
| App 留存产物 | 0.47.0 → 0.57.1；新包 build `2026-09-18T22:09:42.898Z` | 生产 App 当前内存状态、账号实验开关 |
| 研究库 Host | `16c4163`；SHA `2ede71e2db066b32dfe75b5073c0cac8052faf76d23ed34b8fea4567ea0e9baa` | 当下 Box 正在使用这份 Host |
| Box 磁盘 Host | `/home/box/sand-host/version` 为 `0382fa8`；SHA `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548` | 进程已加载、注入已成功、真实模型链路可用 |
| Box 磁盘原生 worker | `agent-isolation/agent-store-worker.cjs` SHA `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e` | 新 Host 与该 worker 的配对资格已通过 |

App 证据来自研究库 `docs/28-desktop-0.57-delta.md`、`references/grok-bot-app/CHANGELOG.md`、`catalogs/app-0.47-to-0.57.json` 和对应留存产物。该库是私人研究，不是官方 changelog。其 App 已更新，不代表同库 Host dump 也更新。以下原生 Host 行号只对应上述 `2380c2…` 文件，工作树路径只对应本次读取窗口。

## 1. 已执行的兼容性检查

### 1.1 Gateway：先合并 common 与 host-only，再看 CLI 依赖

实际从声明提取方法名，不执行 Host bundle：

| 范围 | 结果 |
| --- | --- |
| 旧 Host common Gateway | 158 个 |
| 当前磁盘 Host common Gateway | 154 个 |
| 当前磁盘 Host host-only | 33 个 |
| grokbox `GATEWAY_METHODS` | 34 个，其中 31 个仍在上述两类原生声明中 |
| 不在原生声明中的 CLI 名称 | `grokboxContextControl`、`grokboxCurrentStateControl`、`getAgentMemories` |

前两个是我方注入扩展，stock Host 不声明并不算上游删除；是否存在于实际加载进程需要另验。第三个是明确的旧上游 RPC 移除。31 个名称仍存在，只是名称/声明级证据，不是参数、返回值、权限和端到端行为全兼容的证明。

common Gateway 相对旧 Host 删除：`getTranscript`、`getUserFormPrefill`、`listUserFormVaultEntries`、`updateUserFormVaultEntry`、`deleteUserFormVaultEntry`、`getAgentMemories`、`deleteAgentMemory`、`clearAgentMemories`、`portAgentLocalSkills`、`readVoiceCallAgentContext`。新增：`getCloudAgentConversation`、`getCloudAgentWatch`、`disconnectListenerPlatform`、`getAgentTodos`、`readMainAgentContext`、`carryBoxSecretsToBot`。

**不能把 common 边删除直接当成整个 Host 删除。** 当前 host-only 仍保留 `readVoiceCallAgentContext` 别名；CLI 用到的 `deleteAgent`、`assignAgentToSidebarSection` 也属于 host-only。`getAgentMemories` 则在当前 Host 全文及完整声明集合中均不存在。App 0.47 → 0.57.1 是 +9/−10，不同于 Host 的 +6/−10，原因之一是三个旧 Host 方法现在才接入 App。

定位：grokbox `packages/cli/src/registry.ts:1440`；当前 Host `414626–415040`、`415126–415249`；未知方法拒绝路径 `419913`。

### 1.2 注入切片：当前完整配方不能直接用于新 Host

调用项目自己的 `transformUnchecked`，读取磁盘 Host，在内存中按组逐片尝试；失败时记录有限错误并继续盘点。没有加载 Host、没有写入变换产物、没有生成可采用 profile。通过数量只是定位失败覆盖面，**不等于完整配方通过**。

| 配方组 | 切片数 | 单组累计诊断中匹配数 | 不匹配数 |
| --- | --- | --- | --- |
| `LIVE_SLICE_PATCHES` | 39 | 30 | 9 |
| `NATIVE_CHECKPOINT_HOST_SLICES` | 3 | 3 | 0 |
| `NATIVE_CURRENT_STATE_SLICES` | 19 | 17 | 2 |

失败切片：

| 切片 | 失败类型 | 受影响职责 |
| --- | --- | --- |
| `managed-retry-gate` | `anchor-missing` | managed 失败不能被原生 provider retry 重新接走 |
| `managed-output-retry-gate` | `find-missing` | output token 超限重试边界 |
| `managed-summary-retry-gate` | `find-missing` | summary / overflow 重试边界 |
| `tool-execution-failure-observation` | `find-missing` | 工具失败终态观测 |
| `alert-main-decision` | `anchor-missing` | 原生主回合告警决定的观测 |
| `alert-automation-decision` | `anchor-missing` | 后台 automation 告警抑制的观测 |
| `alert-automation-throttle` | `anchor-missing` | 原生告警节流的观测 |
| `context-manual-native-action` | `find-missing` | 手动 Compact 的原生 action 分派 |
| `context-manual-summary-owner` | `find-missing` | 手动 Compact 的 summarization owner |
| `continuity-native-startup-input` | `find-missing` | 无伪造用户输入的程序启动准入 |
| `continuity-native-startup-action` | `find-missing` | clone / spawn 等程序启动 action |

若干重试/告警匹配失败涉及 bundle 局部符号从 `error41` 等变更；不能把所有失败都称为上游语义变化。但手动 Compact 和启动处同时存在真实控制流演变，不能全靠改字符串收口。

源码定位：`packages/box-runtime/src/internal/host/live-slices.ts:75–111,197–207`、`alert-slices.ts`、`context-slices.ts:30–49`、`native-bot-lifecycle-slices.ts:7–27`。拒绝逻辑在 `profile.ts:75–110`：精确源 SHA、唯一锚点、唯一替换及输出 SHA 均需成立。

**建议判断：P0 原生资格阻断。保持拒绝是正确行为，不应绕过 SHA、跳过 required slices，或把诊断的部分成功变成部署许可。** 基础 Gateway 查询不依赖这些切片；自定义模型执行、上下文维护、告警观测、原生连续性不能因基础查询正常而判为可用。

### 1.3 原生 worker 未变，不代表配对资格继承

`native-checkpoint-worker-hook.ts:7–10` 固定的 Host 为 `e7031f773bf035d02952d8b76dc2d2be6cea7167305116cf3e9b05d2c067b06e`；worker 为上表的 `56f87f…`。本次 worker 哈希仍相同，**变化的是 Host**。

`profile-capabilities.ts:26–33` 要求 applicable same-source reviewed baseline，且 current-state Host 必须属于独立验证的 Host/worker 对。当前 `2380c2…` 不满足此条件。checkpoint 三个文本切片匹配，不足以证明原生引用图、主状态发布、checkpoint writer、恢复顺序和新进程继续执行都兼容。

受影响资格覆盖 capture / initialize / reset / recover，以及建立在它们上的 clone / replace / spawn / protection。没有证据显示当前用户数据已损坏；这是不能沿用旧资格的结论。

## 2. 新 Host 的 idle compaction：需要核对职责，而非仅修锚点

当前 Host 包含原生 `startIdleCompaction`、summary lifecycle watcher，以及无文本输入的 idle summary action。旧 `16c4163` 留存文件未匹配到该路径。

原生路径以空文本调用 runner，但携带 `requestSource: idle-compaction` 和专门 options；区分 summary started、completed、persisted、abandoned，且把 `stashed` 与 `persisted_in_activity` 分开。`createTurnRunShell` 已不再只区分普通输入与 resume，而是用 `actionOnly` / `promptlessAction` 处理 idle summarization。`SummarizeActionHandler` 也增加 threshold-shaped 路径。

定位：当前 Host `661993–662091`、`681423–681432`、`681686–681701`、`681894`、`682110`、`524900–525000`。本次确认代码存在，**未证明当前进程/账号已启用或实际触发**。

对 grokbox 的设计复核应覆盖：普通 TURN、resume、手动 Compact、原生 idle compaction、managed STEP overflow 恢复、程序 startup。重点是这些路径是否共享原生 writer/锁和 summary 生命周期，如何取消，何时可认定 checkpoint 已落地，以及模型路由和耗时/告警如何归属。不要把 summary 已开始或已生成当成用户任务完成；不要让两套压缩重复启动、把维护行为伪装成用户 prompt，或在启动恢复时消耗错误的维护 action。

原生能力可能让部分旧绕路不再必要，但替换/删减必须由实际行为验证决定，不能因为名字叫 compaction 就认定等价。

## 3. Memory：已删除的是旧 RPC，不是 Memory 体系

### 3.1 遗留接口与仍在使用的回退依赖

`packages/cli/src/gateway.ts:590–599` 仍调用 `getAgentMemories`；daemon 的协议与实现仍声明和转发它。旧 `commands/memory.ts` 文件仍存在，但本次工作树的 `memory list` 已接入 management materials，不应仅因该文件存在就认定当前用户命令走旧路径。

真正需要收口的现役依赖在 `packages/box-runtime/src/internal/io/continuity-material.node.ts:19–43`：`nativeMaterialReader.fallback` 先读旧 Memory RPC，再读历史 tail；Memory 失败被归为不完整并继续尝试历史。若历史可用，可产生 **history-only、memoryComplete=false** 的材料；若两类均无有效内容，则 `material_invalid`。调用者包括 `continuity-native-lifecycle.runtime.ts:15,53`，与生命周期/保护复用相关。

当前实现不是把 Memory 失败冒充完整成功，但“尽力恢复”的内容在新 Host 上会系统性缺一层。应区分 endpoint 不支持、权限拒绝、来源变化、临时失败与真实空 Memory，并把缺失原因和覆盖范围一直带到 plan / preview / operation receipt，不能宣称完整记忆迁移。

### 3.2 新材料服务不依赖这个 RPC

当前 `memory list/search/read` 经 `management-registry.ts:32–45`、`commands/management-api.ts:93`、`packages/server/src/materials.ts` 进入已配置来源的材料服务。`material-source.node.ts:55–60,132–136` 读取授权范围内 Agent / User / Project Markdown shards；`agent-export.ts:534–550` 也使用分片路径。

因此，旧 RPC 移除**不直接删除新材料服务的读取能力**。但该服务不是全账号 Server Memory，磁盘分片可见不等于完整 Server 来源、最新同步或实际 TURN 已采用。`materials.ts:52` 的 `includedInTurn: not-observed` 应保留。

当前 Host 的 `FileMemoryStore` 仍有 `listMemories`、`countMemories`、`addMemory`（`618933–618944`）。Server 也有 Memory shard proto。不能把它们任一者未经资格核验当成旧 RPC 的透明替代，更不能直接写用户原生分片来“修复”接口。

**建议判断：P1，收口残留的旧 Gateway/daemon Memory 能力及生命周期降级；DATA-01 维持明确来源和覆盖范围，不回退到假装统一的全局 Memory。**

## 4. 历史与桌面路由：保留正确的已有边界，更新失效证据

CLI 的历史、outcome、handover 等主要使用 `getAgentTranscriptTail`，不是被删除的 `getTranscript`。当前 Host 和 App 都保留 tail。定位：`gateway.ts:502–516`；Host `414639`、`419070`。这次无需因为旧方法名消失而整体重写历史查询。

但是，tail 方法存在不代表 Box 与 Server 账本一致。0.57.1 coordinator 仍有 `restoreTemporalAgentRouting` 与按 harness 分类的分派；不能从版本升级推断旧分叉/发送目的地问题已修复。新 `mainAgent` 和 `server-roster-changed` 也不是执行所有权证明。

本次实际执行研究库 `node scripts/verify-desktop-transcript-routing.cjs`，在源码 pin 检查处退出 1：脚本仍固定 App 0.47 coordinator SHA `bb89df3f…`，当前留存 0.57.1 为 `d3560d43…`。这证明**旧回放资格失效**，不是证明当前 App 有 bug 或已修复。不能只替换 SHA；需重新提取当前函数、确认依赖/路由语义和回放覆盖。

本次 grokbox `test/transcript-route.test.ts` 的隔离回归通过；这证明受控样本中的来源 guard，不能替代真实 App 的重连、重新打开、follow-up、send acceptance/echo 与同一 Box 身份模型切换验收。沿用 Server 执行所有权、原生 writer 与展示投影分离的边界，不修改 App，不以清缓存或本地改 harness 来制造通过。

## 5. 群聊：新能力扩大边界，也暴露旧默认语义

0.57.1 App `createGroup` 增加 `humanMemberUserIds` 等字段，并通过 coordinator 对有人类成员的群要求 Server-hosted temporal；明确 box 路由被拒绝。`addGrokBotRoomPeople` 是独立的新增人类成员能力。定位：研究库格式化 coordinator `29041` 附近。

grokbox `commands/groups.ts:101–104` 仍提交 name / description / memberAgentIds，不提供人类成员或明确 creationRoute。因此其现有命令是 Bot 成员能力，并非新的完整团队群管理。

当前 Host 的 `wrapGatewayApiWithServerAgentProxy`（`418597–418675`）会在未指定 box 且 Server rooms 可用时走 server room；该路由逻辑在旧 `16c4163` 已存在，**不是这次才新增的回归**。本次所读 Host proxy.createRoom 路径只转发 name / description / memberAgentIds，不能因为入口 schema 声明 humanMemberUserIds 就认定 Host 链已完整支持加人。

建议明确命令承诺的 Box/Server 范围、创建意图与返回的实际归属；成员输出区分 Bot / human。不能把 Server room 当作可由本机 modeld 控制的 Box 会话，也不能把既有群通过本地字段写入“改成 Box”。新增人类群支持是产品范围决策，不是需要立刻追齐的兼容修复。

## 6. 新 App 功能逐项归类

下表以研究库 `docs/28-desktop-0.57-delta.md` 对应小节与留存 App 产物为来源。代码存在/功能门存在，不等于当前账号可用，也不等于 grokbox 应提供该功能。

| 变化 | 对 grokbox 的影响与建议 |
| --- | --- |
| Server `getMainAgent/setMainAgent`（§3.1） | 当前未见 CLI 消费者。若以后展示主 Bot，区分主指针、sidebar pin、CLI target、默认模型、执行 harness；不自动重绑已明确选择的接收者/运行身份。 |
| agent todos 与 `keepTaskList`（§3.2） | 两套清单，不等于 grokbox run/operation。清单 done 不能充当结果已交付证据。可作为 Web 的来源标注信息，不让它决定 operation 终态。 |
| presence / `setViewingAgent`（§3.3） | 是桌面正在观看/焦点的产品语义，不是运行时健康。不要让 CLI 轮询伪造用户在场，也不要把 TTL 失效当作 Bot 故障。 |
| voice memo、TTS、Server voice harness（§3.4） | 当前无直接 CLI 依赖；Server voice 不自动继承本地 modeld 选择。旧 voice context 名称在当前 Host host-only 仍留别名。 |
| Bot 邮箱（§3.5） | 桌面 main 仅接 list/create；proto 里的 send/read/search 不能冒充可直接使用的桌面或 CLI 能力。可选新领域，不阻塞当前 CLI。 |
| Box→Bot、User→Bot、Bot secrets CRUD（§3.6） | 三种不同权限/方向，不能与 model provider credential 混为一个 secret store。默认不迁移、不导出、不从 clone/protection 自动搬运。 |
| Bot skills / plugins（§3.7） | Server 的 content/files/variables 体系与 Box workflow、全局 Skill 分发不是同一生命周期。`portAgentLocalSkills` 被移除，但当前 CLI 未找到直接依赖；不能据此删除仍在使用的 workflow/automation 能力。 |
| 群聊与人类成员（§3.8） | 见上一节。明确产品范围和实际 owner，比复制新参数更重要。 |
| GitLab / Bitbucket / Azure DevOps SCM（§3.9） | 桌面账号连接能力扩展，未发现当前 CLI 依赖这组 App 回调。无需为了保持 Box CLI 可用而复制桌面 OAuth。 |
| Team policy 与 action-level local tool grants（§3.10） | 旧 desktop permission getter 变化未直接命中 CLI；但运行时不得把审批/团队策略拒绝当成可盲目重试的工具故障。不能绕过 admin enforced policy。 |
| Messages 收件人许可（§3.11） | 原生产品安全边界，不属于改模型后可以忽略的部分。当前未发现 CLI 直接调用该桌面能力。 |
| Cloud-agent conversation/watch/artifacts（§3.12） | 是可扩展的观察面，不是 grokbox 的本地 operation/模型调用身份。将来接入需标注 bcId/来源/完成证据，不以某次 update 当成本地执行成功。 |
| 实验曝光、composer、deep links、Settings、chunk（§3.13、§4–6） | 主要影响桌面 UI/研究索引；无已确认的核心 CLI 强耦合。不要把本次兼容修复扩大成全量 App UI 复刻。 |
| proto 定义迁到 coordinator（§2） | 影响旧研究/提取路径，而不是当前 CLI 运行依赖。当前包内源码未见依赖 App 的 electron-main/proto.cjs 或格式化 App 文件。提取脚本需按产物归属更新，不把私人 dump 变成公开构建依赖。 |

### 事件侧的具体缺口

Host 当前发出 `todos` channel（`host-main.cjs:692196`）；grokbox `ALLOWED_EVENT_CHANNELS`（`packages/cli/src/registry.ts:12–21`）仍只有 agents / agent-upserted / transcript / memory / subagents / async-tasks / tray，`commands/events.ts:18–29` 会拒绝未允许 channel。因此当前旧 events 入口不能直接订阅 todos。这是已知覆盖缺口，不等于原有 SSE 全部坏掉。

App 的 `agents-todos`、`agents-bot-skills`、`agents-bot-secrets`、`server-roster-changed` 是 App/coordinator 事件名，不应机械地加入原生 Host SSE channel 清单。新的管理 Server 事件、旧 daemon 事件、原生 Gateway 事件也应分别定义转换边界与凭据/正文脱敏。

## 7. 建议的处理顺序（本次分析建议，未实施、未排期）

| 优先级 | 建议范围 | 必须证明什么 | 现有责任入口 |
| --- | --- | --- | --- |
| P0 | 为新 Host 建立同源 reviewed profile，逐项审查失败切片及 idle action | 完整配方可用；managed retry、取消、compact、startup 与原生语义相容；不靠删切片过关 | Host profile / context / continuity 代码；LIVE |
| P0 | 新 Host 与既有 worker 的配对资格 | 原生 checkpoint 图、初始化/恢复、竞态栅栏、独立进程接续与实际身份均正确；worker 相同不能免验 | `profile-capabilities.ts`、native checkpoint/current-state；LIVE |
| P1 | 旧 Memory RPC/daemon 残留与生命周期材料降级 | 能力不支持被明确呈现；history-only 不冒充完整 Memory；来源资格与覆盖缺口贯穿计划和回执 | DATA-01、CLI-05、continuity-material |
| P1 | 重新资格化 0.57.1 桌面路由证据 | 当前函数回放；另有授权窗口后验证 App/CLI 同一身份下发送、echo、历史、follow-up、重连与模型回程 | transcript-route；旧研究回放脚本；LIVE |
| P1/P2 | groups / 主 Bot / 事件来源的边界 | 创建意图和 observed owner 分离；Bot/human 分离；todos 不作执行完成；事件名不跨层照搬 | CLI-05、WEB-03、groups/events |
| P2 | 可选产品能力 | 用户确有使用目标后再决定 main Bot / todos / secrets / skills / cloud watch / email / voice 的范围 | 既有产品路线，不新增平行总 Spec |

不建议为了本次升级改 App、改签名、重置缓存、篡改既有 harness，或追齐所有桌面功能。也不应把“基本查询仍通”当成模型/上下文/连续性已可上线。

## 8. 本次验证结果与未证范围

执行：

```bash
bun test \
  packages/box-runtime/test/compile-receipt.test.ts \
  packages/box-runtime/test/hcr-profile-upgrade.test.ts \
  packages/box-runtime/test/native-checkpoint-worker.test.ts \
  packages/box-runtime/test/native-current-state-owner.test.ts \
  packages/client/test/material-contract.test.ts \
  test/transcript-route.test.ts
```

结果：**53 pass / 0 fail / 338 expect calls，6 文件，3.48 秒**。这些测试使用项目的受控来源、临时存储/原生 owner fixture 和模拟边界；其通过不证明当前完整官方 Host 和 App 已适配。新 Host 切片诊断仍有上文 11 个不匹配项；研究库旧桌面回放因 source pin 失配退出 1。

补充执行 `bun run check:docs`：13 pass / 2 fail。文档链接与锚点检查通过；失败分别是 `test/live-e2e-checklist.test.ts:46` 的 CLI leaf / 主场景清单不一致，以及 `test/docs-governance.test.ts:101` 的 lifecycle 示例仍引用旧 `agents protection status`。差异集中于 protection / handover / snapshot 新旧命令面，不是本次 Host 切片预检或新报告链接失败。本次仅记录，未修改这些并行施工中的入口或验收清单。检查结束再次计算 Host 和 worker SHA，与本报告基线一致。

未进行：全仓测试、typecheck、完整 build、当前加载进程身份核验、实际 Gateway 能力探测、真实 Bot/模型/worker 采用、App E2E、任何部署/迁移。本文没有把过去 LIVE 报告中的状态移作当下事实。

本次输出只增加该固定分析报告及 reports 导航，不修改业务实现。实际实现与当前验收状态仍分别以现有源码、Tickets 和 [LIVE](../tickets/LIVE-integration-validation.md) 为入口；该工作树后续并行修改或 Host/App 再次更新后，需要重新验证受影响结论。
