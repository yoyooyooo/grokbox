# LIVE — 重建后的集中验收与当前结果

本页是新版完整功能候选的 **E2E Checklist 与当前结果唯一入口**。[Agent-first Spec](../roadmap/agent-first-cli/spec.md)决定验收义务，来源票负责实现/离线/独立审查，日期报告保存固定证据，[执行手册](../maintainers/live-end-to-end.md)拥有执行方法。本页不是逐提交发布闸门，也不是要求先把旧版本验完才能重建。

<a id="validation-levers"></a>
## 执行杠杆与 Skill 路由

`bun run verify:live-window -- candidate --json` 只做结构与候选预检，不代表产品已达到集中验收条件。`plan --scenario <id>` 选择未退役场景，`probe` 仅执行当前实际 registry 的显式只读入口，`receipt` 校验脱敏回执结构。它们不发送提示、不切模型、不启用 Routine、不重启服务或清理对象。规划中的新语法未注册前不得放进 probe；切换命令时由 CLI-04 同批迁移工具、手册、Skill 与覆盖表。

执行已授权原生/E2E 切片时使用 [`grokbox-live-validation` Skill](../../.agents/skills/grokbox-live-validation/SKILL.md)。普通模型切换的 [validation 主题](../../skills/grokbox/validation.md)只证明其有限回复/标题检查，不代替本页的 Provider、compact、原版 App 或自有 Web 验收。

## 当前验收基线

- **目标是首次使用前的完整重建，尚无新版候选或现场通过。** 施工期允许暂时无法构建、运行或使用，不建设零停机、临时双轨和旧命令兼容层。局部检查用于尽早发现问题，不承诺中间版本可供用户使用。
- **旧 `RC-E2E-20260919` 不再是默认执行计划。** 旧 v2、schema/wire、测试计数和 REVIEW/ENV 观察保留在来源票及固定报告，只支持原范围；不要求先关闭旧候选再重建。已有有效代码/反例可复用，必须按新合同核对。
- **新版范围从接受目标确定。** 默认保护、证据支持的交接、统一后台、材料检索/修改、CLI/API 和功能 Web 均不能因暂未实现而改成可选。功能与安全先验，视觉定稿后另验；不将旧 CONT 的所有远期愿景自动纳入。
- **不沿用旧现场授权叙述作为新操作凭据。** 已有明确授权在其原范围内有效，实际执行前核对目标、动作、费用和清理范围；新界面、关系迁移、平台 Reset、发布和真实资料清理不从本次规划获得权限。
- **施工期不可用不放弃数据安全和成品可靠性。** 保护原生身份/资料/凭据及未知外部效果；不要求恢复旧开发版连续服务，但须能安全停止、对账及按产品合同回官方。旧内部历史按 Spec 不承诺导入，不授权自动删除。

<a id="release-lanes"></a>
## 必验范围与状态

| Gate | 新版用途 | 完成要求 |
|---|---|---|
| **G0** | 固定候选、范围/授权/预算、数据保全、清理、用户验收与结论 | 集中验收必需；只有被实际修改的目标才需相应恢复措施，不以旧开发版降级为默认门 |
| **G1** | 已接受功能：CLI/API、模型/原生往返、材料、默认保护/交接、管理异常、功能 Web 与访问安全 | 完整功能候选必须完成适用判据；CODE/资格不足不能改成 excluded 求通过 |
| **G2** | 常驻后台、启用后的自主通知、独立寿命、恢复、容量和有界长期运行 | 已接受的无人值守职责属于必验，不靠前台脚本或用户提前吃狗粮补证据 |
| **G3** | 所声明外部平台、可选 Provider、外部 Box 控制等独立范围 | 按明确支持声明与授权选择，已有必要能力仍需有去向；不扩成无限兼容矩阵 |
| **D** | 明确未接受/未选扩展与已退役旧场景 | excluded 不是通过；superseded 保留含义与替代路线，不再执行旧合同 |

实现状态与本候选结果分开。此轮 `partial` 表示存在可复用实现但未按新版完整核验，不把旧 integrated 视作新版实现完成。历史通过仍是历史事实；没有新版制品/范围的证据不继承勾选。

| Result | 含义 |
|---|---|
| `not-run` | 无本候选现场证据；规划/代码存在不代表 ready |
| `awaiting-integration` | 本次所需改动未进入同一候选；不是要求固定分支名或每个提交都部署 |
| `ready` | 对应实现、回归/审查、实际制品、环境与执行授权已齐；结构预检不能单独签此状态 |
| `running` | 有候选、窗口、目标和实际调用；掉线不是成功 |
| `passed` | 明确候选/对象/依赖范围的全部必需判据及适用清理有证据 |
| `failed` | 实际违反判据，保留首个失败、来源修复和受影响复验范围 |
| `blocked` | 明确 CODE/REVIEW/ENV/AUTH/BUDGET/TOOL/DEP 及解除条件，不泛称待 live |
| `needs-revalidation` | 旧证据因相关字节/原生能力/配置改变不足以支持新候选 |
| `excluded` | 当前窗口明确不运行，保留理由与资格限制；必需功能不得自行排除 |
| `superseded` | 原合同已替代；保留稳定锚点与替代链接，不借旧 ID 改写历史 |

<a id="window-order"></a>
## 开发验证与集中验收

开发期间按受影响性质做合同、存储、进程、浏览器或原生局部验证；关键原生写能力和服务宿主应早探明。可重排施工、暂留明确的中间缺口，不为维持旧全仓绿保留旧入口；仍适用的不变量必须迁入新测试。局部验证不反复跑整张 LIVE 或全模型矩阵，也不签整个产品可用。

完整功能集成后才冻结候选、完成适用整体检查和独立审查，再依以下路线集中验收。各段是依赖关系而非多次发布；失败修复后只重验受影响范围，不能把不同候选的成功无条件拼成一份通过。

| 段 | 集中验收范围 |
|---|---|
| E0 | 新版安装、必要配置导入、原生数据接入、真实制品/权限与基础发现 |
| E1 | CLI/API 共用用例、模型三种关系、三模型两档、工具/compact 与官方往返 |
| E2 | 原版 App、材料/日志/事件与自有 Web 功能、安全和恢复 |
| E3 | 默认保护、材料/继任/交接边界，管理异常与显式启用后的通知 |
| E4 | 独立进程寿命、重启/未知结果、容量和有界持续运行 |
| E5 | 测试资源收束、完整工程结论与用户集中验收；之后才开始日常吃狗粮 |
| E6 | 视觉定稿后的体验验收与最终声明；发布另行授权，不重跑无关后端矩阵 |

