# Live E2E 执行手册：重建、集中验收与用户采用

本文件拥有执行方法和取证规则；接受目标来自 [Agent-first Spec](../roadmap/agent-first-cli/spec.md)，当前场景/结果只在 [LIVE](../tickets/LIVE-integration-validation.md)，代码/离线/审查归来源票。旧 v2 窗口是历史，不要求先跑完旧 E2E 或持续维持旧开发版可用。正式发布另遵守 [release](release.md)。

## 1. 选择验证层次，不把施工当发布

| 工作状态 | 验证方式 | 不作的承诺 |
| --- | --- | --- |
| 重建中的局部能力 | 按性质运行合同、真实存储/进程、浏览器或明确授权原生探针；及早验证高风险来源与宿主 | 不要求每个提交整站可用、全仓全绿或跑完整模型矩阵 |
| 完整功能候选 | 收口适用全仓、类型、构建、安装制品、隐私与独立审查，冻结可追溯输入 | 不从源码绿推断实际加载或用户接受 |
| 集中 E2E | 按 LIVE E0–E5 对同一候选做真实 CLI/API、原生、浏览器、恢复和有界持续运行 | 不拼不同版本的通过，不把缺实现改成可选 |
| 用户与视觉验收 | 用户集中走核心故事后决定吃狗粮；视觉定稿后完成 E6 的相应体验验证 | 不让用户长期使用替工程补证据，不自动发布 |

旧测试按其性质复用、迁移或随退役合同退出，不为了保持旧入口而增加兼容壳。局部缺口应有 owner 和闭合条件；整合候选必须处理适用失败，不能用“施工允许坏”豁免最终质量。安全、数据不丢和未知不重放始终有效。

### 验证工具

```bash
bun run verify:live-window -- candidate --json
bun run verify:live-window -- plan --scenario LIVE-CLI-API --json
bun run verify:live-window -- receipt --file <redacted-receipt.json> --json
```

`candidate` 只检查源码身份、输入稳定性和清单结构，不能单独放行原生操作。`--allow-dirty` 只产生规划信息；正式候选必须固定实际制品。`plan` 不执行场景，已退役场景不再生成执行计划；`receipt` 的结构合格不签用户或产品验收。

`probe` 只运行当前 registry 中显式允许的只读命令，可用 `--bin <固定制品入口>` 指定实际 CLI；默认入口的可达/成功不证明它就是目标候选。当前旧实现的只读发现例子：

```bash
grokbox skills list --json
```

这是施工盘点，不是新 CLI 合同。CLI-04 切换时必须同批迁移示例、probes、Skill、包和命令覆盖；不先填入尚未实现的新命令。执行全链路时加载 [maintainer Skill](../../.agents/skills/grokbox-live-validation/SKILL.md)。

<a id="window-record"></a>
## 2. 候选、目标、授权与停止规则

集中验收前登记一次可追溯候选，不固定分支名字。独立局部原生探针也要固定其输入和目标，但无需先完成整个产品。一个实际窗口一份 `docs/reports/<日期>-live-<主题>.md`，只放脱敏摘要；原始证据留在受控私有位置。

```text
windowId / operator / startedAt / endedAt
selected LIVE IDs, acceptance stage, explicit exclusions and reasons
source commits/content digest -> built artifacts -> actual loaded identities
CLI/Server/Web/modeld/Host adapter and native versions, locks/toolchain
configuration/policy revisions, installation/account/source scopes
exact test object roles and private receipt references
allowed actions, native changes, request/cost/time budgets, cleanup scope
nonce/request/operation/submission/run/STEP/work/attempt correlations
per oracle: action -> observation -> independent check -> result -> notProven
first failure, unresolved effects, safe stop/recovery and retained resources
```

沿用仍有效的明确授权，不逐动作重复询问；但旧报告、本清单或“允许施工不可用”本身不授权现役切换、真实资料改写、费用、关系迁移、平台 Reset 或公开发布。执行前核对本次目标与原许可范围，扩大时再对齐。不得把全局 shim 或活动服务指向施工 worktree。

