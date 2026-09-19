# Live E2E 执行手册：固定候选到可发布声明

本文件只拥有**执行方法、取证格式和窗口模板**。当前候选结果、阻断、范围选择与并行worktree追加统一在[唯一LIVE清单](../tickets/LIVE-integration-validation.md)，不要在这里打第二套通过/待办勾。代码/离线/review仍归来源票；正式发布另遵守[release](release.md)。

## 1. 不是一条“跑全量”命令

先沿LIVE的W0–W7挑选本轮已实现、获授权的旅程。下面命令是**逐项操作示例**，不是可无确认粘贴运行的脚本；`<...>`必须替换为现场回执里的准确ID。必要参数以固定候选安装包的`--help`为准。不要调用尚未实现的`verify --live-all`、通用Routine invoke或模板自动安装器。

### 1.1 使用验证杠杆

需要 Agent 执行这套流程时，先加载仓库维护者的 [`grokbox-live-validation` Skill](../../.agents/skills/grokbox-live-validation/SKILL.md)。它只负责路由和边界，不拥有当前结果。可复用控制器提供四个有限入口：

```bash
bun run verify:live-window -- candidate --json
bun run verify:live-window -- plan --scenario <LIVE-ID> --json
bun run verify:live-window -- probe --probe doctor --probe roster --probe models --probe runtime --json
bun run verify:live-window -- receipt --file <redacted-receipt.json> --json
```

`candidate` 固定源码、制品和工具链身份，并运行 LIVE 文档完整性回归；`plan` 只从本索引取一个或多个稳定场景；`probe` 只调用显式列出的只读 CLI 入口并脱敏输出；`receipt` 检查窗口回执的场景、候选 SHA、证据锚点和清理状态。任何入口都不发送提示、不改变模型、不启用 Routine、不重启 Host/modeld，也不代替场景 oracle。`--allow-dirty` 只允许生成规划信息，不能作为实际候选放行。

区分依赖真实性：静态/schema测试、fake原生端、loopback真实HTTP、所选原生函数、真实Host/App/Provider分别记录。源码测试绿不等于当前Host已加载；API成功不等于用户看到；人工合成journal只能证明后半链，不能签“原生故障已被发现”。

<a id="window-record"></a>
## 2. 窗口记录、许可和停止规则

每个实际窗口写一份`docs/reports/<日期>-live-<主题>.md`，只放安全摘要；原始数据留私有现场。将报告锚点回填LIVE对应oracle。窗口开始/结束使用ISO8601和时区，例如`2026-09-19T...+08:00`，不要只写“刚才”。

```text
windowId / planned-or-running / operator / startedAt / endedAt
selected LIVE IDs + gate + excludes + reason
source commits -> integrated v2 SHA -> actual runtime/artifact hashes
Node/Bun/lock/package version/tarball integrity
Host/App/native worker/profile/CLI/modeld/daemon actual loaded identity
config/models/wire/policy revisions; old runnable artifacts and recovery plan
object roles and exact private receipt refs; no historical ID guessing
provider/model/effort/API family/credential reference digest, never secret value
new nonce/TURN/STEP/operation/work/attempt mappings
allowed mutation/restart/tool paths/cleanup scope; planned and consumed budgets
per oracle: action -> observation -> independent check -> result -> notProven
failures and first wrong owner; effect ambiguity; cleanup/recovery receipts
```

**本轮授权**以2026-09-19用户明确提出的新测试Bot、三模型两档、compact、Webhook和核心E2E为依据，结合已授权的协调Host/modeld切换。不要让清单本身变成授权，也不要把已给的权限每一步重新询问。维护者开始各窗口前登记资源与上限；超额、改变高影响对象或发布行为另行决定。

**建议初始预算，不是用户已经消耗或产品硬限额**：本轮最多5个自有测试Bot（主长会话/控制/接收者/空白状态目标/选定的官方duplicate目标），专用测试群1个；最多48次顶层测试任务（包含正常输入与Webhook，不含未知下的自动重试），其中6次以内Webhook、12次以内摘要维护。记录实际Provider调用和原生多步推理，顶层任务数不等于HTTP次数或token费用。正式发请求前按已能支持的max output/时间预算设限；无法机器硬限时记录not-enforced并在观察点停止，不以“自由使用”开启无上限循环。