## E0 — 候选与首次安装

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-release-candidate"></a>**LIVE-RELEASE-CANDIDATE**<br>G0 | [ ] `partial`；`not-run` | ①固定完整候选源码/锁/CLI/Server/Web/modeld/Host 适配与实际制品；②适用全仓/安装回归及独立审查有结论；③登记所选场景、原生数据保全、对象/预算与安全停止路径；④结构预检、工程资格、用户验收和发布分开 | 来源与实施差额：[前置证据](../reports/2026-09-19-pre-e2e-closeout.md#测试独立审查与证据层级) · [窗口手册](../maintainers/live-end-to-end.md#window-record) |
| <a id="live-package-install"></a>**LIVE-PACKAGE-INSTALL**<br>G1 | [ ] `partial`；`not-run` | ①从固定发行制品在隔离前缀安装 CLI、Server、Web/modeld 所需内容，离开源码可运行；②支持的 Node/平台与原生依赖实测；③grokbox/gbox 同义且帮助/Skill 同版本；④重复安装/卸载不丢原生资料；⑤制品覆盖 apps、客户端及部署配置，不以 dev server 代签 | 来源与实施差额：[release](../maintainers/release.md#candidate-gate) · [包入口](../../package.json) |
| <a id="live-cli-connections"></a>**LIVE-CLI-CONNECTIONS**<br>G1 | [ ] `partial`；`not-run` | ①默认固定本机、显式 connection 不修改共享当前目标；②连接管理与身份/能力诊断准确；③普通业务统一经管理服务；④远端失败不回退特权本地；⑤bootstrap/离线诊断/外部恢复明确例外，不把旧 local/direct/daemon 三路当兼容门 | 来源与实施差额：[Profile合同](../product-contract.md#5-profile-合同) · [CLI registry](../../packages/cli/src/registry.ts) |
| <a id="live-network-boundary"></a>**LIVE-NETWORK-BOUNDARY**<br>G1/G3 | [ ] `partial`；`not-run` | ①默认/本地init不调用Tailscale、不自动选远端；②外部自管HTTPS入口在无Tailscale CLI客户端上doctor准确且不读Serve；③认证/能力/监听器失败拒绝mutation，健康recover无SSH即no-op；④受控已安装daemon仅SSH ensure，wake只在provider确认休眠后；⑤旧peer/bootstrap/Serve/recovery选项、字段和写路径全部退出，拒绝旧输入且不修改既有外部网络配置；现成端点验证不伪称已执行服务换代 | 来源与实施差额：[网络合同](../product-contract.md#2-默认入口与连接) · [NET-01现行入口与退役](NET-01-box-local-network-boundary.md#compatibility-and-operator-migration) |
| <a id="live-config-edit"></a>**LIVE-CONFIG-EDIT**<br>G1 | [ ] `partial`；`not-run` | ①严格结构输入、字段/清空语义及领域权限；②旧 revision/未确认写零业务副作用；③preview、同键回执、commit 与 adoption 分开；④导出不含秘密或安装身份；⑤CLI/API 共用 writer，冲突不丢后续编辑 | 来源与实施差额：[配置指南](../configuration.md) · [T58](T58-config-command-single-writer.md) |
| <a id="live-config-cutover"></a>**LIVE-CONFIG-CUTOVER**<br>D | [ ] `partial`；`superseded` | 旧 config3→4 成套迁移场景已退役，不作为新版首次使用的前置；历史语义/证据仍由 T59 保留。新版必要配置导入与 writer 退出见 [INITIAL-ADOPTION](#live-initial-adoption)，不承诺通用旧内部历史迁移 | 来源与实施差额：[配置迁移](../configuration.md#one-way-migration-and-recovery) · [T59](T59-config-migration-cutover.md) |
| <a id="live-config-consumers"></a>**LIVE-CONFIG-CONSUMERS**<br>G1 | [ ] `partial`；`not-run` | ①实际consumer启动/写入revision与请求匹配；②storage、ops、model域互不误失效；③配置committed/effective与applied区分；④坏配置仍可取证；⑤不热加载的域显示所需重启，不伪造全storage applied | 来源与实施差额：[T51](T51-ops-capability-presets.md) · [T60](T60-config-ops-integration-proof.md) |
| <a id="live-modeld-cutover"></a>**LIVE-MODELD-CUTOVER**<br>G0 | [ ] `partial`；`not-run` | ①实际 CLI/Server/modeld/Host 适配、原生版本与运行代可关联；②协议/配置相容并从真实消费者读回；③不相容版本拒新执行；④唯一 controller/明确宿主采用；⑤在途/unknown 不被清掉，不要求旧开发版零停机 | 来源与实施差额：[T40](T40-persistent-release-and-rollback.md) · [HCR](HCR-02-loaded-capabilities.md) |
| <a id="live-reasoning-cutover"></a>**LIVE-REASONING-CUTOVER**<br>D | [ ] `partial`；`superseded` | 旧 models2 迁移/旧 schema 降级场景已退役；必要 effort/模型/凭据引用导入归 [INITIAL-ADOPTION](#live-initial-adoption)，新选择与实际请求归 MODEL-SELECTION/REASONING-PROVIDER；不删字段伪造兼容 | 来源与实施差额：[reasoning](FEAT-model-reasoning-policy.md) · [模型配置](../configuration.md#model-reasoning-schema-and-general-config-migration) |
| <a id="live-host-capability-recovery"></a>**LIVE-HOST-CAPABILITY-RECOVERY**<br>G1 | [ ] `partial`；`not-run` | ①旧/缺wrapper或reader给出准确doctor指引；②同源profile升级保持其他能力；③受控中断经operation-recovery恢复操作元数据；④实际loaded能力和新STEP闭环；⑤busy拒绝不自动force | 来源与实施差额：[HCR来源](README.md#host-capability-recovery) · [能力合同](../roadmap/host-seam-ops-recognition.md#capability-recovery) |

## E1 补充 — 共同入口与操作合同

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-initial-adoption"></a>**LIVE-INITIAL-ADOPTION**<br>G0 | [ ] `planned`；`not-run` | ①干净新版安装并接入原生 Bot/Memory/Project/文件，身份不重置；②必要模型/连接配置一次性导入，秘密不外泄；③旧 writer 退出，未知外部效果不重复；④派生索引重建并披露历史起点；⑤不要求旧内部 DB/日志迁入或通用降级 | [CLI-05](CLI-05-implementation-follow-through.md)、[T59](T59-config-migration-cutover.md)、[数据范围](../roadmap/agent-first-cli/spec.md#数据兼容范围) |
| <a id="live-agent-discovery"></a>**LIVE-AGENT-DISCOVERY**<br>G1 | [ ] `planned`；`not-run` | ①从按需发现到真实身份/能力、解析和读取；②名称歧义、self 缺证、错安装拒绝；③写入用稳定 ref，旧 Bot ref 不指向继任者；④严格输入、机器输出、有界分页与不兼容版本错误 | [CLI-01](CLI-01-discovery-and-targeting.md)、[CLI-04](CLI-04-command-cutover.md) |
| <a id="live-cli-api"></a>**LIVE-CLI-API**<br>G1 | [ ] `partial`；`not-run` | ①真实 CLI/API/浏览器读取和修改同一 Bot，进入同一领域用例；②并发 revision 冲突不丢更新/草稿；③权限和错误语义一致；④GET 不建库/启动/修复，Web 不执行 CLI；⑤原生无 CAS 的真实限制可见 | [T29](T29-runtime-webui.md)、[WEB-02](WEB-02-web-foundation.md)、[CLI-02](CLI-02-operation-contract.md) |
| <a id="live-operation-recovery"></a>**LIVE-OPERATION-RECOVERY**<br>G1 | [ ] `partial`；`not-run` | ①同键同语义返回原回执、异义冲突；②已接受且成功改变 revision/plan 已过期后仍可找回，重放不再首次准入；③断连/刷新/重启/迟到无重复效果；④服务不可达时凭提交前信息定位生命周期/外部恢复 owner；⑤cancel/resume/reconcile 各按真实范围 | [CLI-02](CLI-02-operation-contract.md)、[R01/R05](../reports/2026-09-19-agent-first-cli-review.md) |

## E1 — Bot、模型、effort、工具与 compact

本轮专用长会话 Bot 保留三模型两档的目标旅程：**官方 → SOL high → SOL xhigh → Grok high → Grok xhigh → DeepSeek high → DeepSeek xhigh → 官方 → SOL high**。保留同一默认会话/受管状态；每个模型格独立验，不用为每次换档新建空Bot回避上下文兼容问题。另设一个不参与变更的控制Bot；测试身份从实际回执取得，不复用历史Bot。

三模型两档是原已接受的集中验收目标，不代表当前 Provider 可用或每次局部修改都要跑六格。正式执行固定实际模型/协议/配置/预算；若能力不足，保留该格阻断并明确对齐，不以另一模型通过替代。新增三种选择关系的对照对象与材料/交接资源，预算按实际场景登记，不沿用旧窗口的固定对象数。

**六格共同最低判据 M**：记录exact provider/model/API路径类别和凭据引用摘要（无地址秘密）；执行一次相关新消息、一次可独立读回的安全工具副作用、一次真实`bot context compact`及其后新消息/状态读取；核对配置→TURN captured→SDK/adapter→最终请求的effort，标记转义/映射，区分Provider reported。保持中文/英文/Unicode、唯一事实标记、工具历史与原用户标题。compact必须有原生operation/root/checkpoint及后续读回；no-op不算该格compact通过。计数与步骤可复用同一回合，不重复造请求。[具体步骤/样例](../maintainers/live-end-to-end.md#model-matrix)。

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-agent-lifecycle"></a>**LIVE-AGENT-LIFECYCLE**<br>G1 | [ ] `partial`；`not-run` | ①create含明确Box请求/defer-start/nonce；②原生Server确认及list/show同ID；③更新name/description/title/notify/hidden不改ownership；④歧义/重复nonce不误创建；⑤清理阶段删除精确测试Bot并读回 | 来源与实施差额：[Agent合同](../product-contract.md#71-agents) · [T38](T38-identity-write-alignment.md) |
| <a id="live-agent-isolation"></a>**LIVE-AGENT-ISOLATION**<br>G1 | [ ] `partial`；`not-run` | ①原生、跟随默认、显式指定的 Bot 对照；②默认变更仅影响跟随者，显式指定即使值相同也不转跟随；③单 Bot 变更不改其他选择/资料；④并发 Bot 请求不混身份、上下文或计费 | 来源与实施差额：[T24](T24-runtime-route-binding.md) · [模型Skill](../../skills/grokbox/models.md) |
| <a id="live-send-outcome"></a>**LIVE-SEND-OUTCOME**<br>G1 | [ ] `partial`；`not-run` | ①send新nonce→排队→原生run/TURN/STEP→终态→投递→历史/App；②同nonce/断连unknown不自动重发；③正文含Unicode/换行/JSON数据但不伪造控制帧；④CLI超时与任务失败分开 | 来源与实施差额：[结果手册](../maintainers/run-outcome-observation.md) · [Send合同](../product-contract.md#73-send) |
| <a id="live-model-selection"></a>**LIVE-MODEL-SELECTION**<br>G1 | [ ] `partial`；`not-run` | ①三种选择关系与无默认拒绝；②模型配置更新仅供后续 TURN，在途保留实际捕获版本；③在用模型拒删、仍有跟随者时默认拒清空，并验并发换绑；④effort/default 清覆盖与回原生不混淆；⑤probe 费用显式、unsupported 不静默降档 | 来源与实施差额：[reasoning票](FEAT-model-reasoning-policy.md) · [模型Skill](../../skills/grokbox/models.md) |
| <a id="live-model-sol-high"></a>**LIVE-MODEL-SOL-HIGH**<br>G1 | [ ] `partial`；`not-run` | **sub2api-codex/gpt-6-sol / high**：执行M；分别填chat、tool、effort emitted、compact checkpoint、post-compact回读；Provider reported未知单列 | 来源与实施差额：[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-model-sol-xhigh"></a>**LIVE-MODEL-SOL-XHIGH**<br>G1 | [ ] `partial`；`not-run` | **sub2api-codex/gpt-6-sol / xhigh**：执行M；与high是同通道且同会话；旧TURN不被在途改档重写 | 来源与实施差额：[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-model-grok-high"></a>**LIVE-MODEL-GROK-HIGH**<br>G1 | [ ] `partial`；`not-run` | **sub2api-xai/grok-4.6 / high**：执行M；读取前一Provider工具/摘要历史，实际参数映射有证据 | 来源与实施差额：[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [Provider手册](../maintainers/chat-provider-compatibility.md) |
| <a id="live-model-grok-xhigh"></a>**LIVE-MODEL-GROK-XHIGH**<br>G1 | [ ] `partial`；`not-run` | **sub2api-xai/grok-4.6 / xhigh**：执行M；不得以high成功、延迟或token量推断xhigh | 来源与实施差额：[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-model-deepseek-high"></a>**LIVE-MODEL-DEEPSEEK-HIGH**<br>G1 | [ ] `partial`；`not-run` | **sub2api-deepseek/deepseek-v4.1-flash / high**：执行M；重点核对工具名/schema、reasoning历史兼容、终态和后续新输入 | 来源与实施差额：[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [Provider手册](../maintainers/chat-provider-compatibility.md) |
| <a id="live-model-deepseek-xhigh"></a>**LIVE-MODEL-DEEPSEEK-XHIGH**<br>G1 | [ ] `partial`；`not-run` | **sub2api-deepseek/deepseek-v4.1-flash / xhigh**：执行M；当前端点不支持时保留失败并限制声明，不切其他Provider算过 | 来源与实施差额：[模型步骤](../maintainers/live-end-to-end.md#model-matrix) · [reasoning](FEAT-model-reasoning-policy.md) |
| <a id="live-reasoning-provider"></a>**LIVE-REASONING-PROVIDER**<br>G1 | [ ] `partial`；`not-run` | ①六格逐项保留requested/captured/emitted/reported；②只将有正式见证的档位记reported；③503/限流/拒绝单格保留；④不支持reported时明确not-observed，不凭耗时/回复猜档位 | 来源与实施差额：[reasoning](FEAT-model-reasoning-policy.md) · [Provider手册](../maintainers/chat-provider-compatibility.md) |
| <a id="live-reasoning-host-app"></a>**LIVE-REASONING-HOST-APP**<br>G1 | [ ] `partial`；`not-run` | ①可观察在途TURN时改档，旧TURN保留旧captured、下一TURN新档；②App标题/effort装饰正确，不抹用户标题；③default/官方清装饰；④compact后仍沿同一选择语义 | 来源与实施差额：[reasoning](FEAT-model-reasoning-policy.md) · [App判据](../maintainers/composer-working-status.md) |
| <a id="live-modeld-tools"></a>**LIVE-MODELD-TOOLS**<br>G1 | [ ] `partial`；`not-run` | ①六格均完成唯一临时文件写/读及独立回读；②原生SendToUser/SendToAgent仅到测试对象；③生成/校验/释放/实际执行/结果接受/投递分层；④同STEP不产生二次副作用；⑤失败前已产生的副作用不被说成零执行 | 来源与实施差额：[Host工具](../maintainers/host-inbound-agent-loop.md) · [authority](../maintainers/modeld-authority-boundaries.md) |
| <a id="live-session-roundtrip"></a>**LIVE-SESSION-ROUNDTRIP**<br>G1 | [ ] `partial`；`not-run` | ①完成本节官方→三模型六档→官方→SOL完整路径；②每次读取前序事实/工具标记；③至少一个真实compact跨Provider/官方继续；④Host重启后读取原生checkpoint，而非只凭模型猜中事实 | 来源与实施差额：[T39](T39-native-model-roundtrip.md) · [上下文连续性](../maintainers/managed-context-continuity.md) |
| <a id="live-ctx-adoption"></a>**LIVE-CTX-ADOPTION**<br>G1 | [ ] `partial`；`not-run` | ①当前有效context budget/触发策略与captured一致；②手动compact从正式入口经原生安全点；③在途/未知/非支持session拒绝；④操作ID可读，未调用provider的no-op与真正compact分开 | 来源与实施差额：[CTX-02](CTX-02-host-context-maintenance.md) · [配置](../configuration.md) |
| <a id="live-context-native-continuity"></a>**LIVE-CONTEXT-NATIVE-CONTINUITY**<br>G1 | [ ] `partial`；`not-run` | ①主动阈值compact与确认overflow后的恢复分开；②已有pending维护只有一个owner；③同请求有界resume且无普通错误无限retry；④工具/episode/root/terminal/交付可关联；⑤取消或迟到摘要不装回旧root | 来源与实施差额：[T32](T32-runtime-confirmed-compact.md) · [T35](T35-host-compact-wait-point.md) · [CTX-04](CTX-04-context-entrypoints-and-proof.md) |
| <a id="live-ctx-next-input"></a>**LIVE-CTX-NEXT-INPUT**<br>G1 | [ ] `partial`；`not-run` | ①受控summary失败/主请求失败分别留旧回执；②用户明确换到另一授权模型后发全新nonce；③新输入能继续且旧操作不重放；④错误恢复不制造自动换模/重复工具 | 来源与实施差额：[CTX-04](CTX-04-context-entrypoints-and-proof.md) · [失败证据](../reports/2026-09-17-context-provider-failure-evidence.md) |
| <a id="live-ctx-durability"></a>**LIVE-CTX-DURABILITY**<br>G1 | [ ] `partial`；`not-run` | ①先成功compact并记旧/新root与checkpoint；②正式modeld换代、必要Host重启；③新原生消费者读取真实状态/工具结果；④回官方再受管不丢历史；⑤unknown提交保持并可对账 | 来源与实施差额：[CTX-02](CTX-02-host-context-maintenance.md) · [T39](T39-native-model-roundtrip.md) |

## E2 — 原版 App、材料与功能 Web

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-materials-search"></a>**LIVE-MATERIALS-SEARCH**<br>G1 | [ ] `planned`；`not-run` | ①跨已授权 agent/user/project 与 Project 文件检索并定位原来源；②metadata 与正文权限分开；③来源缺失/同步延迟/索引年龄与空结果区分；④重建索引不修改源或补造历史；⑤原生 membership 不从目录猜测 | [DATA-01](DATA-01-memory-project-files.md)、[CLI-03](CLI-03-observation-and-wait.md)；[只读来源核验](../reports/2026-09-19-live-source-qualification.md)只证有限元数据，不签本行通过 |
| <a id="live-materials-write"></a>**LIVE-MATERIALS-WRITE**<br>G1 | [ ] `planned`；`not-run` | ①合成源材料经真实 owner 修改并独立读回；②CLI/Web 并发、外部 writer 限制、版本冲突和 unknown 有证据；③源提交与索引追赶分开；④只读来源不虚构 CRUD，file 入口不绕权限；⑤范围不足保留实现差额 | [DATA-01](DATA-01-memory-project-files.md)、[CLI-02](CLI-02-operation-contract.md) |
| <a id="live-event-continuity"></a>**LIVE-EVENT-CONTINUITY**<br>G1 | [ ] `planned`；`not-run` | ①快照/cursor/filter 同边界接续；②重复/乱序/重连/旧代/超保留期明确 gap；③原生缺 replay 不补造历史；④慢订阅有界、不阻管理操作；⑤无页面持续采集，Gateway 观察者断开对原生焦点的影响经版本资格验证 | [CLI-03](CLI-03-observation-and-wait.md)、[T41](T41-continuous-observation-and-alerting.md)、[来源研究](../reports/2026-09-19-webui-source-feasibility.md) |
| <a id="live-web-foundation"></a>**LIVE-WEB-FOUNDATION**<br>G1 | [ ] `planned`；`not-run` | ①实际打包 Web/SSR/API，本地及自管外部 HTTPS 到同一 Box；②会话、Origin/Host/CSRF、代理信任、权限拒绝与秘密隔离；③SSR 请求缓存不串身份，hydration 不重复开服务；④URL 恢复、刷新/后退和切对象不串草稿/缓存/订阅 | [WEB-02](WEB-02-web-foundation.md)、[T29](T29-runtime-webui.md) |
| <a id="live-web-functional"></a>**LIVE-WEB-FUNCTIONAL**<br>G1 | [ ] `planned`；`not-run` | ①Bot、材料、运行/日志、异常、保护和系统管理的接受功能接真服务；②正常/空/加载/无权限/stale/冲突/unknown 可辨识且可恢复；③必要操作与 CLI 一致，键盘/窄屏基本可用；④低保真不豁免安全或可靠性，不要求聊天/审批回复 | [WEB-03](WEB-03-functional-prototype.md)、[页面目标](../roadmap/future/webui-console.md) |

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-history-memory-export"></a>**LIVE-HISTORY-MEMORY-EXPORT**<br>G1 | [ ] `partial`；`not-run` | ①history tail/thread/search与本轮nonce/工具/时间匹配；②原生Memory只写合成事实并独立读取，不把transcript当Memory；③export只导测试Bot，格式/附件/缺页/大小有说明；④重启/compact后读回 | 来源与实施差额：[历史/导出合同](../product-contract.md#74-history-memory-export-events-running) · [导出回归](../../test/export.test.ts) |
| <a id="live-groups-interaction"></a>**LIVE-GROUPS-INTERACTION**<br>G1 | [ ] `partial`；`not-run` | ①专用群create/show/update/member增删set；②受控单收件人群消息与线程/进度一致；③一对一SendToAgent实际target_id；④重复/歧义不误投；⑤删除只涉及本轮已终结群 | 来源与实施差额：[Groups合同](../product-contract.md#72-groups) · [群进度](../../packages/cli/src/registry.ts) |
| <a id="live-files-jobs"></a>**LIVE-FILES-JOBS**<br>G1 | [ ] `partial`；`not-run` | ①授权named root内stat/list/read/write/upload/download/mkdir/remove与hash读回；②越界路径/symlink拒绝；③exec非零/长任务→jobs list/show/logs/cancel→终态；④CLI退出后Job语义与输出限制符合合同 | 来源与实施差额：[文件合同](../product-contract.md#8-云电脑文件命令) · [Jobs合同](../product-contract.md#9-云电脑执行与-jobs) |
| <a id="live-transport-security"></a>**LIVE-TRANSPORT-SECURITY**<br>G1 | [ ] `partial`；`not-run` | ①local/daemon安全范围一致；②错token/无capability/显式远端拒绝不fallback到特权local；③只读请求不初始化/写配置/领key；④stderr/JSON/包/通知均无密钥与私有路径；⑤断连写unknown无重发 | 来源与实施差额：[安全合同](../product-contract.md#14-安全边界) · [架构](../architecture.md) |
| <a id="live-modeld-native"></a>**LIVE-MODELD-NATIVE**<br>G1 | [ ] `partial`；`not-run` | ①stock官方、patched-official、managed三路各自记录加载/输入/执行路径；②passthrough不额外触发managed List/Provider/工具；③缺桥身份从独立来源核对，不推定归属变化 | 来源与实施差额：[原生边界](../maintainers/modeld-authority-boundaries.md) · [T49](T49-modeld-qualification-and-release.md) |
| <a id="live-modeld-authority"></a>**LIVE-MODELD-AUTHORITY**<br>G1 | [ ] `partial`；`not-run` | ①受控慢读后有界恢复；②scope/Host变更、pause/取消后阻止新增执行；③共享等待者取消不杀其他有效等待；④终结TURN不复活；⑤请求/等待/原始证据年龄分别记录 | 来源与实施差额：[T45执行](T45-modeld-evidence-lifetime.md) · [T47执行](T47-modeld-authority-state-machine.md) |
| <a id="live-auth-availability-native"></a>**LIVE-AUTH-AVAILABILITY-NATIVE**<br>G1 | [ ] `partial`；`not-run` | ①2.5–4秒同STEP跨检查点复用；②新STEP不借超过2秒cache；③原始年龄≤5秒；④首次慢读在10秒累计预算内处理；⑤超龄/取消正确拒绝且无假失权 | 来源与实施差额：[AUTH票](AUTH-ownership-evidence-availability.md) · [执行Spec](../roadmap/box-runtime-impl-spec.md#modeld-effect-core) |
| <a id="live-auth-availability-tools"></a>**LIVE-AUTH-AVAILABILITY-TOOLS**<br>G1 | [ ] `partial`；`not-run` | ①真实审批跨新鲜度窗口后重查；②审批时取消/撤权/换代最终执行门阻断；③拒绝后无文件/消息副作用；④审批后的结果落盘与投递仍可追踪 | 来源与实施差额：[AUTH票](AUTH-ownership-evidence-availability.md) · [权限手册](../maintainers/modeld-authority-boundaries.md) |
| <a id="live-modeld-app"></a>**LIVE-MODELD-APP**<br>G1 | [ ] `partial`；`not-run` | ①未修改原版App发输入并关联同session/run/代；②增量文本/工具/失败/完成显示；③Working、typing、发送队列、父任务和监听子任务区分；④断连重连与迟到事件不复活；⑤标题/历史不丢 | 来源与实施差额：[Working判据](../maintainers/composer-working-status.md) · [T36](T36-composer-working-activity.md) |
| <a id="live-auth-availability-app"></a>**LIVE-AUTH-AVAILABILITY-APP**<br>G1 | [ ] `partial`；`not-run` | ①权限等待/过期/超时/拒绝和上游503文案有区别；②动作建议不误导重放或抢归属；③控制帧不进模型正文；④App与CLI关联同一次故障 | 来源与实施差额：[结果观察](../maintainers/run-outcome-observation.md) · [AUTH票](AUTH-ownership-evidence-availability.md) |
| <a id="live-stream-error-recovery"></a>**LIVE-STREAM-ERROR-RECOVERY**<br>G1 | [ ] `partial`；`not-run` | ①正常stream/工具多步/终态无重复；②自然503/限流/认证错误分层；③空流/畸形/中断仅隔离注入，payload校验未释放工具；④原生Working收束；⑤新nonce正常请求可继续，retry off保持 | 来源与实施差额：[Provider手册](../maintainers/chat-provider-compatibility.md) · [working恢复](../maintainers/working-state-recovery.md) |
| <a id="live-ownership-alignment"></a>**LIVE-OWNERSHIP-ALIGNMENT**<br>G1/G3 | [ ] `partial`；`not-run` | ①新Bot confirmed_box；②普通profile更新不写ownership；③temporal/冲突对象拒受管执行；④历史冲突与保全/校准单独列明，不混成干净Bot失败 | 来源与实施差额：[T37](T37-server-ownership-admission.md) · [T38](T38-identity-write-alignment.md) |

## E3 — 原生 Routine、提醒与受托自主

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-ops-routines"></a>**LIVE-OPS-ROUTINES**<br>G2 | [ ] `partial`；`not-run` | ①固定blueprint→disabled apply→outcome/readback→安全更新；②同operation不重复create，unknown只精确ID reconcile；③配对preview零key调用、确认bind后capsule私有；④明确enable后正式Webhook一次；⑤disable后无新fire，in-flight单独结算；⑥本轮资源清理 | 来源与实施差额：[T43](T43-native-webhook-contract.md) · [T53](T53-agent-routines-cli.md) · [Routine步骤](../maintainers/live-end-to-end.md#webhook-journey) |
| <a id="live-ops-receivers"></a>**LIVE-OPS-RECEIVERS**<br>G2 | [ ] `partial`；`not-run` | ①verify同帧能力/模型与新鲜所有权；②实际Webhook回合记录三种授权Provider至少high，另选一个xhigh；③固定提醒正文/incident/revision正确、无自动诊断/Issue；④只验证过的模型档位列入接收者支持；⑤异常结果不广播备用 | 来源与实施差额：[T55](T55-custom-receiver-delivery.md) · [接收者证据](../reports/2026-09-18-receiver-model-preflight.md) |
| <a id="live-ops-observer-lifetime"></a>**LIVE-OPS-OBSERVER-LIFETIME**<br>G2 | [ ] `partial`；`not-run` | ①必要配置/授权齐备可显式启用，无须先测试或人工声明收到；②独立可选 test 产生真实 test work/attempt，不伪造 incident，verify 不发送；③新异常→后台 outbox→原生提醒且无需外部 Agent 常驻；④关页面/CLI 后继续，off/未授权零投递；⑤未知先对账，不补旧积压 | 来源与实施差额：[T45](T45-template-webhook-delivery.md) · [自动链证据](../reports/2026-09-19-automatic-notification.md) |
| <a id="live-notice-requalification"></a>**LIVE-NOTICE-REQUALIFICATION**<br>G2 | [ ] `partial`；`not-run` | ①绑定/模型/权限/代际变化后重核真实资格；②失效停发且原因可查；③恢复经新合同的显式授权路径，测试不成为隐含门槛；④旧 unknown/积压不重投；⑤重启不扩大已有授权 | 来源与实施差额：[T46](T46-template-ops-pairing.md) · [T55](T55-custom-receiver-delivery.md) |
| <a id="live-obs-evidence"></a>**LIVE-OBS-EVIDENCE**<br>G1/G2 | [ ] `partial`；`not-run` | ①未知tray/queue failed/无STEP实际产生incident，已知失败也正确归类；②现场含事发制品/关联/副作用/覆盖缺口；③同revision在下一输入/滚动后命令仍可读；④过期降摘要不回空健康；⑤J1接纳不等CONT职责完成 | 来源与实施差额：[源边界证明](../reports/2026-09-19-pre-e2e-observation.md#producer-boundaries) · [OBS-00](OBS-00-evidence-contracts.md) · [OBS-02](OBS-02-incident-evidence-snapshots.md) · [T45](T45-template-webhook-delivery.md) |
| <a id="live-alert-privacy"></a>**LIVE-ALERT-PRIVACY**<br>G1/G2 | [ ] `partial`；`not-run` | ①测试prompt/tool/config中注入合成敏感哨兵；②检查实际发出body、日志、公共摘要和错误输出无泄露；③必要真实ID仅到指定私有目标，公共视图一致别名；④命令由registry生成，无任意shell/URL；⑤秘密不进report/git | 来源与实施差额：[OBS-03](OBS-03-evidence-privacy-views.md) · [安全](../product-contract.md#14-安全边界) |
| <a id="live-ops-autonomy"></a>**LIVE-OPS-AUTONOMY**<br>G3 | [ ] `partial`；`not-run` | ①同一个接收Bot先只提醒；②用户明确委托后自主选取incident/trace、查证据、归类；③用户指明换模型时执行并验下一TURN；④仅排障不擅自重启/公开；⑤缺工具权限可解释而非编造成功 | 来源与实施差额：[T47](T47-bounded-ops-diagnosis.md) · [Skill](../../skills/grokbox/SKILL.md) |
| <a id="live-skills-templates"></a>**LIVE-SKILLS-TEMPLATES**<br>G1/G2 | [ ] `partial`；`not-run` | ①安装包中小入口+按需topic可用，命令和版本一致；②recipe pack不嵌历史数据/key/绑定/授权；③现有通用模板在私有测试范围stage/import并核对独立身份；④双实例不继承endpoint；⑤独立ledger模板尚缺则不宣称已有市场产品 | 来源与实施差额：[T46](T46-template-ops-pairing.md) · [templates](../../skills/grokbox/templates.md) |

## E4 — 寿命、恢复与有界持续运行

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-service-independence"></a>**LIVE-SERVICE-INDEPENDENCE**<br>G2 | [ ] `partial`；`not-run` | ①关闭浏览器/CLI 不停后台；②管理服务或 Web 重启不主动杀已开始的合法 modeld 执行，新工作仍检查资格；③采集/索引/通知故障隔离，队列/日志/磁盘有界；④重启不重复 worker/writer，停止等待自有事务结算；⑤真实目标宿主可安装而非仅 dev server/nohup | [CLI-05](CLI-05-implementation-follow-through.md)、[T40](T40-persistent-release-and-rollback.md)、[T29](T29-runtime-webui.md) |

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-modeld-restart"></a>**LIVE-MODELD-RESTART**<br>G1 | [ ] `partial`；`not-run` | ①正式expect-epoch replace/停止启动/借用同root；②新代健康及下一消息，旧STEP不重放；③必要Host重启后实际profile/worker加载；④官方选择/无补丁Host/旧schema退路分别取证；⑤通知绑定代际改变时停止且能显式重新资格 | 来源与实施差额：[T40](T40-persistent-release-and-rollback.md) · [正式退路](../maintainers/official-rollback-acceptance.md) |
| <a id="live-runtime-persistence"></a>**LIVE-RUNTIME-PERSISTENCE**<br>G2 | [ ] `partial`；`not-run` | ①受支持service owner安装幂等；②父shell/网页退出服务仍活；③正常退出/重新启动单实例；④Box重启/环境重建后配置/凭据与加载恢复；⑤on/off不暗切Host或越权 | 来源与实施差额：[服务注册](../maintainers/runtime-service-registration.md) · [T40](T40-persistent-release-and-rollback.md) |
| <a id="live-monitor-persistence"></a>**LIVE-MONITOR-PERSISTENCE**<br>G2 | [ ] `partial`；`not-run` | ①canonical runRoot/durableRoot和明确目标集合；②collector随正确宿主存续且重启接续cursor；③慢RPC不挡本地故障，scope/缺源显示gap；④ack/snooze/固定现场持久；⑤无UI也持续生产新work | 来源与实施差额：[服务内证明](../reports/2026-09-19-pre-e2e-observation.md#collector-lifetime) · [T41](T41-continuous-observation-and-alerting.md) · [T44](T44-host-ops-continuous-sensing.md) · [T50](T50-template-ops-release-proof.md) |
| <a id="live-obs-storage"></a>**LIVE-OBS-STORAGE**<br>G2 | [ ] `partial`；`not-run` | ①真实文件系统滚动/缩额/闲置GC计量含索引/辅助/暂存；②通知off仍GC；③至少跨三个维护周期及窗口内受控到期，查询无隐式GC；④24小时扩展观察另留窗口；⑤未覆盖owner与旧writer明确，不签全安装或OS quota | 来源与实施差额：[诊断接纳证据](../reports/2026-09-19-diagnostic-admission.md#固定执行证据) · [OBS-04](OBS-04-bounded-observation-storage.md) |
| <a id="live-obs-safe-retirement"></a>**LIVE-OBS-SAFE-RETIREMENT**<br>G2/G3 | [ ] `partial`；`not-run` | ①引用闭包/最后可靠点不被诊断GC删除；②旧STEP/commit_unknown/notify unknown/provision在GC及新进程后拒重复副作用；③明细退役保留精确保护，未结前缀不饿死其余GC；④验证支持的通知DB恢复与服务epoch边界，容量满不清账本 | 来源与实施差额：[owner边界](../reports/2026-09-19-pre-e2e-closeout.md#安全退役最小保护由执行入口消费) · [OBS-05](OBS-05-safe-state-retirement.md) · [CONT存储](CONT-02-continuity-snapshots.md) |
| <a id="live-cleanup"></a>**LIVE-CLEANUP**<br>G0 | [ ] `partial`；`not-run` | ①收束本轮通知/测试 Routine、在途 run/Job 和租约；②unknown 与必要记录保留；③精确恢复本次改动或说明新版保留状态，不要求回旧开发版；④自有已终结资源按授权回收，文件进入可恢复回收站；⑤独立读回原生资料和非目标未受损 | 来源与实施差额：[执行手册](../maintainers/live-end-to-end.md#cleanup) · [release](../maintainers/release.md#live-window-procedure) |

## E3 补充 — 保护、当前状态与交接

默认保护、真实身份接替与证据支持的交接属于新版必验。逐项固定原生能力、材料和授权边界；缺能力时验其诚实阻断，同时保留未兑现的实现差额，不能用单个 initialize 或安全拒绝代替整项交付。下列少量 D/G3 行仍为独立范围，不随核心保护自动晋升。

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-native-duplicate"></a>**LIVE-NATIVE-DUPLICATE**<br>G1 | [ ] `partial`；`not-run` | ①只读计划及scope/精确源ID；②持久单次派发→实际新ID→独立归属读回；③App活动聊天变化、复制的人设/设置和Routine状态；④源有current-state标记时新对象正确清理；⑤超时/丢回执不重复创建，operations可离线读 | 来源与实施差额：[CONT-06](CONT-06-native-duplicate-cli.md) · [操作指南](../maintainers/native-agent-duplicate.md) |
| <a id="live-current-context"></a>**LIVE-CURRENT-CONTEXT**<br>G1 | [ ] `partial`；`not-run` | ①匹配profile/worker后初始化与释放；②实际下一输入及重启后沿目标最新状态；③reset不复活旧摘要/历史补齐，Memory/指令保留；④unknown不重复写，活动自调用明确拒绝 | 来源与实施差额：[CONT-07](CONT-07-current-context-control.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-continuity-material"></a>**LIVE-CONTINUITY-MATERIAL**<br>G1 | [ ] `partial`；`not-run` | ①实际事务捕获及字节/依赖；②Memory/历史有界来源和缺口；③重启/并发GC保持工作流引用；④memory/resume/archive的实际采集与容量表现 | 来源与实施差额：[CONT-02](CONT-02-continuity-snapshots.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-ownership-continuity"></a>**LIVE-OWNERSHIP-CONTINUITY**<br>G1 | [ ] `planned`；`not-run` | ①默认材料保全→确认丢失→后台按证据推进继任；②可靠 checkpoint 优先，降级路径逐项有原生能力与缺口说明；③新 Bot 可工作、关系交接、旧 Bot 可退役分别验；④独立步骤可继续、unknown 不重放，Bot 判断不替代执行回执 | 来源与实施差额：[CONT-05](CONT-05-continuity-acceptance.md) · [Spec S13](../roadmap/box-runtime-impl-spec.md#continuity-delivery) |
| <a id="live-ownership-loss-protection"></a>**LIVE-OWNERSHIP-LOSS-PROTECTION**<br>G1 | [ ] `partial`；`not-run` | ①确认 Box-owned 后默认观察与保全，可逐 Bot 调整/关闭；②真实归属丢失与断连/stale/gap 区分；③只按合格事实和有效策略启动后台保护；④通知与替换各有回执，保护不借通知授权扩权 | 来源与实施差额：[CONT-01](CONT-01-ownership-loss-notification.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-continuity-primitives"></a>**LIVE-CONTINUITY-PRIMITIVES**<br>G1 | [ ] `partial`；`not-run` | ①clone/replace 的真实新身份和材料来源；②准备/激活/运行分开；③后台推进与重启恢复，不要求调用者循环 advance；④unknown 不重建，旧 ref 不重定向，材料不足诚实阻断而非假成功 | 来源与实施差额：[CONT-03](CONT-03-native-box-clone.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-continuity-spawn"></a>**LIVE-CONTINUITY-SPAWN**<br>G1 | [ ] `partial`；`not-run` | 初始化前零请求；真实新turn及首Provider请求；普通用户输入不受启动载体过滤影响；指令跨compact/重启和unknown不重复启动 | 来源与实施差额：[CONT-08](CONT-08-instructed-spawn.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-continuity-handover"></a>**LIVE-CONTINUITY-HANDOVER**<br>G1 | [ ] `partial`；`not-run` | ①真实前后继及已接受关系清单；②逐项群/DM/Routine 的原生效果，保留已有成员/启用意图；③程序后台推进、Bot 可辅助但不可自签；④未知不重放，独立关系可继续；⑤不足以兑现的关系保留缺口，不以新 Bot 可用签整链完成 | 来源与实施差额：[CONT-09](CONT-09-relationship-handover.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-continuity-retirement"></a>**LIVE-CONTINUITY-RETIREMENT**<br>G1 | [ ] `partial`；`not-run` | ①确认旧入站覆盖、quiet/gap 与依赖，不用时间到期推导可退役；②缺关键事实或可靠原生能力时保留旧对象；③已授权且具备条件时通过真实 owner 退役并读回；④缺能力的接受目标仍挂实施差额，不用安全拒绝代签实现完成 | 来源与实施差额：[CONT-10](CONT-10-inbound-convergence-retirement.md) · [代码验证回执](../reports/2026-09-19-continuity-lifecycle-integration.md) |
| <a id="live-config-home-reset"></a>**LIVE-CONFIG-HOME-RESET**<br>D | [ ] `partial`；`excluded` | 真实平台Reset下durable/config/models/secrets、aliases、安装身份/原off保留；不把进程restart当Reset | 来源与实施差额：[T59](T59-config-migration-cutover.md) · [T60](T60-config-ops-integration-proof.md) |
| <a id="live-provider-minimax"></a>**LIVE-PROVIDER-MINIMAX**<br>G3 | [ ] `partial`；`excluded` | 若版本仍承诺MiniMax，需在明确授权/可用通道重验多步工具/inline continuation/空辅助结果；Routine基础由E3统一测 | 来源与实施差额：[Provider手册](../maintainers/chat-provider-compatibility.md#regression-and-live-acceptance) |
| <a id="live-optional-capabilities"></a>**LIVE-OPTIONAL-CAPABILITIES**<br>G3 | [ ] `partial`；`not-run` | quota只读归一化/无凭据明确；box status与已许可wake/keepalive区分；desktop keep/prune仅专用屏幕且可恢复；不支持平台/无capability正确拒绝 | 来源与实施差额：[quota](../quota.md) · [Sandbox](../cursor-sandbox-control-plane.md) · [desktop](../product-contract.md#6-capability-路由) |
| <a id="live-cli-reserved"></a>**LIVE-CLI-RESERVED**<br>D | [ ] `reserved`；`superseded` | 旧 host status/realign/logs 占位入口的拒绝验收已退役；CLI-04 负责每个旧意图的实现/合并/退出，新版不能为了兼容旧清单保留空壳命令 | 来源与实施差额：[registry](../../packages/cli/src/registry.ts) · [产品合同](../product-contract.md) |
| <a id="live-ops-maintenance"></a>**LIVE-OPS-MAINTENANCE**<br>D | [ ] `planned`；`excluded` | 原生admission fence、提出者/子任务排空、唯一controller、撤销/审批/新任务竞态及恢复 | 来源与实施差额：[T48](T48-low-risk-host-qualification.md) · [T49](T49-policy-host-maintenance.md) |
| <a id="live-ops-issue-publishing"></a>**LIVE-OPS-ISSUE-PUBLISHING**<br>D | [ ] `planned`；`excluded` | 无默认自动Issue；用户将来决定公开时再验草稿/目标/gh身份/脱敏/unknown，不因本轮清单建单 | 来源与实施差额：[T52](T52-consented-support-issues.md) · [T56](T56-scripted-issue-publishing.md) |

## E5/E6 — 用户验收、最终呈现与发布声明

功能工程通过不签视觉定稿；视觉待定不阻已有功能 E2E。用户集中验收决定是否进入日常吃狗粮，不要求用户先长期使用来替工程补证据。正式发布与这两个决定分别记录。

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-user-acceptance"></a>**LIVE-USER-ACCEPTANCE**<br>G0 | [ ] `planned`；`not-run` | ①适用工程 E2E、审查、清理和残余风险已交代；②用户对固定功能候选走核心故事并明确接受/拒绝，Agent 不代签；③开始吃狗粮的版本和已知限制明确；④不借此自动发布或扩大权限 | [CLI-05](CLI-05-implementation-follow-through.md)、[Spec](../roadmap/agent-first-cli/spec.md) |
| <a id="live-web-visual"></a>**LIVE-WEB-VISUAL**<br>G1 | [ ] `planned`；`not-run` | ①最终视觉得到确认，V0 不充当批准；②真实浏览器的响应式、层次、焦点/对比度/动效与资源加载符合定稿；③改造未破坏原功能/错误/权限状态；④按变更影响复验，不以截图签后台资格 | [WEB-01](WEB-01-visual-baseline.md)、[WEB-03](WEB-03-functional-prototype.md) |

| 稳定场景 / Gate | 本候选结果与证据范围 | 待完成动作与通过判据 | 阻断、下一步、来源 |
|---|---|---|---|
| <a id="live-release-claims"></a>**LIVE-RELEASE-CLAIMS**<br>G0 | [ ] `partial`；`not-run` | ①按新版 G0/G1/G2 与所声明 G3 收口适用工程、原生/浏览器和审查证据；②用户验收与日常吃狗粮资格分别记录；③视觉未定不签最终呈现完成；④文档/Skill/制品/支持范围一致；⑤发布隐私/许可/OIDC 及公开操作独立授权，不为通过暗减承诺 | 来源与实施差额：[release](../maintainers/release.md) · [隐私门](../maintainers/publication-privacy.md) |

<a id="command-coverage"></a>
## 当前源码命令覆盖（切换时同步迁移）

本表仍核对当前实际 registry，不宣称候选新语法已经可用。每个真实 leaf 有一个主场景；已退役旧入口暂映射到明确 superseded 的旧场景，只保留源码去向，不能作为新版可执行计划。CLI-04 实施切换时同批更新 registry、映射、runbook、probes 和 Skills；冻结新版候选前不得遗留指向退役场景的正式命令。新浏览器/API 义务在独立场景验收，不用 CLI 名称覆盖冒充多入口语义覆盖。

| 命令（精确leaf） | 主场景 | 补充范围 |
|---|---|---|
| `init`, `profile list`, `profile show`, `profile use`, `profile add`, `profile update`, `profile remove`, `profile capabilities`, `doctor`, `system identity get` | [LIVE-CLI-CONNECTIONS](#live-cli-connections) | local/daemon/有资格remote分别取证；本次网络边界变化另见[NET](#live-network-boundary) |
| `config get`, `config set`, `config unset`, `config apply`, `config validate`, `config schema`, `config path`, `config export`, `config preset`, `config aliases`, `config recover` | [LIVE-CONFIG-EDIT](#live-config-edit) | 写确认/revision及纯读取拒副作用 |
| `config migrate`, `config bootstrap` | [LIVE-CONFIG-CUTOVER](#live-config-cutover) | 旧 schema 命令去向；新版验证 INITIAL-ADOPTION |
| `skills list`, `skills get`, `template pack`, `template stage`, `template publish`, `template show`, `template visibility`, `template delete`, `template import` | [LIVE-SKILLS-TEMPLATES](#live-skills-templates) | 公开publish/visibility本轮excluded；私有stage需范围确认 |
| `daemon serve`, `daemon ensure`, `daemon status`, `on`, `off`, `runtime services install`, `runtime services status`, `runtime services uninstall` | [LIVE-RUNTIME-PERSISTENCE](#live-runtime-persistence) | foreground/daemon/自启分开 |
| `upgrade`, `host start`, `host stop`, `host restart`, `runtime activate`, `runtime deactivate`, `runtime re-adopt` | [LIVE-MODELD-CUTOVER](#live-modeld-cutover) | 只走唯一生命周期程序，退路另证 |
| `host status`, `host realign`, `host logs` | [LIVE-CLI-RESERVED](#live-cli-reserved) | 应准确拒绝/指引，不冒充完成 |
| `model list`, `model get`, `model apply`, `model delete`, `bot model get`, `bot model set`, `bot model reset`, `model default get`, `model default set`, `model default reset`, `models check`, `models persist-key` | [LIVE-MODEL-SELECTION](#live-model-selection) | 已迁移选择入口只经 Server；剩余维护入口单独收束，未构成完整新版 CLI |
| `operation get`, `operation reconcile`, `operation list`, `operation resume`, `operation cancel` | [LIVE-OPERATION-RECOVERY](#live-operation-recovery) | 各域回执保留原定位；lifecycle list/get/resume 已接原主体/scope/request，重复提交只读，显式续接不重发未知创建。全域取消/恢复及长期保留仍未闭合 |
| `system console grant create` | [LIVE-WEB-FOUNDATION](#live-web-foundation) | owner-only 的一次性登录码只写私有文件；console 会话与业务回执寿命分别验证 |
| `system service run`, `system service get` | [LIVE-SERVICE-INDEPENDENCE](#live-service-independence) | Server/Web 前台入口与 Server/collector 状态查询；不是全组件安装或独立 modeld 实执行寿命已通过 |
| `bot list`, `bot resolve`, `bot get` | [LIVE-CLI-API](#live-cli-api) | 有界原生 Bot 投影与明确引用，已接功能浏览器；原生资格与完整管理链仍需集中核验 |
| `quota`, `box status`, `box wake`, `box keepalive run`, `box keepalive status`, `desktop status`, `desktop keep add`, `desktop keep remove`, `desktop prune run`, `desktop prune enable`, `desktop prune disable` | [LIVE-OPTIONAL-CAPABILITIES](#live-optional-capabilities) | 平台/权限限制，不影响未声明功能 |
| `recover` | [LIVE-NETWORK-BOUNDARY](#live-network-boundary) | 默认应用恢复与显式旧映射恢复选项分开，网络故障不自动wake |
| `system host health`, `runtime profile analyze`, `runtime profile observe`, `runtime profile propose`, `runtime profile prune`, `runtime profile replay`, `runtime profile status`, `runtime profile watch`, `runtime profile write`, `runtime operation-recovery`, `runtime watchdog run`, `runtime contracts` | [LIVE-HOST-CAPABILITY-RECOVERY](#live-host-capability-recovery) | Host健康读面已接Server/Rust/原OBS，显示静态范围与未证运行见证；完整能力/实际加载仍待资格，watcher和recovery非另一自动部署器 |
| `agents list`, `agents show`, `agents create`, `agents update`, `agents delete` | [LIVE-AGENT-LIFECYCLE](#live-agent-lifecycle) | nonce/歧义/精确清理 |
| `bot context compact` | [LIVE-CTX-ADOPTION](#live-ctx-adoption) | preview/明确费用授权、原账号与计划、默认 Box current root；原请求的未知结果/续接/取消归 operation 域；六格+持久读回另关联 |
| `bot context get`, `bot snapshot create`, `bot context initialize`, `bot context reset`, `bot context restore`, `bot activate` | [LIVE-CURRENT-CONTEXT](#live-current-context) | 当前上下文已进入管理 Server；原请求回执/对账/有限取消归 operation 域，独立解除不启动任务；self-reset 排队仍未实现 |
| `bot clone`, `bot replace` | [LIVE-CONTINUITY-PRIMITIVES](#live-continuity-primitives) | 经统一管理服务预览/提交原生分阶段程序，原 CLI 直连入口退出；完整资源/职责与实际原生资格仍保留 |
| `bot spawn` | [LIVE-CONTINUITY-SPAWN](#live-continuity-spawn) | 统一管理服务，程序启动独立权限；临时结果交付/清理与首轮真实 Provider 仍分别验收 |
| `system protection get`, `system protection set`, `bot protection get`, `bot protection set`, `bot protection reset` | [LIVE-OWNERSHIP-LOSS-PROTECTION](#live-ownership-loss-protection) | 默认发现、逐 Bot 策略与原回执共用管理 Server；旧手动 observe/advance 退出，后台接管不扩大通知许可 |
| `bot snapshot list`, `bot snapshot get` | [LIVE-CONTINUITY-MATERIAL](#live-continuity-material) | 原 CONT 库的有限元数据；不读取私有正文，不把保存成功当原生导入通过 |
| `bot handover get`, `bot handover advance`, `bot handover attest` | [LIVE-CONTINUITY-HANDOVER](#live-continuity-handover) | 统一管理Server与原CONT逐职责程序；独立权限、准确版本、原observation引用及再次核验；旧agents handover直连已退出，批次完成不证明全部职责完成 |
| `bot handover observe`, `bot handover retire` | [LIVE-CONTINUITY-RETIREMENT](#live-continuity-retirement) | 原入站覆盖/观察与retirement guard；缺资源独立/删除边界保持blocked，原操作对账不调用native或重新删除 |
| `agents duplicate`, `agents operations show` | [LIVE-NATIVE-DUPLICATE](#live-native-duplicate) | 官方语义/精确新ID；复制Routine与App选择的副作用须记录 |
| `agents ownership` | [LIVE-OWNERSHIP-ALIGNMENT](#live-ownership-alignment) | 查询不改变归属 |
| `agents title show`, `agents title hide`, `agents title sync` | [LIVE-REASONING-HOST-APP](#live-reasoning-host-app) | 用户标题与模型装饰区分 |
| `routine apply`, `routine list`, `routine get`, `routine enable`, `routine disable`, `routine delete`, `notification receiver bind`, `ops notifications send` | [LIVE-OPS-ROUTINES](#live-ops-routines) | 真实Webhook而非run-now |
| `notification receiver list`, `notification receiver get`, `notification receiver verify`, `notification receiver blueprint`, `notification settings get`, `notification settings apply` | [LIVE-OPS-RECEIVERS](#live-ops-receivers) | 新读面经共享 API；key 私有，预检不算授权或实际接收；剩余配对/初始化入口独立迁移 |
| `notification receiver enable`, `notification receiver disable`, `notification receiver unbind`, `notification receiver test`, `notification list`, `notification get`, `notification status`, `ops notifications list`, `ops notifications show` | [LIVE-OPS-OBSERVER-LIFETIME](#live-ops-observer-lifetime) | 新授权、独立测试与回执复用原 owner；测试不是启用前提，unknown 不重发，不从 200 推定收到；旧 activation/revoke writer 退出 |
| `groups list`, `groups show`, `groups create`, `groups update`, `groups delete`, `groups members list`, `groups members add`, `groups members remove`, `groups members set`, `runtime group-progress` | [LIVE-GROUPS-INTERACTION](#live-groups-interaction) | 仅本轮测试群与对象 |
| `send`, `history outcome` | [LIVE-SEND-OUTCOME](#live-send-outcome) | nonce/run/STEP/投递分层 |
| `history search`, `history tail`, `history thread`, `export agent` | [LIVE-HISTORY-MEMORY-EXPORT](#live-history-memory-export) | 默认输出私有且有界 |
| `system materials get`, `file root list`, `memory list`, `memory search`, `memory read`, `project list`, `project get`, `file list`, `file search`, `file read` | [LIVE-MATERIALS-SEARCH](#live-materials-search) | 显式配置的本地来源、文档引用与独立正文权限；原生副本同步/账号资格未观测，局部材料回归不签完整原生覆盖 |
| `file write` | [LIVE-MATERIALS-WRITE](#live-materials-write) | 已授权普通文本的既有文件替换、原请求回执与索引滞后；原生 Memory/Project 分片保持只读，不冒充原生 CRUD |
| `alerts trace`, `alerts list`, `runtime incident`, `runtime log`, `runtime monitor incident`, `runtime monitor capture`, `runtime monitor evidence lease` | [LIVE-OBS-EVIDENCE](#live-obs-evidence) | STEP ID与incident ID不同 |
| `fs stat`, `fs list`, `fs read`, `fs download`, `fs write`, `fs mkdir`, `fs upload`, `fs remove`, `exec run`, `jobs list`, `jobs show`, `jobs logs`, `jobs cancel` | [LIVE-FILES-JOBS](#live-files-jobs) | 精确named root/owned进程 |
| `events`, `is running` | [LIVE-MODELD-APP](#live-modeld-app) | backend流不是App已显示 |
| `runtime start`, `runtime status`, `runtime modeld replace`, `runtime modeld status`, `runtime modeld run` | [LIVE-MODELD-RESTART](#live-modeld-restart) | owned与borrowed不同 |
| `runtime storage status` | [LIVE-OBS-STORAGE](#live-obs-storage) | measured≠quota enforced |
| `system observation get`, `incident list`, `incident get`, `incident ack`, `incident snooze`, `runtime monitor init`, `runtime monitor install`, `runtime monitor run`, `runtime monitor snapshot`, `runtime monitor events`, `runtime monitor incidents` | [LIVE-MONITOR-PERSISTENCE](#live-monitor-persistence) | 新查询和异常处理经管理 API 复用原观察库，collector 已迁入 Server Scope；旧 ack/snooze 已退出。install显式配置／初始化但不启动；持久宿主与Box自启分开验 |
| `event list`, `event watch` | [LIVE-EVENT-CONTINUITY](#live-event-continuity) | 同事务快照游标、有界 NDJSON 窗口、撤权/取消/缺口和背压；不以传输成功代替原生覆盖 |

<a id="worktree-intake"></a>
## 实现接入与复验规则

来源票记录代码/离线/审查差额；实现有影响时更新最小受影响场景和命令路由，不要求每个提交可部署或执行 LIVE。语义未变保留场景 ID；语义退役时标 superseded 并链接替代，不复用旧 ID 改写历史。一个候选的当前结果仍只有本页。

**入口有界：一场景一行当前结果，不随执行次数追加行或窗口历史段落。** 第二列只保留勾选/状态、当前适用候选或窗口、限定范围和一个当前证据入口；失败时末列仅保留阻断类别、一句影响/下一动作及来源链接。详细步骤归执行手册，逐点证据/运行过程归日期报告，修复推进归来源票。原始JSON、截图、命令输出和多轮失败经过不粘入本页。更新当前候选摘要也用替换，不串接历次候选；只有真正新增的验收义务才增加场景。

通过用`[x]`配`passed`，未通过用`[ ]`配具体结果（既有未勾选行按其结果读取）。勾选表示本条全部必需判据及适用清理在明确候选/范围下成立，不表示跑过命令；只通过部分子项不勾整行，细分结果留报告。已完成行保留稳定ID、精简判据和证据链接，不复制成另一张完成表；相关改变使证据不足时取消勾选并标`needs-revalidation`，不删除旧事实，也不因纯文档变化重跑。

证据入口须指向`../reports/<日期>-live-<主题>.md#<场景或证据汇总锚点>`。多窗口共同支撑时由该报告章节逐项引用原窗口；不把承接的旧证据冒充本轮重跑。仍然有效的阻断详细说明按[证据与阻断流转](../maintainers/live-end-to-end.md#evidence-lifecycle)归位，解除后移除入口里的旧阻断叙事。

1. **登记**：给出来源Spec/Ticket、入口与前置、对象/代际/身份、正常旅程与失败/重启反例、成功oracle、不可证明项、风险/费用/清理、需要的原生环境；用下述模板。新leaf同步命令覆盖表。
2. **集成**：需要的修改进入一个固定候选后，完成适用整体回归、制品与独立审查。来源→候选→实际制品关系可追溯，不固定分支名，不把每次合入变成部署；不切全局 shim 到施工 worktree。
3. **失效**：按实际依赖声明受影响 LIVE-ID。模型/协议影响所涉模型格和上下文；共享合同/权限影响 CLI/API/Web；材料适配影响检索/修改/恢复材料；生命周期影响独立寿命/重启/回执；事件与存储影响续流/证据/通知。纯视觉变化不重跑无关模型，文档变化不伪造运行字节变化；公共边界变化也不能只验局部页面。
4. **执行后**：每个子oracle的事实/缺口、依赖真实性、模型档位、run/STEP/operation引用和cleanup写入窗口报告的稳定锚点，本页只替换当前短结果和证据入口。发现失败先固定现场、返回worktree修复/离线/审核/合入；来源票承载修复进度，旧失败由新报告回链仍可追。不得在live直接补私有状态或换nonce掩盖unknown。
5. **汇总**：按本窗口选定oracle和模型格计数，`excluded/blocked/not-run`不能进入通过分子；同一次调用只计一次实际费用。使用[轻量结构检查](../../test/live-e2e-checklist.test.ts)防止丢旧锚点、漏新命令或模型格，但检查通过不算任何live通过。

<a id="live-feature-case"></a>
### 追加模板（不是一个已注册测试）

```markdown
| <a id="live-your-feature"></a>**LIVE-YOUR-FEATURE**<br>G1/G2/G3 | [ ] `partial`；`not-run` | ①前置/对象；②正式入口→期望状态；③失败/重启反例；④独立oracle与可接受not-observed；⑤清理 | 来源与实施差额：[来源票](来源.md) · [执行步骤](../maintainers/步骤.md) |
```

执行后第二列格式为`[x] integrated；passed；WIN-YYYYMMDD-N；candidate SHA；限定范围；证据锚点`（实现/结果仍用行内代码），这是格式示例，不是已通过记录。未闭合则保留`[ ]`与`failed/blocked/needs-revalidation`。只有子场景具有独立持续维护意义才拆ID，否则逐点差异留报告；不为每次重测新增场景，不用“部分通过”掩盖关键失败。

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

本次基线重整没有产生新的现场通过。旧 `RC-E2E-20260919` 的规划与判据见[原清单重整回执](../reports/2026-09-19-live-e2e-checklist-rebaseline.md)，其前置实现见[固定收口证据](../reports/2026-09-19-pre-e2e-closeout.md)；这些不是新版的施工或采用前置。已有历史锚点保留，后续窗口写入[报告目录](../reports/README.md)，本页只替换受影响场景的当前结果。