对象和预算按新旅程确定，不机械沿用旧窗口的五 Bot/48 任务上限。至少区分长会话主 Bot、原生/跟随/指定关系对照、通知接收者与授权的材料/交接对象；优先安全复用已明确角色，不为每个断言创建新对象。顶层输入数不等于 Provider HTTP 次数、摘要次数或费用，分别计量并设限；无法硬限的部分披露并在观察点停止。

**停止受影响的变更路径**：身份/加载不符、影响非目标资料、重复推理/工具、关键写结果未知、预算耗尽、秘密泄露或无法保全数据。先保留首个失败和原身份，再只做已授权的读回/对账；独立检查可以继续。不能换 nonce 重发旧意图、切 Provider 掩盖失败、清账本或绕过工具拒绝。

恢复目标可以是安全停用、修复后重装或产品定义的官方退出，不要求回到旧开发版继续服务。已发生效果不可回滚；重新接入前必须识别未结/unknown 与旧 writer，不能因为旧内部库不承诺导入就忘掉真实外部效果。

## 3. E0：首次安装与共同入口

- 固定完整安装制品，覆盖 CLI、Server、Web、modeld、Host 适配和声明依赖；离开源码目录仍能运行，不能用 dev server 或分支名代替字节身份。
- 及早确认目标 Box 的真实服务宿主。旧 systemd 适配和环境报告是来源，不证明当前环境；确无支持宿主是具体实现/环境阻断，不能临时 nohup 或擅改官方 supervisor。
- 接入已有原生 Bot/Memory/Project/文件而不重置身份；必要模型/连接配置按需一次性导入。索引重建披露历史起点，不建设通用旧库迁移/旧 schema 降级。
- 核对 CLI/Server/modeld/Host 实际消费者、权限和相容版本；不相容拒新执行，旧 writer 退出，未知操作保留定位路径。
- 陌生 Agent 从按需发现到 identity/capability、resolve/get；写用稳定 ref，self 缺证、名称歧义、错安装和版本不符均有明确结果。
- 真实 CLI 与浏览器共同修改一个 Bot：同一 writer、并发 revision、严格输入、计划/授权、重复点击、回执丢失与 GET 零业务副作用。Web 不执行 CLI，SSR 不成为第二业务服务。

生命周期及外部恢复还要覆盖 R05：管理服务仍不可达时，凭提交前保存的 owner/target/request 信息找回原回执，不能等恢复成功后才具有查询能力。

<a id="model-matrix"></a>
## 4. E1：模型、上下文与官方往返

三模型两档仍是已接受的集中验收目标，不是日常施工的每次前置。执行前确认实际资格、协议、配置和费用，不能把旧许可误写成当前可用性保证。需要改变目标或接受缺口时单独对齐。

| LIVE ID | 原指定目标 | effort |
| --- | --- | --- |
| LIVE-MODEL-SOL-HIGH | sub2api-codex/gpt-6-sol | high |
| LIVE-MODEL-SOL-XHIGH | sub2api-codex/gpt-6-sol | xhigh |
| LIVE-MODEL-GROK-HIGH | sub2api-xai/grok-4.6 | high |
| LIVE-MODEL-GROK-XHIGH | sub2api-xai/grok-4.6 | xhigh |
| LIVE-MODEL-DEEPSEEK-HIGH | sub2api-deepseek/deepseek-v4.1-flash | high |
| LIVE-MODEL-DEEPSEEK-XHIGH | sub2api-deepseek/deepseek-v4.1-flash | xhigh |

同一主 Bot 保持官方→六格→官方→受管的长会话旅程，不在每次换模型时换空 Bot 或清历史。使用短小合成材料：唯一标记、跨语言事实、文件引用和已完成工具回执；Memory、展示历史、文件及真实上下文分别检查。

每格至少：新输入和相关历史→一次安全工具副作用及独立读回→requested/captured/emitted 的实际 effort 链→真正 compact 的 operation/root/checkpoint→新输入采用并继续。Provider 没有可信实际档位回报时 reported 保持 not-observed；no-op 不签 compact 成功，模型复述事实不代原生持久读回。