**立即停止受影响lane**：身份/加载不匹配、涉及非测试对象、出现重复模型/工具副作用、未知写结果、费用上限、凭据泄露、数据不完整、无法保存退路。先保存首个错误边界与时间，之后只做已有授权的读回/对账。不要换nonce重发旧输入、切端点伪装通过、删账本/改Server ownership/手工补attestation；不可绕过工具安全拒绝。其他不依赖此故障的只读检查仍可继续。

## 3. W0/W1：先证明是同一套产品

- [ ] **源码与制品**：固定干净`feat/box-runtime-v2`和来源映射，完整测试文件清单无漏组；按来源要求完成review。文档-only提交不自动改变运行候选，但新构建若内嵌source摘要变化须说明。保留旧可执行包而非只有旧Git SHA。
- [ ] **安装包**：隔离前缀安装实际tarball，用Node声明最低版本和目标Box版本执行CLI、native SQLite/LevelDB及Skill。`grokbox`与`gbox`保持同义；离开源码目录仍可用，不依赖Bun/开发机绝对路径。其他已声明平台另跑其适用子集，不突然把Linux-only能力列为macOS门。
- [ ] **现役快照与退路**：确认当前shim指向、Host/profile/worker、modeld/daemon、根路径/alias和现役schema。备份必须可读且绑定本窗口；不把老PID或历史“active0”当屏障。未知业务操作不会因新部署消失。
- [ ] **协调采用**：只通过既有controller和明确迁移入口；停止相关writer后按精确计划迁移config3→4，models2无须重复迁移；匹配CLI/Host/modeld/daemon共同切入。查看每个实际消费者，不从CLI↔modeld wire一致推断Host↔modeld匹配。
- [ ] **基础使用**：init幂等、Profile/local/daemon/现有remote、doctor/能力、配置读写/验证/预览/revision冲突、版本与帮助输出；确认只读操作不暗中创建数据库、服务、凭据或发送消息。

这些操作不改变发布分支/tag/npm dist-tag。普通`on/off`与Host切换是不同能力；`host status/realign/logs`当前为保留入口，要验其正确指引而不是虚构实现。独立存储状态可以在配置坏时读取，不应为了取证先修好现场。

<a id="model-matrix"></a>
## 4. W2：一只Bot跑完三模型、六档与compact

### 建立可重复、不会靠猜测通过的样本

用`agents create --name <窗口名> --harness box --defer-start --nonce <新UUID>`创建主测试Bot。保存精确ID，查询`agents ownership`等待原生确认Box，不能只凭创建时请求的harness。控制Bot不参与任何assignment修改，用来检测串扰。`--defer-start`不保证阻断外来输入，CONT初始化需要其自己的准备屏障。

主Bot建立短小、合成的基准材料：窗口唯一标记、两项跨语言事实、一个需保留的文件路径别名、一次已完成工具回执。Memory通过实际原生能力只写合成事实；记忆/历史/文件三种观察要分开，不能让模型重复同一句话就当三种都持久。不要把用户真实业务文本塞进兼容性用例。

同一默认会话顺序：官方基线 → SOL high → SOL xhigh → Grok high → Grok xhigh → DeepSeek high → DeepSeek xhigh → 官方 → SOL high。每次切换检查控制Bot/main/default/catalog不变，不能为了过测清空历史或创建新的空会话。

### 六个模型格与证据结构

| LIVE ID | Provider/model（本轮用户提供） | effort | 必须单独留证 |
|---|---|---|---|
| LIVE-MODEL-SOL-HIGH | `sub2api-codex/gpt-5.6-sol` | `high` | chat/tool/emitted/compact/post-compact |
| LIVE-MODEL-SOL-XHIGH | `sub2api-codex/gpt-5.6-sol` | `xhigh` | 同通道高档，不借high结果 |
| LIVE-MODEL-GROK-HIGH | `sub2api-xai/grok-4.6` | `high` | 跨Provider工具/摘要历史 |
| LIVE-MODEL-GROK-XHIGH | `sub2api-xai/grok-4.6` | `xhigh` | 最终请求实际映射 |
| LIVE-MODEL-DEEPSEEK-HIGH | `sub2api-deepseek/deepseek-v4.1-flash` | `high` | 工具契约、终态与中文/Unicode |
| LIVE-MODEL-DEEPSEEK-XHIGH | `sub2api-deepseek/deepseek-v4.1-flash` | `xhigh` | 不静默降档或改端点 |

