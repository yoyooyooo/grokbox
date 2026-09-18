# LIVE — 端到端验收与并行 worktree 唯一索引

本页是长期维护的 **Live 验证 Checklist 与当前结果唯一入口**，不是一次部署的日志，也不是全部未来功能的发布阻塞器。按用户旅程验收已经实现的能力；来源票负责实现/离线/review，日期报告保存固定窗口证据。[执行手册](../maintainers/live-end-to-end.md)只描述步骤与判据，不维护第二份状态表。

## 本次重整与候选边界

- **规划窗口：RC-E2E-20260919，尚未执行。** 本次仅重整清单、路由和可维护性检查，不迁移配置、不切 Host/modeld/daemon、不创建 Bot、不调用模型或 Webhook、不发布。
- **消化的源码基线：`feat/box-runtime-v2 @ 7deeeac`，整合时吸收至`aad29d5`的官方duplicate增量。** config 4 / models 2 / wire 8；Routine、配对、显式发送、持续提醒授权和 daemon sender 已集成。collector 持续服务装配、完整跨 owner 配额、长期安全退役等仍有源码缺口，不能写成“只剩 live”。真正开窗时重新冻结当时 v2 的精确 SHA、制品、原生版本、配置 revision 和能力清单。
- **最近已记录的现役观察**来自[自动通知集成回执](../reports/2026-09-19-automatic-notification.md)：旧 schema 3 日常入口与 resident 服务仍被保留。这是历史观察，不是本次重新检查的现役状态。源码已合入不表示进程已采用。
- **新授权范围**：用户在本轮明确允许新建测试 Bot、切换下述三种模型及 high/xhigh、验证 compact、Routine Webhook 和核心 E2E；延续已允许的协调 live 切换/重启。当前请求先升级规划，具体执行时在窗口回执登记对象、预算和清理范围即可，不重新索要同一授权。无限消费、业务 Bot 删除/关系迁移、平台 Reset、公开模板/Issue、Git push/tag/npm 发布不在这项授权内。
- **当前放行门尚未关闭**：此前最后92文件回归缺回执、独立审查缺结论，必须按实际最终候选补齐或由责任人明确处理，不能把工具503/超时算通过。它们只影响对应的执行/发布门，不永久阻止无关只读调查和清单维护。

<a id="release-lanes"></a>
## 发布范围与状态读法

| Gate | 本轮用途 | 放行方式 |
|---|---|---|
| **G0** | 固定候选、授权/费用、退路、清理与最终声明 | 每个改变现役的窗口必需；发布流程另受 release runbook 约束 |
| **G1** | 已交付核心：安装/配置、Bot/消息、三模型×两档、工具/compact/上下文、取证、基本 host 退路 | 本轮核心候选必须完成适用场景；不能用其他模型/旧窗口的通过替代 |
| **G2** | 默认协作提醒与长期运行：原生 Webhook、授权、sender、collector、GC/恢复 | 若正式版本声明“默认自动、无人值守、有界长期运行”，这些适用项也是必需；不能用手工 collector 的短链演示降低承诺 |
| **G3** | 原生当前状态初始化、扩展兼容平台/渠道与高影响场景 | 已实现且准备对外宣称的部分须验；未实现/无必要权限的部分明确限定，不借此无限阻塞G1 |
| **D** | 自动Issue、完整替身/关系交接/退役、平台Reset等当前未选产品范围 | 保留来源和后续入口，不计本轮完成率；标D不是把已有承诺自动降级 |

**实现状态**单列为 `integrated` / `partial` / `planned` / `reserved`；**本候选现场结果**只能用下表，二者不得混用。表格内列出的步骤是待验 oracle，不因已有离线实现自动打勾。共享一次运行的证据可以引用多条判据，但汇总不得重复计成多次运行或多次费用。

| Result | 含义 |
|---|---|
| `not-run` | 尚无本候选现场证据；具备实现也不自动变ready |
| `awaiting-integration` | 来源尚未合入固定v2候选，禁止直接切旁支到live |
| `ready` | 对应实现/回归/review、候选映射、依赖和窗口授权已齐，只待执行 |
| `running` | 有窗口ID、操作人和正在发生的调用；掉线不是成功 |
| `passed` | 指定模型/effort/对象/制品/原生版本的全部本条判据有证据 |
| `failed` | 实际违反判据，记录首个错误边界和来源修复票，不能被另一通道的绿覆盖 |
| `blocked` | 写清 CODE / REVIEW / ENV / AUTH / BUDGET / TOOL / DEP 等原因和下一动作；不写泛泛“待live” |
| `needs-revalidation` | 旧结果仍是历史事实，但相关运行字节/原生版本/配置/依赖变化后不能签新候选 |
| `excluded` | 本窗口明确不运行，列出原因、声明限制及恢复验收条件；不是通过 |
| `superseded` | 合同确实被替代，保留锚点和替代链接，不能复用旧ID含义 |

**不把未实现代码或 review 改称 live 待办。** 不把单一`blocked`扩散到全部场景；新问题回来源票，索引仅写它阻塞哪些具体验收。历史PID、重复测试计数、旧分支“尚未合入”、已实现的worker“仍未实现”等不再留作当前事实。

<a id="window-order"></a>
## 本轮执行顺序（引用清单，不是第二份结果）

W0 固定候选/私有退路与离线放行 → W1 成套采用及安装/基础CLI → W2 新Bot、三模型六组合与工具/compact → W3 原App、群聊、历史/导出和失败恢复 → W4 原生Routine/配对/单条提醒/自动新告警 → W5 持续采集、正常重启和有界存储 → W6 已实现当前状态/隔离高风险场景 → W7 清理与发布声明。

前一窗口可提供后续前置证据；不要求把所有窗口挤进一次会话。W4可先用明确的前台collector验证短链，但G2的长驻/self-start仍由独立行验收。任何新修复改变候选时暂停受影响lane、回worktree完成离线/审核/合入，再开新窗口；文档修订不无故重跑模型。