三种模型关系另做对照：原生不隐式 opt-in，跟随者随默认变化，显式指定即使等于默认也不变成跟随。更新被指定模型自身配置只影响后续轮次，在途保留捕获；在用引用拒删/默认拒清空，覆盖并发换绑和 CLI/Web 冲突。

手动 compact、主动阈值和 confirmed-overflow 分别验。至少一个真实 compact 后经正式 modeld/必要 Host 重启，由新消费者读取 checkpoint 再回官方/受管。拒绝/失败/旧 unknown 与后续新输入分开，不靠重发旧失败任务或另一 Provider 的绿覆盖。审批跨时间窗与撤权用真实原生屏障，不用 sleep 替代。

## 5. E2：材料、事件与两个界面

原版 App 的输入、Working/typing/队列、工具审批、增量、终结与错误必须有同一原生身份的实际观察；后台回执和自有 Web 不签原版 App。只用授权测试群/目标，不形成无限 Bot 对话。

材料从授权来源检索到原位置，再显式读正文和按能力修改。使用合成数据独立核对原内容、membership、写结果及索引追赶；覆盖缺源/同步延迟、监听漏报、索引重建、版本冲突和外部 writer 限制。不把无结果写成全局不存在，不通过 file 绕过领域权限。

快照→cursor 续流覆盖重复/乱序/断线/旧代/保留窗口/慢消费者。原生无 replay 时校准当前状态并报告 gap，不能补造历史；Gateway 后台观察连接对原生焦点的副作用须按版本验证，不能只因 SSE 可读就签持续观察。

朴素 Web 也要验证真实 SSR/API、会话隔离、同源/外部 HTTPS、Host/Origin/CSRF、代理信任、URL 恢复、刷新/返回、切对象、草稿/冲突、重复提交及未知恢复。请求、缓存、草稿、订阅各有 owner；无秘密序列化、无每组件 collector，关页面不取消后台操作。API/reducer 通过不代浏览器。

文件与 Job 验受控 named root、字节/hash、越界拒绝、真实进程身份、日志截断、取消/超时和调用者退出。故障注入只影响本次拥有的资源，不断整机网络、不填满业务磁盘、不修改私有账本制造成功。

<a id="webhook-journey"></a>
## 6. E3：默认保护、交接与通知

确认 Box-owned 后默认观察和保全，可逐 Bot 调整/关闭。来源失联/stale 不等于官方回收；确认丢失后按有效策略由后台推进，不要求 Agent 循环 advance。材料/新身份/激活/可工作/关系迁移/旧对象可退役各有证据；可靠 checkpoint 优先，降级也必须有原生能力和披露。Bot 可辅助理解，不能代签执行。

新旧群/DM/Routine 等关系只在已接受、具备资格且获本窗口授权的范围验证。unknown 不重复，独立步骤可继续；旧 ref 不重定向。缺覆盖、入站 gap、资源依赖或可靠退役能力时保留旧对象，同时把未兑现的必需能力留在来源票，不把安全拒绝当整链交付。

通知必须分别验证：

- 健康首装完成接收者/Routine/绑定与必要授权后，可以不测试而显式启用；verify 不发送，enable 不暗中测试。
- 独立可选 test 向已配置目标发送固定测试内容，产生 test work/attempt，不伪造 incident；测试失败/unknown 与启用状态分开。
- 原生 Routine、配对和真实提醒分别读回；HTTP accepted、原生 run、最终提醒和用户实际看见不是同一事实。
- 启用后真实新管理异常→固定证据→outbox→后台投递→接收提醒，关闭页面/CLI 后仍继续；关闭通知不关闭必要采集/维护。
- 去重、有限重试、授权前积压、撤销、模型/代际资格改变和 unknown 先对账；不借改接收者重投同一未知 work。

验收计划需要证明真实投递，但产品不要求用户先测试成功或人工声明收到才启用。普通提醒结束后不自动诊断/建单；用户明确委托的后续自主工作仍按实际授予能力验证。

## 7. E4：成品寿命与持续运行

分别验证 CLI/浏览器退出、Web 重启、管理服务重启、modeld 正常替换/崩溃恢复和目标宿主重启。管理服务重启不主动终止已经开始的合法 modeld 执行；新工作仍核实时资格。恢复后一个 owner/writer，原操作可定位，不因新进程重放旧 STEP 或通知。