这是允许测试的目标，不代表当前可用或Provider已保证执行这些档位。记录实际API family/协议与安全凭据引用；相同model名但不同endpoint、adapter或配置视为不同覆盖。不要公开endpoint中的token或秘密query参数。

每格执行以下动作：

- [ ] **选择与对照**：`models use <provider/model> --for <agent-id> --effort <high或xhigh>`，随后`models show --for <agent-id>`。保存选择revision和控制Bot对照；不要误用`--agent`代`--for`。
- [ ] **新回合**：用新nonce发送包含合成标记的任务，检查中文/英文、稳定结构化结果、上一段历史。示例入口是`send <agent-id> --expect-kind agent --nonce <uuid> --text <合成任务>`，不是复用旧失败气泡。
- [ ] **实际工具**：要求只在批准测试目录执行一次唯一写入，再独立读回字节或hash；读写工具结果必须出现在原生会话，而不是只看到模型提出tool call。必要时后续工具输入验证上一输出，不把工具参数原文公开到报告。
- [ ] **effort链**：分别对照配置requested、该TURN captured、SDK/adapter编码和最终请求emitted；记录unsupported/映射而非补写默认。Provider若没有回报实际内部档位，reported=`not-observed`；不能凭token、速度、标题或回答自称推断。缺少最终wire安全见证时该oracle保持blocked，不抓全量敏感HTTP。
- [ ] **真compact**：先`agents context <agent-id>`读取已加载预算/状态；只在支持的安全点，以新operation ID运行`agents compact <agent-id> --operation-id <uuid> --confirm`。核对摘要请求、旧/新root、原生checkpoint、操作回读和一次提交。内容不足时no-op是有效防误触结果，但不是“该格compact成功”，可在预算内追加少量有意义合成历史再试。
- [ ] **压缩后继续**：全新nonce要求读取基准事实、上次工具回执和文件；独立检查上下文确实采用新root。结束前查看`history outcome`、原生history与App；配置保存、已发送一条回复、execution completed和实际持久提交分别留证。

下面是单格的**交互参考，不循环自动运行**：

```bash
grokbox models use sub2api-codex/gpt-5.6-sol --for <agent-id> --effort high
grokbox models show --for <agent-id>
grokbox send <agent-id> --expect-kind agent --nonce <new-uuid> --text <bounded-synthetic-task>
grokbox history outcome <agent-id> --nonce <same-uuid> --runtime --wait-for execution --wait-ms 120000 --json
grokbox agents context <agent-id> --json
grokbox agents compact <agent-id> --operation-id <new-operation-uuid> --confirm --json
grokbox agents context <agent-id> --operation-id <same-operation-uuid> --json
```

### 必须有的交叉反例

在有真实可观察的在途TURN时修改同通道effort，确认旧TURN保留原captured、下一TURN采用新值；不要靠长sleep冒充原生审批。省略effort或用default清覆盖、reset回官方也要验证下一TURN和标题/历史，没有残留上一Provider的reasoning字段。

手动compact、主动阈值维护、已确认overflow恢复是三种触发，不互相替代。主动路径优先用安全下调的已支持context策略或有意义的有限历史；恢复路径优先利用自然出现的错误，不能向生产端点无界填pad。不可安全触发的场景标ENV/ CODE缺口，保留已经完成的手动路径。

至少一个成功compact后通过正式modeld/Host换代，用新进程读取原生checkpoint、继续工具和历史，再回官方/回受管。读到相同答案但没有checkpoint消费者证据不够。旧unknown维护保留原operation，对新输入另用nonce；只在原协议允许时进行对账，不重复副作用。