## W0 — 候选、授权与安装基础

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-release-candidate"></a>**LIVE-RELEASE-CANDIDATE**<br>G0 | `integrated`；`not-run`；基线7deeeac，未开始新窗口 | ①固定干净v2源码/锁/Node包/CLI/preload/profile/worker原生版本；②完整用例清单无遗漏，独立review有结论；③登记模型与对象预算、原状态快照和可执行旧制品；④区分代码合入、部署、发布 | REVIEW/DEP：关闭最终候选门，记录既往92文件缺口的实际处理；[release](../maintainers/release.md#live-window-procedure) · [窗口手册](../maintainers/live-end-to-end.md#window-record) |
| <a id="live-package-install"></a>**LIVE-PACKAGE-INSTALL**<br>G1 | `integrated`；`not-run` | ①从固定tarball在隔离前缀、无源码checkout依赖环境安装；②Node声明最低版本与当前Box版本分别验；③grokbox/gbox版本/帮助/退出码一致；④原生SQLite/LevelDB实际加载，Skill/recipe随包；⑤卸载/重复安装不丢用户状态 | DEP：先W0；不先运行shim:install影响日常入口；Linux实际Box与声明的外部平台分别记录；[release](../maintainers/release.md#candidate-gate) · [包入口](../../package.json) |
| <a id="live-cli-connections"></a>**LIVE-CLI-CONNECTIONS**<br>G1 | `integrated`；`not-run` | ①init重复执行保留编辑；②Profile增改选删、ID优先/名称歧义；③local与daemon同一对象结果一致，auto无错误fallback；④可用remote/认证loopback只用对应凭据；⑤doctor/能力缺失解释准确，读不隐式启服务 | ENV：外部transport需已有受控客户端，未具备的组合单列blocked；不借Gateway身份调用Sandbox/quota；[Profile合同](../product-contract.md#5-profile-合同) · [CLI registry](../../packages/cli/src/registry.ts) |
| <a id="live-config-edit"></a>**LIVE-CONFIG-EDIT**<br>G1 | `integrated`；`not-run` | ①嵌套get/set/unset与JSON Pointer、字符串/数组、schema/validate；②错误/未知字段/旧revision/未确认写零副作用；③preview不写、相同operation可对账、wait-applied不伪造；④portable export无secret/机器身份；⑤只恢复本次编辑，无关Bot/default/catalog不变 | DEP：匹配config4后执行；跨scope、alias修复及损坏配置只用测试文件；[配置指南](../configuration.md) · [T58](T58-config-command-single-writer.md) |
| <a id="live-config-cutover"></a>**LIVE-CONFIG-CUTOVER**<br>G0 | `integrated`；`needs-revalidation`；[H-CONT](#history-cont)有源码集成，[H-CTX](#window-context-v8-20260917)仅旧迁移 | ①读实际schema和writer；②精确3→4计划、旧制品/配置/alias退路；③停写/屏障后迁移，models字节/凭据引用/原off保持；④拒未知字段、操作恢复；⑤不因迁移创建配对/发消息/GC | `blocked` DEP/REVIEW：成套协调CLI/Host/modeld/daemon，不能仅替换config或只重启modeld；[配置迁移](../configuration.md#one-way-migration-and-recovery) · [T59](T59-config-migration-cutover.md) |
| <a id="live-config-consumers"></a>**LIVE-CONFIG-CONSUMERS**<br>G1 | `integrated/partial`；`needs-revalidation`；[W17](#window-20260917)仅旧消费者范围 | ①实际consumer启动/写入revision与请求匹配；②storage、ops、model域互不误失效；③配置committed/effective与applied区分；④坏配置仍可取证；⑤不热加载的域显示所需重启，不伪造全storage applied | `blocked` DEP：局部owner先验，全域applied未实现归CODE，不阻隔离读取；[T51](T51-ops-capability-presets.md) · [T60](T60-config-ops-integration-proof.md) |
| <a id="live-modeld-cutover"></a>**LIVE-MODELD-CUTOVER**<br>G0 | `integrated`；`needs-revalidation`；[W17](#window-20260917)/[H-CTX](#window-context-v8-20260917)有旧加载证据 | ①目标source/profile/transformed/preload和实际进程/worker可关联；②config4/models2/wire8共同采用；③CLI↔modeld与Host↔modeld各自匹配；④旧peer拒新执行，缺能力只读诊断准确；⑤已在途/unknown不被清除 | `blocked` DEP/REVIEW：由唯一controller协调，匹配后才开始新canary；[T40](T40-persistent-release-and-rollback.md) · [HCR](HCR-02-loaded-capabilities.md) |
| <a id="live-reasoning-cutover"></a>**LIVE-REASONING-CUTOVER**<br>G1 | `integrated`；`needs-revalidation`；[W17](#window-20260917)仅旧schema组合 | ①已有models2不重复迁移；②旧文件单独preview/迁移；③effort/default/每Bot assignment无损；④退回旧制品须有匹配旧schema，不靠删effort字段；⑤凭据不出argv/日志 | DEP：与CUTOVER共用一次备份/恢复窗口，分别记录判据；[reasoning](FEAT-model-reasoning-policy.md) · [模型配置](../configuration.md#model-reasoning-schema-and-general-config-migration) |
| <a id="live-host-capability-recovery"></a>**LIVE-HOST-CAPABILITY-RECOVERY**<br>G1 | `integrated`；`not-run`；[HCR离线](../reports/2026-09-18-host-capability-recovery-offline.md#hcr-v2-integration)不算本次加载 | ①旧/缺wrapper或reader给出准确doctor指引；②同源profile升级保持其他能力；③受控中断经operation-recovery恢复操作元数据；④实际loaded能力和新STEP闭环；⑤busy拒绝不自动force | DEP：正常采用优先；故障注入仅隔离资源，不能中断业务Host造例；[HCR来源](README.md#host-capability-recovery) · [能力合同](../roadmap/host-seam-ops-recognition.md#capability-recovery) |

## W2 — Bot、模型、effort、工具与compact主旅程

本轮专用长会话Bot依次执行：**官方 → SOL high → SOL xhigh → Grok high → Grok xhigh → DeepSeek high → DeepSeek xhigh → 官方 → SOL high**。保留同一默认会话/受管状态；每个模型格独立验，不用为每次换档新建空Bot回避上下文兼容问题。另设一个不参与变更的控制Bot；测试身份从实际回执取得，不复用历史Bot。

**六格共同最低判据 M**：记录exact provider/model/API路径类别和凭据引用摘要（无地址秘密）；执行一次相关新消息、一次可独立读回的安全工具副作用、一次真实`agents compact`及其后新消息/状态读取；核对配置→TURN captured→SDK/adapter→最终请求的effort，标记转义/映射，区分Provider reported。保持中文/英文/Unicode、唯一事实标记、工具历史与原用户标题。compact必须有原生operation/root/checkpoint及后续读回；no-op不算该格compact通过。计数与步骤可复用同一回合，不重复造请求。[具体步骤/样例](../maintainers/live-end-to-end.md#model-matrix)。

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-agent-lifecycle"></a>**LIVE-AGENT-LIFECYCLE**<br>G1 | `integrated`；`not-run` | ①create含明确Box请求/defer-start/nonce；②原生Server确认及list/show同ID；③更新name/description/title/notify/hidden不改ownership；④歧义/重复nonce不误创建；⑤清理阶段删除精确测试Bot并读回 | DEP：先CUTOVER；defer-start不是输入隔离锁；创建unknown先对账不换nonce重试；[Agent合同](../product-contract.md#71-agents) · [T38](T38-identity-write-alignment.md) |
| <a id="live-agent-isolation"></a>**LIVE-AGENT-ISOLATION**<br>G1 | `integrated`；`not-run` | ①只对主测试Bot换模/改档/compact；②控制Bot、main/default、其他assignment/title/Memory保持；③default变更不把任何Bot隐式opt-in；④并发另Bot请求不混STEP/上下文/计费 | DEP：固定两个精确测试身份，default写测试单独保存/恢复；[T24](T24-runtime-route-binding.md) · [模型Skill](../../skills/grokbox/models.md) |
| <a id="live-send-outcome"></a>**LIVE-SEND-OUTCOME**<br>G1 | `integrated`；`needs-revalidation`；[W17](#window-20260917)有部分消息证据 | ①send新nonce→排队→原生run/TURN/STEP→终态→投递→历史/App；②同nonce/断连unknown不自动重发；③正文含Unicode/换行/JSON数据但不伪造控制帧；④CLI超时与任务失败分开 | `blocked` DEP：先新Bot；控制台accepted不当用户收到；[结果手册](../maintainers/run-outcome-observation.md) · [Send合同](../product-contract.md#73-send) |
| <a id="live-model-selection"></a>**LIVE-MODEL-SELECTION**<br>G1 | `integrated`；`not-run` | ①models list/check/show与实际选择对齐；②同provider/model只改effort，不创建替代通道；③省略/default清覆盖，reset回官方；④unsupported档位在请求前明确拒绝，未知模型/凭据错误可诊断；⑤记录实际wire映射而非猜测 | DEP：只使用下列已授权模型；未声明的effort映射失败回代码修复，不静默降档；[reasoning票](FEAT-model-reasoning-policy.md) · [模型Skill](../../skills/grokbox/models.md) |
| <a id="live-model-sol-high"></a>**LIVE-MODEL-SOL-HIGH**<br>G1 | `integrated`；`not-run`；本轮授权，未测可用性 | **sub2api-codex/gpt-5.6-sol / high**：执行M；分别填chat、tool、effort emitted、compact checkpoint、post-compact回读；Provider reported未知单列 | DEP：W0+新Bot；[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-model-sol-xhigh"></a>**LIVE-MODEL-SOL-XHIGH**<br>G1 | `integrated`；`not-run` | **sub2api-codex/gpt-5.6-sol / xhigh**：执行M；与high是同通道且同会话；旧TURN不被在途改档重写 | DEP：SOL-high；[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-model-grok-high"></a>**LIVE-MODEL-GROK-HIGH**<br>G1 | `integrated`；`not-run` | **sub2api-xai/grok-4.6 / high**：执行M；读取前一Provider工具/摘要历史，实际参数映射有证据 | DEP：先前同会话标记；[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [Provider手册](../maintainers/chat-provider-compatibility.md) |
| <a id="live-model-grok-xhigh"></a>**LIVE-MODEL-GROK-XHIGH**<br>G1 | `integrated`；`not-run` | **sub2api-xai/grok-4.6 / xhigh**：执行M；不得以high成功、延迟或token量推断xhigh | DEP：Grok-high；[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-model-deepseek-high"></a>**LIVE-MODEL-DEEPSEEK-HIGH**<br>G1 | `integrated`；`not-run` | **sub2api-deepseek/deepseek-v4.1-flash / high**：执行M；重点核对工具名/schema、reasoning历史兼容、终态和后续新输入 | DEP：前序上下文；[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [Provider手册](../maintainers/chat-provider-compatibility.md) |
| <a id="live-model-deepseek-xhigh"></a>**LIVE-MODEL-DEEPSEEK-XHIGH**<br>G1 | `integrated`；`not-run` | **sub2api-deepseek/deepseek-v4.1-flash / xhigh**：执行M；当前端点不支持时保留失败并限制声明，不切其他Provider算过 | DEP：DeepSeek-high；[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-reasoning-provider"></a>**LIVE-REASONING-PROVIDER**<br>G1 | `integrated`；`needs-revalidation`；[W17](#window-20260917)非本轮六格 | ①六格逐项保留requested/captured/emitted/reported；②只将有正式见证的档位记reported；③503/限流/拒绝单格保留；④不支持reported时明确not-observed，不凭耗时/回复猜档位 | DEP：消费六格证据，不另重复计次；最终wire高档实际丢参/降档为failed；[reasoning](FEAT-model-reasoning-policy.md) · [Provider手册](../maintainers/chat-provider-compatibility.md) |
| <a id="live-reasoning-host-app"></a>**LIVE-REASONING-HOST-APP**<br>G1 | `integrated`；`needs-revalidation` | ①可观察在途TURN时改档，旧TURN保留旧captured、下一TURN新档；②App标题/effort装饰正确，不抹用户标题；③default/官方清装饰；④compact后仍沿同一选择语义 | DEP：复用六格和原App输入；无法稳定造在途窗口则blocked不伪造；[reasoning](FEAT-model-reasoning-policy.md) · [App判据](../maintainers/composer-working-status.md) |
| <a id="live-modeld-tools"></a>**LIVE-MODELD-TOOLS**<br>G1 | `integrated`；`needs-revalidation`；[W17](#window-20260917)有一次真实文件工具 | ①六格均完成唯一临时文件写/读及独立回读；②原生SendToUser/SendToAgent仅到测试对象；③生成/校验/释放/实际执行/结果接受/投递分层；④同STEP不产生二次副作用；⑤失败前已产生的副作用不被说成零执行 | `blocked` DEP：使用测试目录和确切对象，不对用户文件动手；[Host工具](../maintainers/host-inbound-agent-loop.md) · [authority](../maintainers/modeld-authority-boundaries.md) |
| <a id="live-session-roundtrip"></a>**LIVE-SESSION-ROUNDTRIP**<br>G1 | `integrated`；`needs-revalidation` | ①完成本节官方→三模型六档→官方→SOL完整路径；②每次读取前序事实/工具标记；③至少一个真实compact跨Provider/官方继续；④Host重启后读取原生checkpoint，而非只凭模型猜中事实 | DEP：六格+CTX-DURABILITY；不能每换模型新建空会话；[T39](T39-native-model-roundtrip.md) · [上下文连续性](../maintainers/managed-context-continuity.md) |
| <a id="live-ctx-adoption"></a>**LIVE-CTX-ADOPTION**<br>G1 | `integrated`；`needs-revalidation`；[H-CTX](#window-context-v8-20260917)有旧加载、无成功compact | ①当前有效context budget/触发策略与captured一致；②手动compact从正式入口经原生安全点；③在途/未知/非支持session拒绝；④操作ID可读，未调用provider的no-op与真正compact分开 | DEP：先当前制品；允许有界合成历史，不填巨量pad冲击Provider；[CTX-02](CTX-02-host-context-maintenance.md) · [配置](../configuration.md) |
| <a id="live-context-native-continuity"></a>**LIVE-CONTEXT-NATIVE-CONTINUITY**<br>G1 | `integrated/partial`；`not-run` | ①主动阈值compact与确认overflow后的恢复分开；②已有pending维护只有一个owner；③同请求有界resume且无普通错误无限retry；④工具/episode/root/terminal/交付可关联；⑤取消或迟到摘要不装回旧root | CODE/ENV：必须有受支持触发/观察能力，缺者保持缺口；[T32](T32-runtime-confirmed-compact.md) · [T35](T35-host-compact-wait-point.md) · [CTX-04](CTX-04-context-entrypoints-and-proof.md) |
| <a id="live-ctx-next-input"></a>**LIVE-CTX-NEXT-INPUT**<br>G1 | `integrated`；`not-run`；[H-CTX](#window-context-v8-20260917)当时真实输入未完成 | ①受控summary失败/主请求失败分别留旧回执；②用户明确换到另一授权模型后发全新nonce；③新输入能继续且旧操作不重放；④错误恢复不制造自动换模/重复工具 | ENV：优先自然失败，故障注入仅测试端；不触发旧业务Bot历史重试；[CTX-04](CTX-04-context-entrypoints-and-proof.md) · [失败证据](../reports/2026-09-17-context-provider-failure-evidence.md) |
| <a id="live-ctx-durability"></a>**LIVE-CTX-DURABILITY**<br>G1 | `integrated`；`not-run` | ①先成功compact并记旧/新root与checkpoint；②正式modeld换代、必要Host重启；③新原生消费者读取真实状态/工具结果；④回官方再受管不丢历史；⑤unknown提交保持并可对账 | DEP：真正compact前不跑此后置用例；与RESTART共用窗口但单独签；[CTX-02](CTX-02-host-context-maintenance.md) · [T39](T39-native-model-roundtrip.md) |

## W3 — 原App、可见结果、权限与故障

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-history-memory-export"></a>**LIVE-HISTORY-MEMORY-EXPORT**<br>G1 | `integrated`；`not-run` | ①history tail/thread/search与本轮nonce/工具/时间匹配；②原生Memory只写合成事实并独立读取，不把transcript当Memory；③export只导测试Bot，格式/附件/缺页/大小有说明；④重启/compact后读回 | DEP：依核心旅程复用同Bot；导出原文默认私有，公开只放结构摘要；[历史/导出合同](../product-contract.md#74-history-memory-export-events-running) · [导出回归](../../test/export.test.ts) |
| <a id="live-groups-interaction"></a>**LIVE-GROUPS-INTERACTION**<br>G1 | `integrated`；`not-run` | ①专用群create/show/update/member增删set；②受控单收件人群消息与线程/进度一致；③一对一SendToAgent实际target_id；④重复/歧义不误投；⑤删除只涉及本轮已终结群 | AUTH：仅本轮合成群/测试Bot，不群发业务对象；[Groups合同](../product-contract.md#72-groups) · [群进度](../../packages/cli/src/registry.ts) |
| <a id="live-files-jobs"></a>**LIVE-FILES-JOBS**<br>G1 | `integrated`；`not-run` | ①授权named root内stat/list/read/write/upload/download/mkdir/remove与hash读回；②越界路径/symlink拒绝；③exec非零/长任务→jobs list/show/logs/cancel→终态；④CLI退出后Job语义与输出限制符合合同 | ENV：只用测试root和受管Job句柄，不任意shell kill；[文件合同](../product-contract.md#8-云电脑文件命令) · [Jobs合同](../product-contract.md#9-云电脑执行与-jobs) |
| <a id="live-transport-security"></a>**LIVE-TRANSPORT-SECURITY**<br>G1 | `integrated`；`not-run` | ①local/daemon安全范围一致；②错token/无capability/显式远端拒绝不fallback到特权local；③只读请求不初始化/写配置/领key；④stderr/JSON/包/通知均无密钥与私有路径；⑤断连写unknown无重发 | ENV：认证负例仅loopback或自有测试服务；不探测他人接口；[安全合同](../product-contract.md#14-安全边界) · [架构](../architecture.md) |
| <a id="live-modeld-native"></a>**LIVE-MODELD-NATIVE**<br>G1 | `integrated/partial`；`needs-revalidation` | ①stock官方、patched-official、managed三路各自记录加载/输入/执行路径；②passthrough不额外触发managed List/Provider/工具；③缺桥身份从独立来源核对，不推定归属变化 | `blocked` ENV/DEP：stock组合在可恢复隔离窗口做，不能为了对照破坏日常入口；[原生边界](../maintainers/modeld-authority-boundaries.md) · [T49](T49-modeld-qualification-and-release.md) |
| <a id="live-modeld-authority"></a>**LIVE-MODELD-AUTHORITY**<br>G1 | `integrated`；`needs-revalidation` | ①受控慢读后有界恢复；②scope/Host变更、pause/取消后阻止新增执行；③共享等待者取消不杀其他有效等待；④终结TURN不复活；⑤请求/等待/原始证据年龄分别记录 | `blocked` ENV：逐对象安全延迟/撤销入口，不改整机网络；[T45执行](T45-modeld-evidence-lifetime.md) · [T47执行](T47-modeld-authority-state-machine.md) |
| <a id="live-auth-availability-native"></a>**LIVE-AUTH-AVAILABILITY-NATIVE**<br>G1 | `integrated`；`needs-revalidation` | ①2.5–4秒同STEP跨检查点复用；②新STEP不借超过2秒cache；③原始年龄≤5秒；④首次慢读在10秒累计预算内处理；⑤超龄/取消正确拒绝且无假失权 | ENV：采用原策略数值并记录对应revision；不能为了过测放宽；[AUTH票](AUTH-ownership-evidence-availability.md) · [执行Spec](../roadmap/box-runtime-impl-spec.md#modeld-effect-core) |
| <a id="live-auth-availability-tools"></a>**LIVE-AUTH-AVAILABILITY-TOOLS**<br>G1 | `integrated/partial`；`not-run` | ①真实审批跨新鲜度窗口后重查；②审批时取消/撤权/换代最终执行门阻断；③拒绝后无文件/消息副作用；④审批后的结果落盘与投递仍可追踪 | ENV/AUTH：需要实际批准操作者与可控工具；sleep不代替审批；[AUTH票](AUTH-ownership-evidence-availability.md) · [权限手册](../maintainers/modeld-authority-boundaries.md) |
| <a id="live-modeld-app"></a>**LIVE-MODELD-APP**<br>G1 | `integrated`；`not-run`；旧后端回执不覆盖App | ①未修改原版App发输入并关联同session/run/代；②增量文本/工具/失败/完成显示；③Working、typing、发送队列、父任务和监听子任务区分；④断连重连与迟到事件不复活；⑤标题/历史不丢 | `blocked` ENV：需原App真实操作与受控截图/观察，服务器回复不签可见；[Working判据](../maintainers/composer-working-status.md) · [T36](T36-composer-working-activity.md) |
| <a id="live-auth-availability-app"></a>**LIVE-AUTH-AVAILABILITY-APP**<br>G1 | `integrated`；`not-run` | ①权限等待/过期/超时/拒绝和上游503文案有区别；②动作建议不误导重放或抢归属；③控制帧不进模型正文；④App与CLI关联同一次故障 | DEP：复用AUTH/TOOLS/App窗口；[结果观察](../maintainers/run-outcome-observation.md) · [AUTH票](AUTH-ownership-evidence-availability.md) |
| <a id="live-stream-error-recovery"></a>**LIVE-STREAM-ERROR-RECOVERY**<br>G1 | `integrated`；`not-run` | ①正常stream/工具多步/终态无重复；②自然503/限流/认证错误分层；③空流/畸形/中断仅隔离注入，payload校验未释放工具；④原生Working收束；⑤新nonce正常请求可继续，retry off保持 | ENV：真实可复现错误优先，破坏协议不打生产Provider；[Provider手册](../maintainers/chat-provider-compatibility.md) · [working恢复](../maintainers/working-state-recovery.md) |
| <a id="live-ownership-alignment"></a>**LIVE-OWNERSHIP-ALIGNMENT**<br>G1/G3 | `integrated/partial`；`needs-revalidation` | ①新Bot confirmed_box；②普通profile更新不写ownership；③temporal/冲突对象拒受管执行；④历史冲突与保全/校准单独列明，不混成干净Bot失败 | AUTH：本轮只动新测试Bot；历史冲突对象另有具名决定；[T37](T37-server-ownership-admission.md) · [T38](T38-identity-write-alignment.md) |

## W4 — 原生Routine、提醒与受托自主

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-ops-routines"></a>**LIVE-OPS-ROUTINES**<br>G2 | `integrated`；`not-run`；[H-NOTICE](#history-notification)仅离线 | ①固定blueprint→disabled apply→outcome/readback→安全更新；②同operation不重复create，unknown只精确ID reconcile；③配对preview零key调用、确认bind后capsule私有；④明确enable后正式Webhook一次；⑤disable后无新fire，in-flight单独结算；⑥本轮资源清理 | DEP：执行真实TLS/key/原生任务，不用run-now或sendPrompt替代；[T43](T43-native-webhook-contract.md) · [T53](T53-agent-routines-cli.md) · [Routine步骤](../maintainers/live-end-to-end.md#webhook-journey) |
| <a id="live-ops-receivers"></a>**LIVE-OPS-RECEIVERS**<br>G2 | `integrated/partial`；`not-run` | ①verify同帧能力/模型与新鲜所有权；②实际Webhook回合记录三种授权Provider至少high，另选一个xhigh；③固定提醒正文/incident/revision正确、无自动诊断/Issue；④只验证过的模型档位列入接收者支持；⑤异常结果不广播备用 | DEP：预检不代实际请求；每次模型/代际变更重新核验；自动确认用户已读禁止；[T55](T55-custom-receiver-delivery.md) · [接收者证据](../reports/2026-09-18-receiver-model-preflight.md) |
| <a id="live-ops-observer-lifetime"></a>**LIVE-OPS-OBSERVER-LIFETIME**<br>G2 | `integrated/partial`；`not-run`；sender已在daemon，不能再写未实现 | ①显式测试通知accepted且用户确实看到后activate；②新事件入incident/outbox→daemon自主POST→原生提醒；③授权前积压不补发；④无新事件/未授权/off/超额时零模型调用；⑤停止等待HTTP/落盘，unknown不重投；⑥调用CLI退出不带走sender | DEP/CODE：短窗口可以前台collector，持久生产看MONITOR-PERSISTENCE；[T45](T45-template-webhook-delivery.md) · [自动链证据](../reports/2026-09-19-automatic-notification.md) |
| <a id="live-notice-requalification"></a>**LIVE-NOTICE-REQUALIFICATION**<br>G2 | `integrated/partial`；`not-run` | ①已授权提醒后正常重启Host或更改接收模型/预算；②旧资格失效立即停发、原因可读；③通过正式disable/unbind、精确重新绑定/测试/确认恢复未来提醒；④旧attempt和旧积压不重投；⑤无无需授权的自动重新启用 | DEP/CODE：重新资格流程必须用现有命令且不删capsule/库，缺少安全入口就回T46修复；[T46](T46-template-ops-pairing.md) · [T55](T55-custom-receiver-delivery.md) |
| <a id="live-obs-evidence"></a>**LIVE-OBS-EVIDENCE**<br>G1/G2 | `integrated/partial`；`not-run` | ①未知tray/queue failed/无STEP实际产生incident，已知失败也正确归类；②现场含事发制品/关联/副作用/覆盖缺口；③同revision在下一输入/滚动后命令仍可读；④过期降摘要不回空健康；⑤J1接纳不等CONT职责完成 | CODE/DEP：实际未接观察点记missing，不能只加JSON字段；[OBS-00](OBS-00-evidence-contracts.md) · [OBS-02](OBS-02-incident-evidence-snapshots.md) · [T45](T45-template-webhook-delivery.md) |
| <a id="live-alert-privacy"></a>**LIVE-ALERT-PRIVACY**<br>G1/G2 | `integrated`；`not-run` | ①测试prompt/tool/config中注入合成敏感哨兵；②检查实际发出body、日志、公共摘要和错误输出无泄露；③必要真实ID仅到指定私有目标，公共视图一致别名；④命令由registry生成，无任意shell/URL；⑤秘密不进report/git | DEP：观测网络仅安全摘要或哨兵匹配，不dump认证头；真实接收输出也需检查；[OBS-03](OBS-03-evidence-privacy-views.md) · [安全](../product-contract.md#14-安全边界) |
| <a id="live-ops-autonomy"></a>**LIVE-OPS-AUTONOMY**<br>G3 | `partial`；`not-run` | ①同一个接收Bot先只提醒；②用户明确委托后自主选取incident/trace、查证据、归类；③用户指明换模型时执行并验下一TURN；④仅排障不擅自重启/公开；⑤缺工具权限可解释而非编造成功 | CODE/ENV：已注册工具可先验，完整T47政策能力未完仍归来源；不永久把模板锁成只读；[T47](T47-bounded-ops-diagnosis.md) · [Skill](../../skills/grokbox/SKILL.md) |
| <a id="live-skills-templates"></a>**LIVE-SKILLS-TEMPLATES**<br>G1/G2 | `integrated/partial`；`not-run` | ①安装包中小入口+按需topic可用，命令和版本一致；②recipe pack不嵌历史数据/key/绑定/授权；③现有通用模板在私有测试范围stage/import并核对独立身份；④双实例不继承endpoint；⑤独立ledger模板尚缺则不宣称已有市场产品 | AUTH/CODE：不公开publish/visibility；ledger实现归T46而非靠模板测试造完成；[T46](T46-template-ops-pairing.md) · [templates](../../skills/grokbox/templates.md) |

## W5 — 重启、长期运行、容量与安全退路

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-modeld-restart"></a>**LIVE-MODELD-RESTART**<br>G1 | `integrated`；`needs-revalidation`；旧reapply修复不重开为新bug | ①正式expect-epoch replace/停止启动/借用同root；②新代健康及下一消息，旧STEP不重放；③必要Host重启后实际profile/worker加载；④官方选择/无补丁Host/旧schema退路分别取证；⑤通知绑定代际改变时停止且能显式重新资格 | `blocked` DEP：有真实compact后复用CTX-DURABILITY；不把重启当取消在途或回滚外部副作用；[T40](T40-persistent-release-and-rollback.md) · [正式退路](../maintainers/official-rollback-acceptance.md) |
| <a id="live-runtime-persistence"></a>**LIVE-RUNTIME-PERSISTENCE**<br>G2 | `partial`；`blocked` CODE | ①受支持service owner安装幂等；②父shell/网页退出服务仍活；③正常退出/重新启动单实例；④Box重启/环境重建后配置/凭据与加载恢复；⑤on/off不暗切Host或越权 | CODE/ENV：[T40](T40-persistent-release-and-rollback.md)先提供持久安装；不能用nohup/父PID/一次restart代替；平台Reset另行授权 |
| <a id="live-monitor-persistence"></a>**LIVE-MONITOR-PERSISTENCE**<br>G2 | `partial`；`blocked` CODE；前台collector可用 | ①canonical runRoot/durableRoot和明确目标集合；②collector随正确宿主存续且重启接续cursor；③慢RPC不挡本地故障，scope/缺源显示gap；④ack/snooze/固定现场持久；⑤无UI也持续生产新work | CODE：只登记缺失的服务装配/安装，不阻W4短链试验；[T41](T41-continuous-observation-and-alerting.md) · [T44](T44-host-ops-continuous-sensing.md) · [T50](T50-template-ops-release-proof.md) |
| <a id="live-obs-storage"></a>**LIVE-OBS-STORAGE**<br>G2 | `integrated/partial`；`not-run` | ①真实文件系统滚动/缩额/闲置GC计量含索引/辅助/暂存；②通知off仍GC；③至少跨三个维护周期及窗口内受控到期，查询无隐式GC；④24小时扩展观察另留窗口；⑤全安装未计量owner明确，不能签512MiB硬上限 | CODE/ENV：局部机制先验，跨owner预留仍归OBS-04；不用生产填满盘、改系统时钟或删历史；[OBS-04](OBS-04-bounded-observation-storage.md) · [维护回执](../reports/2026-09-18-modeld-storage-lifetime.md) |
| <a id="live-obs-safe-retirement"></a>**LIVE-OBS-SAFE-RETIREMENT**<br>G2/G3 | `partial`；`blocked` CODE；J1和CONT存储已有实现 | ①被引用恢复闭包/最后可靠点不被诊断GC删除；②旧STEP/commit_unknown/notify unknown/provision guard重启后仍拒重复副作用；③细节回收与安全标记退役分开；④容量满保护业务语义，备份恢复fence实际有效 | CODE：完整安全退役/恢复防重放未齐，先用隔离真实store；不删除账本腾位置；[OBS-05](OBS-05-safe-state-retirement.md) · [CONT存储](CONT-02-continuity-snapshots.md) |
| <a id="live-cleanup"></a>**LIVE-CLEANUP**<br>G0 | `integrated/partial`；`not-run` | ①停本轮自动授权/worker投递，禁用测试Routine并检查在途run；②保留unknown回执；③只恢复本轮受控配置/assignment并保留并发新编辑；④精确删除已终结测试Bot/群/Job/临时制品；⑤独立读回清理状态和原业务不变 | DEP：任何子项cleanup_required/unknown均不能签clean；不是批准删除旧业务或CONT退役；[执行手册](../maintainers/live-end-to-end.md#cleanup) · [release](../maintainers/release.md#live-window-procedure) |

## W6 — 已实现当前状态与明确延期范围

下列保留原稳定ID。单盒当前状态手动切片可独立验证，不要为了“清完LIVE”临时造clone/交接/退役实现，或把新建空Bot当状态迁移成功。

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-native-duplicate"></a>**LIVE-NATIVE-DUPLICATE**<br>G3 | `integrated`；`not-run`；并行f14b071/aad29d5的[离线回执](../reports/2026-09-19-native-agent-duplicate.md)保留 | ①只读计划及scope/精确源ID；②持久单次派发→实际新ID→独立归属读回；③App活动聊天变化、复制的人设/设置和Routine状态；④源有current-state标记时新对象正确清理；⑤超时/丢回执不重复创建，operations可离线读 | DEP/AUTH：选本轮可清理源，先禁用源测试Routine避免复制后自动运行；Box/Temporal分开，Temporal或启用任务另定风险范围；不把官方duplicate当完整clone；[CONT-06](CONT-06-native-duplicate-cli.md) · [操作指南](../maintainers/native-agent-duplicate.md) |
| <a id="live-current-context"></a>**LIVE-CURRENT-CONTEXT**<br>G3 | `integrated/partial`；`not-run`；[H-CONT](#history-cont)原生worker隔离证明 | ①限定native-context源及全新空白Box目标；②state show/capture→initialize→operation/reconcile→activate只解除hold；③第一条正常输入读源事实，重启后第二条沿目标最新状态；④准备期输入/取消/unknown不绕过屏障 | DEP：必须采用含current-state能力的匹配profile/worker；非空reset、完整Memory/附件不在该切片；[当前状态手册](../maintainers/current-state-control.md) · [CONT-07](CONT-07-current-context-control.md) |
| <a id="live-continuity-material"></a>**LIVE-CONTINUITY-MATERIAL**<br>G3 | `integrated/partial`；`not-run` | ①实际native-context捕获并发checkpoint有事务边界；②材料大小/范围/引用和hash可核对；③独立目标读回不依赖源runtime；④正常GC保留受保护闭包 | CODE/DEP：四档自动保全、Memory/展示历史/附件全量仍未完成；[CONT-02](CONT-02-continuity-snapshots.md) · [原生绑定回执](../reports/2026-09-19-continuity-native-binding.md) |
| <a id="live-ownership-continuity"></a>**LIVE-OWNERSHIP-CONTINUITY**<br>D | `planned/partial`；`excluded` | 北极星：确认接管→新Bot可接活→逐职责交接→旧入站收敛→条件退役；不能用单个initialize代整链 | CODE/AUTH：本轮仅已实现手动状态切片；完整替身另开具名窗口；[CONT-05](CONT-05-continuity-acceptance.md) · [Spec S13](../roadmap/box-runtime-impl-spec.md#continuity-delivery) |
| <a id="live-ownership-loss-protection"></a>**LIVE-OWNERSHIP-LOSS-PROTECTION**<br>G3 | `partial`；`blocked` CODE | ①真实归属变化/首次不符/gap分开；②默认暂停Routine到正式管理端、pause=false保留；③通知不终结业务职责；④enabled意图/在途fire可读 | CODE：CONT保护策略与宿主仍须接齐；不改业务Bot归属造例；[CONT-01](CONT-01-ownership-loss-notification.md) · [CONT-11](CONT-11-policy-and-operation-contract.md) |
| <a id="live-continuity-primitives"></a>**LIVE-CONTINUITY-PRIMITIVES**<br>D | `planned/partial`；`excluded` | 完整状态clone的身份、Memory/历史/当前状态、首次/重开执行及unknown；官方duplicate已拆入独立行，不能代完整导入 | CODE：等完整clone入口及独立授权；[CONT-03](CONT-03-native-box-clone.md) · [CONT-07](CONT-07-current-context-control.md) |
| <a id="live-continuity-spawn"></a>**LIVE-CONTINUITY-SPAWN**<br>D | `planned`；`excluded` | 初始化前零请求、受管指令/指定模型首次启动、compact后继续、幂等与临时清理 | CODE：不以隐藏send代spawn；[CONT-08](CONT-08-instructed-spawn.md) |
| <a id="live-continuity-handover"></a>**LIVE-CONTINUITY-HANDOVER**<br>D | `planned`；`excluded` | 新旧按职责并行、群/DM/Routine/回调指路、旧入站未知保留、新一代关联 | CODE/AUTH：不代做业务关系迁移；[CONT-04](CONT-04-automatic-replacement.md) · [CONT-09](CONT-09-relationship-handover.md) |
| <a id="live-continuity-retirement"></a>**LIVE-CONTINUITY-RETIREMENT**<br>D | `planned`；`excluded` | 健康覆盖非零活动猜测、依赖/新入站竞态、正式删除与多代继任 | CODE/AUTH：gap不计quiet、计时器不授权删除；[CONT-10](CONT-10-inbound-convergence-retirement.md) |
| <a id="live-config-home-reset"></a>**LIVE-CONFIG-HOME-RESET**<br>D | `partial`；`excluded` | 真实平台Reset下durable/config/models/secrets、aliases、安装身份/原off保留；不把进程restart当Reset | AUTH/ENV：需可丢弃Box和平台Reset单独授权，不删home模拟；[T59](T59-config-migration-cutover.md) · [T60](T60-config-ops-integration-proof.md) |
| <a id="live-provider-minimax"></a>**LIVE-PROVIDER-MINIMAX**<br>G3 | `integrated`；`excluded`；[W17](#window-20260917)保留旧兼容证据 | 若版本仍承诺MiniMax，需在明确授权/可用通道重验多步工具/inline continuation/空辅助结果；Routine基础转由W4统一测 | AUTH/ENV：不在本轮三模型许可中，不借其他Provider通过签MiniMax；[Provider手册](../maintainers/chat-provider-compatibility.md#regression-and-live-acceptance) |
| <a id="live-optional-capabilities"></a>**LIVE-OPTIONAL-CAPABILITIES**<br>G3 | `integrated/experimental`；`not-run` | quota只读归一化/无凭据明确；box status与已许可wake/keepalive区分；desktop keep/prune仅专用屏幕且可恢复；不支持平台/无capability正确拒绝 | AUTH/ENV：高影响wake/屏幕修改另列目标；有条件支持的发布声明需证据或显式限定；[quota](../quota.md) · [Sandbox](../cursor-sandbox-control-plane.md) · [desktop](../product-contract.md#6-capability-路由) |
| <a id="live-cli-reserved"></a>**LIVE-CLI-RESERVED**<br>G1 | `reserved`；`not-run` | host status/realign/logs等保留命令必须准确告知替代/未支持，不误执行；帮助/Skill/README不展示成可用功能 | DEP：普通拒绝旅程足够，不为其临时造实现；[registry](../../packages/cli/src/registry.ts) · [产品合同](../product-contract.md) |
| <a id="live-ops-maintenance"></a>**LIVE-OPS-MAINTENANCE**<br>D | `planned/partial`；`excluded` | 原生admission fence、提出者/子任务排空、唯一controller、撤销/审批/新任务竞态及恢复 | CODE/AUTH：手动host切换不签自动维护；[T48](T48-low-risk-host-qualification.md) · [T49](T49-policy-host-maintenance.md) |
| <a id="live-ops-issue-publishing"></a>**LIVE-OPS-ISSUE-PUBLISHING**<br>D | `planned`；`excluded` | 无默认自动Issue；用户将来决定公开时再验草稿/目标/gh身份/脱敏/unknown，不因本轮清单建单 | AUTH：正式发布/公开issue均是另项操作；[T52](T52-consented-support-issues.md) · [T56](T56-scripted-issue-publishing.md) |

## W7 — 候选结论，不自动发布

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-release-claims"></a>**LIVE-RELEASE-CLAIMS**<br>G0 | `partial`；`not-run` | ①按G1/G2/被选G3逐条核对结果、清理与review；②README/Skill/包内CLI和实际能力一致；③声明准确的OS/Node/原生版本/模型档位/自动化边界；④已知缺陷、数据/费用/关闭/保留策略醒目；⑤许可证/依赖/历史隐私及精确tarball门独立通过 | DEP：不以通过数抵消关键失败；不能悄悄收窄默认提醒承诺求发布；发布owner明确范围后才另行授权tag/OIDC/npm/市场；[release](../maintainers/release.md) · [隐私门](../maintainers/publication-privacy.md) |

<a id="command-coverage"></a>
## 用户命令面覆盖索引（非验收结果）

此表将当前registry的每个leaf映射到唯一主场景；同一用例可另关联其他判据。新增命令必须追加明确映射，不能用通配符吞掉未来命令。保留/实验入口也必须有拒绝或声明限制用例。全局`--help/--version`及`gbox`由PACKAGE-INSTALL覆盖。可用命令/参数始终以本候选registry和包内help为准；本表不是创建`verify --live-all`。

| 命令（精确leaf） | 主场景 | 补充范围 |
|---|---|---|
| `init`, `profile list`, `profile show`, `profile use`, `profile add`, `profile update`, `profile remove`, `profile capabilities`, `doctor` | [LIVE-CLI-CONNECTIONS](#live-cli-connections) | local/daemon/有资格remote分别取证 |
| `config get`, `config set`, `config unset`, `config apply`, `config validate`, `config schema`, `config path`, `config export`, `config preset`, `config aliases`, `config recover` | [LIVE-CONFIG-EDIT](#live-config-edit) | 写确认/revision及纯读取拒副作用 |
| `config migrate`, `config bootstrap` | [LIVE-CONFIG-CUTOVER](#live-config-cutover) | 两套schema不可混用 |
| `skills list`, `skills get`, `template pack`, `template stage`, `template publish`, `template show`, `template visibility`, `template delete`, `template import` | [LIVE-SKILLS-TEMPLATES](#live-skills-templates) | 公开publish/visibility本轮excluded；私有stage需范围确认 |
| `daemon serve`, `daemon ensure`, `daemon status`, `on`, `off` | [LIVE-RUNTIME-PERSISTENCE](#live-runtime-persistence) | foreground/daemon/自启分开 |
| `upgrade`, `host start`, `host stop`, `host restart`, `runtime activate`, `runtime deactivate`, `runtime re-adopt` | [LIVE-MODELD-CUTOVER](#live-modeld-cutover) | 只走唯一生命周期程序，退路另证 |
| `host status`, `host realign`, `host logs` | [LIVE-CLI-RESERVED](#live-cli-reserved) | 应准确拒绝/指引，不冒充完成 |
| `models list`, `models use`, `models show`, `models reset`, `models check`, `models persist-key` | [LIVE-MODEL-SELECTION](#live-model-selection) | 不把persist-key写成自动迁移/多凭据通用权限 |
| `models migrate` | [LIVE-REASONING-CUTOVER](#live-reasoning-cutover) | 与config迁移不同事务 |
| `quota`, `box status`, `box wake`, `box keepalive run`, `box keepalive status`, `desktop status`, `desktop keep add`, `desktop keep remove`, `desktop prune run`, `desktop prune enable`, `desktop prune disable` | [LIVE-OPTIONAL-CAPABILITIES](#live-optional-capabilities) | 平台/权限限制，不影响未声明功能 |
| `recover`, `runtime profile analyze`, `runtime profile observe`, `runtime profile propose`, `runtime profile prune`, `runtime profile replay`, `runtime profile status`, `runtime profile watch`, `runtime profile write`, `runtime operation-recovery`, `runtime watchdog run`, `runtime contracts` | [LIVE-HOST-CAPABILITY-RECOVERY](#live-host-capability-recovery) | watcher和recovery非另一自动部署器 |
| `agents list`, `agents show`, `agents create`, `agents update`, `agents delete` | [LIVE-AGENT-LIFECYCLE](#live-agent-lifecycle) | nonce/歧义/精确清理 |
| `agents context`, `agents compact` | [LIVE-CTX-ADOPTION](#live-ctx-adoption) | 六格+持久读回另关联 |
| `agents state show`, `agents state capture`, `agents state initialize`, `agents state operation`, `agents state reconcile`, `agents state activate` | [LIVE-CURRENT-CONTEXT](#live-current-context) | 仅手动已实现切片 |
| `agents duplicate`, `agents operations show` | [LIVE-NATIVE-DUPLICATE](#live-native-duplicate) | 官方语义/精确新ID；复制Routine与App选择的副作用须记录 |
| `agents ownership` | [LIVE-OWNERSHIP-ALIGNMENT](#live-ownership-alignment) | 查询不改变归属 |
| `agents title show`, `agents title hide`, `agents title sync` | [LIVE-REASONING-HOST-APP](#live-reasoning-host-app) | 用户标题与模型装饰区分 |
| `agents routines apply`, `agents routines outcome`, `agents routines reconcile`, `agents routines list`, `agents routines show`, `agents routines enable`, `agents routines disable`, `agents routines delete`, `ops targets bind`, `ops targets disable`, `ops targets unbind`, `ops notifications send` | [LIVE-OPS-ROUTINES](#live-ops-routines) | 真实Webhook而非run-now |
| `ops targets list`, `ops targets show`, `ops targets blueprint`, `ops targets verify` | [LIVE-OPS-RECEIVERS](#live-ops-receivers) | key私有，预检不算实际接收 |
| `ops targets activate`, `ops notifications worker`, `ops notifications list`, `ops notifications show` | [LIVE-OPS-OBSERVER-LIFETIME](#live-ops-observer-lifetime) | operator已见提醒不从200推定 |
| `groups list`, `groups show`, `groups create`, `groups update`, `groups delete`, `groups members list`, `groups members add`, `groups members remove`, `groups members set`, `runtime group-progress` | [LIVE-GROUPS-INTERACTION](#live-groups-interaction) | 仅本轮测试群与对象 |
| `send`, `history outcome` | [LIVE-SEND-OUTCOME](#live-send-outcome) | nonce/run/STEP/投递分层 |
| `history search`, `history tail`, `history thread`, `memory list`, `export agent` | [LIVE-HISTORY-MEMORY-EXPORT](#live-history-memory-export) | 默认输出私有且有界 |
| `alerts trace`, `alerts list`, `runtime incident`, `runtime log`, `runtime monitor incident`, `runtime monitor capture`, `runtime monitor evidence lease` | [LIVE-OBS-EVIDENCE](#live-obs-evidence) | STEP ID与incident ID不同 |
| `fs stat`, `fs list`, `fs read`, `fs download`, `fs write`, `fs mkdir`, `fs upload`, `fs remove`, `exec run`, `jobs list`, `jobs show`, `jobs logs`, `jobs cancel` | [LIVE-FILES-JOBS](#live-files-jobs) | 精确named root/owned进程 |
| `events`, `is running` | [LIVE-MODELD-APP](#live-modeld-app) | backend流不是App已显示 |
| `runtime start`, `runtime status`, `runtime modeld replace`, `runtime modeld status`, `runtime modeld run` | [LIVE-MODELD-RESTART](#live-modeld-restart) | owned与borrowed不同 |
| `runtime storage status` | [LIVE-OBS-STORAGE](#live-obs-storage) | measured≠quota enforced |
| `runtime monitor init`, `runtime monitor run`, `runtime monitor snapshot`, `runtime monitor events`, `runtime monitor incidents`, `runtime monitor ack`, `runtime monitor snooze` | [LIVE-MONITOR-PERSISTENCE](#live-monitor-persistence) | 读不启动/迁移/采集 |

<a id="worktree-intake"></a>
## 并行 worktree 追加与回归规则

每个worktree离线完成后，在合入同一个提交中追加/更新**最小受影响场景**，不要只写“需要live”。来源票保持实现/审查事实，本页只拥有现场状态。当前稳定ID不改名、不复用；旧报告不可被新窗口覆盖。

1. **登记**：给出来源Spec/Ticket、入口与前置、对象/代际/身份、正常旅程与失败/重启反例、成功oracle、不可证明项、风险/费用/清理、需要的原生环境；用下述模板。新leaf同步命令覆盖表。
2. **集成**：未合入标`awaiting-integration`；来源SHA→固定v2 SHA的映射放窗口报告。归并相同场景的判据，不整段覆盖另一个worktree的证据。一个窗口只由协调者维护当前结果。
3. **失效**：声明受影响LIVE-ID及原因。模型adapter/effort影响六格相关格；schema/生命周期影响CUTOVER/CONSUMERS/RESTART；原生compact或状态codec影响CTX/SESSION/CURRENT；outbox/配对影响ROUTINES/RECEIVERS/OBSERVER；脱敏/存储影响PRIVACY/EVIDENCE/STORAGE。不要因docs-only变化废掉无关现场证据。
4. **执行后**：每个子oracle有事实/缺口、依赖真实性、模型档位、run/STEP/operation引用和cleanup。发现失败先固定现场、返回worktree修复/离线/审核/合入，旧失败仍可追；不得在live直接补私有状态或换nonce掩盖unknown。
5. **汇总**：按本窗口选定oracle和模型格计数，`excluded/blocked/not-run`不能进入通过分子；同一次调用只计一次实际费用。使用[轻量结构检查](../../test/live-e2e-checklist.test.ts)防止丢旧锚点、漏新命令或模型格，但检查通过不算任何live通过。

<a id="live-feature-case"></a>
### 追加模板（不是一个已注册测试）

```markdown
| <a id="live-your-feature"></a>**LIVE-YOUR-FEATURE**<br>G1/G2/G3 | `partial`；`awaiting-integration`；来源SHA；历史证据或无 | ①前置/对象；②正式入口→期望状态；③失败/重启反例；④独立oracle与可接受not-observed；⑤清理 | CODE/ENV/AUTH等具体阻断→下一动作；[来源票](来源.md) · [执行步骤](../maintainers/步骤.md) |
```

执行后第二列改写为例如`passed / WIN-YYYYMMDD-N / candidate SHA / exact scope`并链接不可变日期报告；有两个不同结果的子场景拆ID或明确子oracle，不用“部分通过”掩盖关键失败。

## 历史窗口：只作证据索引，不代表当前已部署

<a id="window-20260917"></a>
### H-W17 — 2026-09-17

A `7994b92`与B `dc03066`：配置迁移、所选Provider/工具/Memory/effort、官方回程及进程重启已有有限现场回执；App、完整checkpoint旅程及普遍兼容未因此通过。曾包含上游503和stock强关联未知，不能删去这些失败。实际身份、授权/消费与清理留[原报告](../reports/2026-09-17-live-integration-window.md)，不在本页复制PID、长摘要和累计测试数。

<a id="window-context-v8-20260917"></a>
### H-CTX — CTX-V8与后续补丁

`6fb4b48`及后续`5f2afdb`相关加载、config3/wire8、端点和modeld换代证据见[CTX-V8](../reports/2026-09-17-context-v8-live-window.md)与[失败边界](../reports/2026-09-17-context-provider-failure-evidence.md)。当时真实消息/compact链未闭合；历史工具拦截不是本轮永久环境判定，执行时重新检验正常获授权入口，仍不得绕过当前工具拒绝。

<a id="history-cont"></a>
### H-CONT — 2026-09-19原生状态集成

[原生绑定回执](../reports/2026-09-19-continuity-native-binding.md)拥有worker/CLI/持久状态的限定隔离证明与旧入口保全；不等于业务Bot恢复、全量Memory/历史或关系迁移。

<a id="history-notification"></a>
### H-NOTICE — 2026-09-18至19通知链集成

[显式发送](../reports/2026-09-18-explicit-native-notification.md)与[自动通知](../reports/2026-09-19-automatic-notification.md)保存源码、合成HTTP、真实SQLite/Node/daemon、source→v2映射和缺失末组回归。sender/激活代码已存在；生产TLS、实际接收者与collector持久安装不能由这些离线事实推导。

本次清单升级没有产生任何新的live通过结果。之后每一窗口追加日期证据链接，只更新本候选受影响行，保留上述稳定历史锚点。