采集、索引、通知的慢源/失败有独立故障与资源预算，不阻断基本管理和必要本地观察；队列/日志/临时文件/索引/DB 的实际占用有界。先验实际维护周期、受控到期、重启后幂等与数据读回，再安排至少24小时的有界持续观察。记录实际时长/负载/资源与覆盖；计划时长不算完成，也不靠用户提前吃狗粮补测。

日常回原生模型、完整退出 Host 集成、重装新版和旧开发版降级是不同事项。前两者按产品合同验证，后者不是本次通用承诺。原生身份/资料、未知副作用及未补丁 Host 的真实可继续性不能因为施工期允许中断而放弃。

<a id="cleanup"></a>
## 8. E5/E6：收束、用户验收与最终呈现

关闭本次自动外发许可，核对测试 Routine/run/Job/租约及未结效果。只处理本次拥有且可安全终结的资源；文件按可恢复回收方式处理，不自动删除原生资料或旧状态。保留 unknown 和必要证据，不用旧 DB 镜像复活已执行效果。

精确恢复本次改动或记录保留的新状态，保护并行编辑；允许留在新版或安全停用，不要求每次回到旧开发版。清理未知则记录 cleanup_required，不假称结束。

汇总适用 G0/G1/G2 与所声明 G3：实际候选/依赖/费用、失败、缺口、审查及清理。完整功能资格不能靠缩小承诺求通过。随后由用户集中走核心故事，明确接受或拒绝；Agent 不能替用户签字。通过后才进入日常吃狗粮，不是先长时间用起来再补基本工程证明。

视觉定稿后单独验证最终页面、响应式、可访问性、资源和动效，以及受影响功能回归；不重跑无关 Provider 矩阵。功能 E2E 通过不表示视觉已经确认。发布、tag/npm/市场/公开 Issue 仍是单独授权链。

## 9. 固定窗口回执

每窗口一个报告，每个 LIVE-ID 一个稳定章节，不为每个调用制造报告。使用 ISO 时间和时区；报告不含凭据、私有路径、原始转录或 Provider body。

```markdown
### LIVE-ID / windowId
候选：source/content -> built artifacts -> actual loaded；原生/配置范围。
输入：目标角色、授权范围、request/operation 私有引用、预算。
依赖：fixture/fake/local-real/native-isolated/external-real/browser 分别说明。

| 子判据 | 动作与独立观察 | 安全证据引用 | 结果与局限 |
| --- | --- | --- | --- |
| LIVE-ID/01 | 实际入口与结果，不是预期描述 | 报告锚点或受控引用 | passed/failed/blocked/not-run |

恢复：未结效果、保留资源、清理/安全停用及下一步。
关联：来源修复票、影响场景、回归与旧失败报告。
承接：仅复用仍适用证据，说明候选/依赖未受影响的依据和未重跑范围。
```

<a id="evidence-lifecycle"></a>
## 10. 证据与复验

| 内容 | 唯一落点 |
| --- | --- |
| 当前集中验收结果、限定候选和一个证据入口 | LIVE 对应场景；不堆逐轮日志 |
| 固定动作、观察、失败、依赖真实性、预算与恢复 | 日期报告及其场景锚点 |
| 实现、离线、独立审查缺口 | 原来源票，必要时新增有独立责任的修复票 |
| 临时 ENV/AUTH/BUDGET/TOOL 阻断 | 当次报告写观察与解除条件，LIVE 只保留当前影响 |
| 原始日志/截图/材料 | 受控私有证据位置，公开只放安全引用 |

修复后更新候选并按依赖选择复验；不改旧报告成成功，不无条件累加跨版本通过。共享合同/权限改变必须覆盖相关 CLI/API/Web，视觉调整不自动重验模型。旧语法退役同步迁移检查，旧真实反例迁入正确 owner，不删除仍成立的安全性质。

整条场景的必需项与适用清理齐备才勾选 passed。只做了局部验证就记录局部范围，不签整行；结构检查、代码 review、浏览器、原生和用户接受各有自己的证明边界。