## 5. W3：用户真正看见和使用的系统

原版App旅程必须由实际App输入、视图与同session/run对应。截取经过脱敏的关键画面或结构化App观察；后台投递不能代替Working/typing/发送队列/工具审批/标题展示。至少覆盖开始、增量、完成、错误、取消、断连重连，区分父回合结束与原生监听子任务结束。

群聊只使用本轮测试群/Bot，先单收件人或明确点名，避免多Bot无限对话。验证members增删set、线程和group-progress，不把原生SendToAgent的`target_id`写成不存在的接口。不同target解析、歧义名称与写权限拒绝都要有观察。

fs/Jobs用独立named root及真实Job句柄：文件大小/hash、越界拒绝、受管长任务、非零退出、取消/超时和日志截断。不得调用自造后台loop或按进程名批量kill。历史/Memory/export只包含测试内容；可见导出不等于允许公开。

真实503/限流可以证明错误分类与收束，不能证明成功响应或compact成功；另一个Provider的成功不能覆盖失败格。坏stream、伪凭据、硬崩和磁盘压力先在隔离实际服务/存储副本验证；业务环境不能通过破坏配置、删账本或断整机网络制造负例。

<a id="webhook-journey"></a>
## 6. W4：从disabled定义到自动新告警

选一个本轮接收Bot与一个默认alias，使用用户已授权的Provider。它不必是主长会话Bot，避免接收通知混入六格上下文。接收者模型/effort覆盖与聊天矩阵分开：本轮计划三Provider至少high，并选一个xhigh；剩余未试档位不能声称已验证Webhook。

- [ ] **定义**：`ops targets blueprint <alias>`取得禁用提醒定义，经受限文件输入到`agents routines apply`；保存provision operation/outcome、精确native ID。list/show确认disabled和prompt policy；原生创建省略enabled的默认行为不能替代grokbox明确disabled。
- [ ] **配对**：bind preview不领key；确认后绑定exact revision、安装scope与受管ID，key只在私有capsule内。verify来自同帧Host能力/下一原生automation选模；错误scope/模型/代际不得续鲜。修改Provider/effort后重新核对，不把普通聊天配置当自动任务实际选择。
- [ ] **启用与单条发送**：单独确认Routine enable；使用一条已固定、带清晰测试标识且允许外发的work。`ops notifications send`核对binding/model revision，只发程序生成的8KiB以内最小body。不要手工向events/SQLite插入伪原生证据；若源故障无法安全触发，该段保持blocked。
- [ ] **真正接收**：匹配POST、原生run、模型请求、最后提醒内容与精确incident/evidence revision。HTTP200单列；缺少可信report/用户视图时`not-observed`，不要把模型自报身份或成功当控制权威。
- [ ] **激活未来通知**：只有用户实际看到测试提醒并明确授权时，才填写activate的`--confirm-receiver`；不能由Agent根据200代签。activation只保存未来work权限，不启动collector、不启用Routine、不立刻发送、不补历史积压。
- [ ] **自动链**：已运行daemon持有sender，collector在已记录的scope与root生产一条新的受控异常；验证无需另一条send命令即可收到提醒。旧work、同work重入、off/未配对/预算耗尽不POST，不用真实重复Webhook碰撞生产端点测幂等。
- [ ] **撤销与换代**：disable/unbind阻止尚未发的任务；在途请求结果单列。Host重启会使已有资格失效时应保守停发并显示原因，重新资格流程单独留证。不要为求自动恢复而绕过代际检查。

已实现命令参考：

```bash
grokbox ops targets blueprint <alias> --json
grokbox agents routines apply <agent-id> --help
grokbox ops targets bind <alias> --help
grokbox ops targets verify <alias> --json
grokbox agents routines enable <agent-id> <routine-id> --expect-revision <revision> --confirm --json
grokbox ops notifications send <work-id> --expect-binding-revision <n> --expect-model-revision <sha256> --confirm --json
grokbox ops targets activate <alias> --from-work <accepted-work-id> --expect-binding-revision <n> --expect-model-revision <sha256> --operation-id <id> --confirm-receiver --confirm --json
grokbox ops notifications worker --json
grokbox ops notifications show <work-id> --json
```

bind/provision是可能创建原生资源的写入，不能在普通状态读取时隐式执行。unknown不换operation/alias/目标重投，保留attempt和实际连接结算证据。停止sender必须等待HTTP与本地写入结算；断网恢复不能自动补全部旧消息。

**提醒与自主性必须在同一个Bot上分开验**：普通告警只提醒后结束，无自动取证/诊断/Issue询问；之后用户明确要求“排查这个incident/将测试Bot换成指定模型”时，Bot应按权限自主完成常规步骤和结果核对，而不是永远只读。提醒prompt不是工具沙箱，不能仅审文本就签实际行为。

## 7. W5/W6：持续性与状态，不扩大到未实现功能

短链可显式运行受控collector；必须记录实际目标集合、runRoot/durableRoot、来源scope和owner。caller退出后仍运行、重启后接cursor、daemon/collector自启、Host自动重建后的采用各有独立oracle。source慢或不可用不能阻本地journal；source gap与quiet区分，通知失败不递归创建无限通知。

存储先观察三个实际维护周期、真实文件段回收和查询结果，再计划至少24小时的扩展窗口；“计划观察24小时”不是执行过。正文TTL可以借合法缩小配置做受控到期，不改系统时钟，不生产填满磁盘。显示主文件、索引、WAL/回滚journal、staging/backup、私有capsule和安全账本的可测范围；计量不等于全部强制配额。源日志过期后已有固定incident revision可读或明确降摘要；读操作不暗续租/清理。

并行已集成的`agents duplicate`单列为可选G3旅程，按[官方duplicate手册](native-agent-duplicate.md)先preview、再固定plan/scope/operation确认。它可能复制仍启用的Routine并改变App当前聊天，第一轮只选本测试源且源测试Routine已禁用；保留原生副作用和独立新ID/归属读回，未知不重试。复制不会完整恢复Memory/会话，不把它写成安静的prepared clone。`agents operations show`只读结果，不暗中重派发。

当前状态只对已实现的手动native-context切片执行：新空白测试目标、原生准备屏障、capture/initialize的持久operation与精确revision，实际activate只解除hold，第一/第二次输入使用本轮授权模型。参考[正式步骤](current-state-control.md)，不在此复制复杂命令。非空reset、完整Memory/历史导入、clone/关系迁移/退役都不是该切片隐含能力。源与目标均属本轮资源；不删除源来“证明脱离”而使退路不可用。

<a id="cleanup"></a>
## 8. W7：清理、回退与最终结论

- [ ] 先关闭本轮自动发送权限并读取最新binding版本；禁用测试Routine，列出仍在途的原生run、Job与子任务。无终态不删对象，等待预算耗尽写`cleanup_required`。
- [ ] 已接受消息/工具副作用不可回滚。回旧制品/配置时保存最新outbox、provision、unknown状态，不恢复一个可重新发送的旧数据库镜像。备份回滚防护未实现时只做隔离恢复用例，不签生产恢复安全。
- [ ] 对本次改动做精确对照恢复；不把整份最初配置盲写回去覆盖用户并行编辑。主Bot/default/其他Bot/catalog/凭据引用单独核对。业务Bot和业务群从未纳入自动清理范围。
- [ ] 按准确ID删除已终结的测试Routine/Bot/群/Job、释放本轮租约、处理owned临时导出；历史报告引用和必需安全标记保持。解绑只证明本地撤销，不声称远端key已撤销或磁盘安全擦除。
- [ ] 对照窗口前后的实际运行制品、关键配置与控制Bot，记录留下什么、为什么和谁负责；恢复到哪套制品必须明确，不能只写“已恢复”。
- [ ] 汇总每个选定LIVE oracle的实际结果、六格差异、费用/HTTP计数、未知/阻断/排除、缺陷归属与复验范围。G0/G1必须满足；若保留默认自动提醒/无人值守承诺，G2也是硬门。要缩小发布声明需维护者明确决定并同步README/Skill，不得事后为了过门偷偷改标准。

本次只输出候选资格结论与下一批最小修复，不自动push、打tag、发布npm、改变市场可见性或创建Issue。[npm发布程序](release.md#prepare-and-publish)仍是独立授权链。

## 9. 可复用的单场景回执

一个实际窗口一份`docs/reports/<日期>-live-<主题>.md`，同日多窗加窗口后缀，不能覆盖已关闭窗口。窗口内每个LIVE-ID一个稳定章节，每个子判据一条证据；模型六格分别记录，不为每个工具调用创建一份报告。下列是模板，不是执行结果。

```markdown
<a id="live-<feature>-<case>"></a>
### <LIVE-ID> / <windowId> / <model-cell>
候选：source -> v2 -> tarball -> 实际loaded；配置/原生版本与时间范围。
输入：新nonce/operation/work引用，测试对象角色，实际依赖，预算。
动作：正式产品入口、必要参数类别（无secret）、安全注入范围。

| 子判据ID | 动作与观察 | 独立核对及私有证据引用 | 结果/不可证明项 |
|---|---|---|---|
| <LIVE-ID>/01 | 实际发生的入口和状态 | run/STEP/operation、证据摘要/受控引用；不含凭据 | passed/failed/blocked/not-run；精确范围 |

局限：Provider reported、App可见、未知副作用等不能从其他层推断。
恢复：已完成操作、未结记录、cleanup_required、保留证据与下一动作。
关联：来源修复票、被影响LIVE IDs、独立回归测试、旧失败报告锚点。
承接证据：若复用旧窗口，逐项列原报告、适用性/失效检查和未重跑范围。
```

<a id="evidence-lifecycle"></a>
## 10. 证据、阻断与完成勾选如何流转

| 内容 | 唯一落点 | LIVE入口保留什么 |
|---|---|---|
| 测试旅程和逐点事实，包括失败/中断 | `docs/reports/<日期>-live-<主题>.md#<稳定锚点>`；窗口关闭后固定 | 当前结果、候选/窗口、限定范围和一个证据入口 |
| 源码缺陷、缺实现、独立review与修复计划 | 复用`docs/tickets/`对应来源票；确有独立问题才新增FIX票，回链失败报告 | CODE/REVIEW、一句具体影响与下一动作、来源票链接 |
| 环境、权限、预算、工具或依赖阻断 | 当次报告记录观察时间、失败入口、已产生副作用、不能证明项、解除条件及责任方；不为暂时环境问题制造空实现票 | ENV/AUTH/BUDGET/TOOL/DEP、一句影响与下一动作、报告锚点 |
| 原始JSON、日志、截图、请求与私有配置 | 窗口开始时指定的受控私有证据目录，记录来源、摘要/hash、访问范围和保留期限；临时`.scratch`不是唯一长期凭据 | 不附原文、不暴露私有路径/密钥；只链接已脱敏报告 |

有问题时先保全现场：报告写“当时发生了什么”，来源票写“现在如何修复”，LIVE行写“当前阻塞哪个判据、下一步是什么”。只暂停受影响范围；另外的子判据可以有证据，但整行必需项未齐就不勾。代码修复完成后仍为待现场复验，不直接改成passed；非代码阻断解除也只是重新具备执行条件。

复验通过后，在新窗口报告写新结果并回链原失败、修复commit和回归证据；旧报告不删错、不将失败改写为成功。LIVE同一行换成`[x]`与`passed`、限定候选/范围及新证据锚点，移除已解除阻断的叙述，不堆“第一次失败→修复→第二次失败→通过”的流水账。

一个证据章节可以汇总多个必要窗口，但必须逐判据标明复用关系；LIVE不累计挂所有旧报告链接。相关实现/配置/原生版本变化使旧覆盖失效时，只取消受影响项的勾并标`needs-revalidation`；旧成功仍是原窗口事实。已完成场景留在原行供回归，不再复制到第二张完成表。

后续报告在现有`docs/reports/README.md`按需登记为档案目录，不复制当前待办。LIVE当前候选摘要与证据链接采用替换更新；历史窗口不会每跑一次就在入口新增一节。新worktree沿同一LIVE追加模板登记新义务，不新建自己的长期live-todo文件。
