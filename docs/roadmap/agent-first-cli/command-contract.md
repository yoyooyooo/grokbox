# CLI 统一命令合同

状态：已确认的架构与业务语义已写入；具体语法、参数和协议仍为候选，不是已实现的命令帮助。已接受方向与未决项见[决策清单](decisions.md)，实际命令以源码 registry 为准。

完整命令树在[命令目录](command-catalog.md)，旧命令去向在[迁移映射](migration-map.md)。下列语法和枚举是本轮推荐方案，须经合同票收口。

## 1. 产品目标和使用者

grokbox 为原生 Grok Bot 提供受控管理、自定义模型执行、持续观察、信息检索、数据修改与恢复能力。它保留官方 Host/Server 的原生权威；Bot 的创建组织、业务分工与任务编排策略留给调用者，不新增通用任务/DAG 调度或第二 Agent loop。保护与交接是后台明确承担的产品责任，实际推进范围受证据与已验证能力约束。Web UI 以观察和必要管理为主，无 Bot 对话入口。

主要调用者：

- Box 内原生 Bot，通过实际授予的 grokbox 能力管理自己或授权目标。
- 代表用户执行工作的 Agent，通过本机或明确配置的受控入口工作。
- 人可以直接使用相同命令；默认交互和输出按机器消费设计。

成功标准：调用者可以发现能力、准确绑定对象、提交一次操作、判断实际结果、在断连后继续查询，并对未知结果执行正确的对账。常规工作不要求调用者理解内部 worker、数据库路径、Host recipe、运行 epoch 或手动推进工作流阶段。

主要工作面仍然是单 Box。已有可工作的外部能力按其真实范围保留；网络安装、路由、Tailscale 和公网访问由操作者管理。

### 1.1 统一后台与独立寿命

一个常驻管理服务承载采集、证据、索引、管理异常、保护、交接与通知；内部模块/worker 保持独立的故障与资源边界。普通 CLI/Web 业务调用同一套后台用例，无页面或客户端在线时仍可推进已接受的管理工作。

modeld 保持独立进程。管理服务重启不主动终止已经开始的合法执行；新工作仍核验当前资格。官方 Host 继续执行原生 Bot。TanStack Start SSR 仅预取/渲染，业务 API 在独立的 Effect v4 beta、Effect-first 服务中。

bootstrap/生命周期、离线诊断和外部 Box 唤醒/恢复保留明确例外，不使用隐式直连业务 fallback。CLI/Web 通过共享合同与客户端调用领域用例，Web 不执行 CLI 子进程。包划分、存储和路由由实施者按[重建骨架](implementation-impact.md)决定，整体交付包括真实 Web UI。

## 2. 命令语言

### 2.1 唯一规范入口

格式为 grokbox <单数对象> [<子对象>] <动作> [<对象引用>] [声明的选项]。gbox 保持完全等价的 binary alias，不维护第二语法。

固定动作：

| 动作 | 含义 |
| --- | --- |
| list | 有界集合查询；返回分页信息和覆盖范围 |
| get | 读取一个对象或一个明确视图；不初始化、修复或启动服务 |
| resolve | 将名称/标题解析为明确对象引用；歧义列候选，不择一执行 |
| create | 创建新身份或资源，不自动推导启用/启动 |
| update | 已有对象的部分属性变更 |
| set | 精确设置某个关系或选择 |
| reset | 清除该域的覆盖或重置该域对象；具体影响由命令合同定义 |
| apply | 应用严格结构化声明；必须明确 patch/replace，未列出的资源不隐式删除 |
| delete | 删除或退役目标；文件默认可恢复 trash，具体影响必须明确 |
| wait | 等待产品定义的条件；不执行重试、修复或取消工作 |
| watch | 消费有界事件流；不拥有被观察任务的寿命 |
| reconcile | 从现有回执与实际状态对账；不重发结果未知的写操作 |
| resume | 继续可安全推进且仍获授权的原操作；不重新创建一个操作 |

不提供 show/get、start/up、stop/down、on/enable 等同义正式入口。取消顶层 up/down/on/off、is running、裸 send、exec 与 jobs 的分裂。只保留有独立业务含义的动作，例如 clone、replace、compact、wake、publish。

没有统一的 raw、任意 RPC、SQL、任意条件表达式或任意修复命令。命令从静态可信 registry 产生，不让远端数据注册可执行行为。

### 2.2 对象引用与身份

读写执行绑定稳定的对象引用，不依赖全局“当前 Bot/当前连接”。列表与结果返回可直接复用的 ref。Bot 原生 UUID 可作为本机目标输入，内部规范化为包含安装/账号范围的引用。

名称搜索通过 bot resolve 或 group list 的明确筛选完成。写命令要求已解析 ID/ref；即便名称唯一，也不在写入时重新按名称寻找对象。

self 只在有可信 Bot 运行上下文绑定时解析。环境变量、工作目录、传入名称和任意 --actor 字符串都不是身份依据。无绑定时返回 caller_identity_unavailable。单 UID 共享 shell 并不构成进程级安全隔离，不能仅凭 ref 或标签宣称防冒充。

替换产生新物理 Bot。主要对象仍为真实 A/B Bot，只增加保护记录、恢复材料、前后继关联和交接进度，不建立独立跨工具人格或 Memory 身份层。旧 UUID/ref 不自动重定向到继任 Bot；查询可以返回 successorRef，写入需明确选择新的目标。执行历史继续保留原 Bot、原模型和原运行代。

installation/account scope、Bot、Group、run、message、operation、job、snapshot、incident、event cursor 和配置 revision 使用不同类型。一个字符串看起来相似不代表可以互换。

### 2.3 输入

每个 leaf 有一份严格 Input Schema。常用标量可由 flag 输入，结构化输入统一用 --input @request.json 或 --input -。两种形式映射同一 Schema；重复提供同一语义字段直接拒绝，不用优先级猜测。

正文、大段指令、argv/env 和集合变更优先使用文件或显式 stdin。不要依据 TTY 判断“是不是该读 stdin”。JSON 拒绝未知键、重复键、不正确的 null、超深和超大数据。省略、清空、null 的含义分别定义。命令不支持的 flag 在产生业务副作用前拒绝。

配置中的凭据使用 secret reference；不接受明文 token 出现在 argv，也不把凭据或正文回显进错误。model credential import 从明确授权的来源读取；输出只含脱敏引用元数据。

### 2.4 通用选项族

选项仅出现在适用命令中，不把所有 flag 无差别加到每个 leaf。

| 选项 | 使用范围与含义 |
| --- | --- |
| --connection <name> | 显式选择已有连接；默认固定为本机；不写全局选择 |
| --input @file / --input - | 输入命令 Schema 的 JSON |
| --request-id <uuid> | 提交有副作用的操作时由调用者提供，重试必须复用 |
| --expect-revision <revision> | 该资源或该域的并发前置条件；不是全局事件序号 |
| --preview | 生成可审阅计划，不执行业务变更；可能保存短期准备记录 |
| --confirm-plan <plan-ref> | 在原领域命令上执行该精确计划；仍检查当前授权和前置条件 |
| --timeout-ms <n> | 单次客户端请求预算；不等于远端执行期限 |
| --wait-ms <n> | 本次等待/跟随的总观察窗口；默认有限 |
| --until <enum> | 该命令声明的可证明条件；不接受任意表达式 |
| --limit / --cursor | 有界分页；cursor 不透明并绑定查询范围 |
| --view <enum> | 固定、脱敏、受授权约束的投影视图 |
| --max-age-ms <n> | 接受的观察年龄；不满足时返回 stale/gap |
| 显式刷新 | 使用 system observation refresh；其作用域与预算明确，普通 get 不隐式启动采集 |
| --format json / table | 默认 JSON；table 是同一结果的人读投影 |

普通领域提交必须带 request-id。前台 system service run 和 box keepalive run 是明确的进程寿命入口，通过其启动者与单实例合同管理，不套成无限存活的查询或隐式业务操作。

不要为所有命令添加 --force 或通用 --yes。低影响且已有授权的变更可以直接提交；需要审阅的高影响变更使用 --preview/--confirm-plan。Agent 持有明确授权时无需额外的人机问答。

## 4. 需要明确固定的业务含义

### 4.1 Bot 创建和复制

create 建立原生身份，不等于已经开始工作。duplicate 保留官方复制含义，包括可能继承的 Routine 风险。clone 是按明确材料与初始化策略创建副本，默认准备完成而不激活。replace 创建继任身份并管理交接，目标可用不等于旧 Bot 可以删除。spawn 建立带初始指令的真实 Bot 并请求启动，启动预算不等于任务完成或有保证的到期销毁。

这些动作的差异在合同和结果中明确表达，不能为了减少动词而全部塞进 create 的几十个隐式开关。

所有确认 Box-owned 的 Bot 默认开启观察和恢复材料保全，可逐 Bot 调整/关闭；不限定由 grokbox 创建，也无需登记一种新的伙伴身份。确认官方所有权丢失后，后台按有效策略负责重建与交接；超时、失联和陈旧观察只能说明观察问题，不能独自作为替换依据。

保护、交接和已接受生命周期操作的可验证阶段由服务推进，调用者查看 operation 或 handover，不轮询 advance。自动化上限取决于证据与原生能力：优先可靠 checkpoint；只有降级路径可验证时才利用 Memory/历史摘要恢复可用性，并明确缺失内容。真实可继续的工作与不确定的外部效果分开，不能盲目重放。

程序推进可明确验证的步骤并核对结果；Bot 可以辅助语义判断和交接，但判断不替代执行回执。缺关键材料、能力、授权或存在未知效果时，相应部分保持 blocked/unknown/未完成；独立且有依据的部分可继续。新目标可用、关系已交接、旧目标可退役是不同事实。解除阻断后也须重新核验安全推进条件。

self reset、self replace、self restart 等涉及调用者自身寿命的操作，需要“持久接受→原回合退出/移交→独立 owner 执行”的合同。没有可靠原生屏障时返回 unsupported/blocked，不能让 Bot 在等待自己的结束时死锁。

### 4.2 消息、运行和操作

message 是原生消息与投递观察。run 是实际能关联的 Bot 执行。operation 是 grokbox 接受的一次管理/提交操作。job 是 OS 进程任务。四者各有身份、寿命和结果。

现有 sendPrompt 创建 Human 输入。message send 保留并披露这个语义：实际调用者 actor 与原生 message role 分开记录。不给调用者一个任意 --from bot 参数。需要原生 Bot-to-Bot 发信时应使用真实 peer 通道；只有新增且核验过的原生能力才可进一步开放，不在本提案中虚构。

消息投递成功、观察到回复、一个 STEP 结束、父运行结束、所有子工作结束是不同事实。message delivery wait 只等待它声明的回执条件。run wait 的每个完成条件都必须有原生事件/执行记录支持；缺少全链路终结回执时，不开放 execution-settled 条件或明确返回该条件 unsupported。绝不拿 idle、最后一条回复或超时作为成功替代。

不提供通用 run start/retry/resume 来重建官方 Agent loop。执行从已有的 message、Routine、spawn 等合法入口开始。run cancel 只能在有精确原生范围能力时存在；没有 run 级取消时，不能暗中扩大为整个 Bot 中断。

同一 Bot 的 isRunning=false 只能满足明确命名的“观察到当前未运行”条件。它不能满足“某次提交成功”条件；等待条件必须绑定真实 submission/run 身份，不能用 Bot 级状态替代。

新观察服务只保存可证明的关联，不靠文本相似、相邻时间或同一个 Bot 拼出完整 run。历史不全时保留 source ref 与 gap。

### 4.3 Memory、Project 与文件

全局表示当前安装已授权、已接入的数据源集合。agent/user/project scope 分开，Temporal 的共享 Memory 可能经同步获得并有延迟；不承诺全账号所有云端私有数据。

读取正文使用 memory get 等明确入口；metadata/list 和 event 默认不含正文。跨 Memory/Project 文件检索属于正式目标，搜索结果返回来源和原位置，并声明索引新鲜度与缺失来源；搜索索引可重建，不接管原内容。内容相同的记录仍保留各自来源，不用内容 hash 跨 scope 合并身份。存储中存在不等于已注入某次 TURN。

Project 是原生 Project 对象。成员、Project Memory 和普通项目文件分别表达，文件通过 fileRef 关联统一 file 能力。Memory、Project 和文件的读取与修改均在已接受范围；具体写动作、字段与并发条件逐源核实。只有明确写入路径、事实 owner 和结果核验后才开放修改，缺能力的来源保持只读，不机械补齐全套 CRUD。不能直写索引或缓存后宣称源内容已更新，也不能借通用 file write 绕过同一源的写入边界。

snapshot 私有材料与普通 bot export 不同。导出只包含声明且获授权的范围，默认不打包整套原生数据库、凭据或全局账号配置。

### 4.4 模型和配置

Bot 模型选择区分三种关系：原生模型、跟随 grokbox 默认模型、指定 modelRef。“跟随默认”不是虚构的模型条目；显式指定的 modelRef 即使等于当前默认值也不会转成跟随。只有明确跟随者受默认模型切换影响；未选择 grokbox 模型管理的 Bot 保持原生行为。这些选项用于支持模型接管的 Box-owned Bot，不限定创建来源。

指定 modelRef 跟随该模型自身的集中配置更新，作用于后续轮次。每轮记录实际采用的配置版本；普通更新不改写在途 TURN 的 captured 事实。凭据撤销等真实权限变化不能被配置捕获绕过。在用模型和默认设置先解除引用再删除/清空：拒绝删除仍被 Bot 选择或全局默认引用的模型；仍有跟随者时拒绝清除默认，并返回有界的引用信息。没有默认配置时，选择跟随默认返回明确的配置缺失，不静默切回原生或其他模型。历史执行记录及捕获事实保留。具体选择 Schema、并发引用检查和错误表达由 D01/D05 细化。

bot model set/reset、model default set/reset、model apply、system config apply 是候选表达，均调用各自权威用例；bot model reset 回原生与清除全局默认是不同意图。generic config 不能绕过模型选择、通知授权、harness 不可变和敏感凭据边界。受专门领域管理的字段要么路由到同一用例并履行同样前置条件，要么拒绝直接改写。

配置 committed、configured-next-turn、TURN captured、consumer applied 和实际 running 分开。无需等待业务事实发生才能报告“配置已提交”，也不能提前报告“在途运行已采用”。

model check 为无推理的静态检查。model probe 是明确有副作用且可能有费用的有界请求，检查能力与结果不能被包装成纯读。默认模型不让所有 Bot 自动 opt-in。

### 4.5 异常和通知

后台根据有依据的规则主动识别并持续跟踪所有权变化、保护交接受阻、模型执行故障、观察中断等管理异常，保存发生、变化和恢复记录。规则围绕 grokbox 的基础能力，不接管 Bot 业务任务的完成判断。alert 是原生告警观察，可以消失；incident 是持久的 occurrence/condition；通知是针对某次发生周期的 work 和 attempt，三个对象各自呈现。

incident ack 仅确认看过，snooze 仅抑制一段时间的提醒。condition 的恢复由有来源的规则判定，不能让任意 resolve 按钮伪造修复。缺记录不等于健康，告警消失不证明成功。

配置接收目标并显式启用通知后，后台负责符合条件的持续投递、去重、有限重试和投递记录，不依赖外部 Agent 或页面在线。receiver bind、原生 Routine enable、自动投递 enable、实际测试接收分别持有事实与授权。receiver verify 不发送消息；notification send 发送明确 work。测试使用独立、显式的 receiver test 候选入口，向已配置目标发送固定的测试内容并形成测试 work/attempt，不伪造 incident。测试可选；完成必要配置和授权即可显式启用，不要求先测试成功或人工确认接收。启用状态、测试结果、上游受理和实际投递分别记录；verify 保持不发送。具体输入、固定内容及回执由 R03/CLI-04 收口。

未知投递不因重试策略而再次发送；变更接收者不能绕过同一 work 的 unknown。通知关闭不丢 incident，也不停止必要的观察和维护。

### 4.6 安装、服务和外部机器

system service 管理 grokbox 的 server/modeld/web 进程。system host 管理官方 Host。system integration 管理 Host 对 grokbox 的采用。bot model 管理单 Bot 的模型选择。四者不可混同。

system init 显式初始化本安装；只读 get/check 不建库、不迁移。system recover 只执行已经明确范围的恢复计划，不自动清锁、清熔断、切身份或重放任务。

system service restart modeld 必须调用模型执行服务自身的 drain、身份和替换合同；不能退化成普通 kill/spawn。server 的启停也不能意外终止 Host/modeld 或将不确定的 Job 重建一遍。system service stop server 的回执由本机生命周期 owner 管理，不能依赖被停止的 API 返回最后一个字节。

connection 是客户端连接描述，默认本机，不设共享 currentConnection。远程连接失败不回退到本机高权限路径。已有可工作的远程意图迁移到新合同；普通业务统一走管理服务，原生 Gateway 访问属于服务适配职责。bootstrap、离线诊断和外部 Box 控制等明确例外按自身合同运行。旧直连语法不因历史存在获得对外兼容期，也不成为隐式业务 fallback。

外部 box 控制是服务优先原则的明确例外：冻结的 Box 无法自我唤醒。外部 keeper 使用同一个 grokbox executable 的专门寿命入口和独立凭据。它不是全量远程 runtime，也不引入网络产品专属管理。

## 5. 统一操作合同

### 5.1 提交与幂等

有副作用的提交由调用者持久保存 request-id。幂等键绑定 installation、真实 principal 和 request-id；规范化指纹同时绑定 command、目标、输入与语义版本。同一键不同语义返回 idempotency_conflict。等待窗口、输出格式等传输选项不改变业务指纹。

服务先持久声明操作，再实施需要声明的副作用。相同键再次提交返回同一 operation，不再次执行已接受的动作。上游无去重能力时，在发送后丢失回执可能只能进入 unknown。request-id 提供本系统对账能力，不创造全局 exactly-once。

回执至少包含 operationRef、requestId、command、boundTargets、state、resultRefs、观察/证据版本和允许的后续动作。普通写完成得很快也提供可恢复的提交回执；持久期限由该动作重试/迟到范围决定，不能无界保留所有正文。

旧安全记录只有在旧请求已经被拒绝、scope/epoch 不可再准入后才允许收缩或淘汰。过期请求返回 request_expired，不能当成新请求执行。

### 5.2 操作状态

| 状态 | 含义 |
| --- | --- |
| accepted | 已持久接受；尚未开始或在队列中 |
| running | 正在执行原程序 |
| blocked | 有明确前置条件/授权阻断；返回结构化原因 |
| succeeded | 该操作定义的成功后置条件已有证据 |
| failed | 操作失败已结算；已发生的部分副作用仍记录在步骤回执中 |
| cancelled | owner 已确认取消的范围；不能仅由客户端取消请求推导 |
| unknown | 至少一个关键外部效果无法确认；不视为可安全重试 |

preview plan 单独为 plan，不把预览伪装成 accepted 操作。state 之外的 steps/coverage 描述局部完成与缺口；不以一个笼统 success 丢失跨阶段事实。

operation get/wait/events 是读面。reconcile 可以联网观察并提交对账结果，但不重发未知动作。resume 是新的显式控制动作，继续同一个已保存工作流。cancel 也是有回执的控制动作，并说明支持范围；不能承诺撤销已经完成的工具副作用。

统一 operation 是公共索引、路由和状态协议。CONT、配置、文件、通知、执行等各领域继续拥有自己的关键提交和恢复账本，不迁成一张万能 operations 表。索引可按 durable 引用恢复；无法及时索引的已发生副作用不能消失。

配置提交成功后，实际采用可以在未来发生。operation 的终态保持不变，后续 adoption 是关联回执。等待条件由该命令 descriptor 明确列出，不能为了等下一 TURN 而让已成功的配置提交重新进入 running。

### 5.3 计划与授权

高影响命令 --preview 返回 planRef/digest、目标身份、前置 revision、预期副作用、费用/中断类别、可恢复范围、到期时间和缺失授权。执行仍通过原领域命令携带 --confirm-plan；不存在任意 operation execute。

plan 不签署权限。提交时重新核验授权、目标、Host/服务运行代和有关 revision。授权从真实调用通道与受控 grant 得到，不能来自用户可编辑的结果 JSON、模型结论或 actor 参数。

本地锁与本地 revision 不能替代原生 CAS。每个写能力声明 concurrency 为 native_cas、local_serialized 或 best_effort_readback，并明确外部 App 并发窗口；需要强保证的操作在缺能力时阻断。

## 6. 输出、错误、等待与流

### 6.1 有限 JSON

默认 stdout 是一个 JSON envelope；不混杂进度文本、日志和提示词。stderr 仅作有界脱敏诊断，程序判断依赖结构化结果。可选表格不改变执行行为。

```json
{
  "schemaVersion": "1",
  "command": "bot.model.set",
  "invocationId": "invocation-example",
  "ok": true,
  "scope": { "installationRef": "installation-example" },
  "data": {
    "operationRef": "operation-example",
    "state": "succeeded",
    "result": {
      "botRef": "bot-example",
      "configRevision": "revision-example",
      "effectiveWhen": "next-turn"
    }
  },
  "meta": { "truncated": false }
}
```

所有示例引用为示意值，非可执行的真实身份。只读查询可以 ok=true 且 data.state=failed，因为查到了一个失败操作。命令目标、操作结果和系统健康不共用一个布尔值。

读面 metadata 按需包括 source、sourceObservedAt、receivedAt、age、coverage、snapshotCursor、nextCursor 和 truncation。查询时间不能刷新旧事实。正文与诊断仅在明确视图和权限下返回。

错误含稳定 code、有限 details、是否已产生副作用、operation/request 引用、retry 指引和结构化 nextActions。nextActions 使用 command ID + 经校验参数，不把自由文本拼成 shell。

### 6.2 退出码目标合同

| 退出码 | 含义 |
| --- | --- |
| 0 | 本命令声明的目标达到；get 成功不证明被查询对象健康 |
| 2 | 输入/Schema/选项不合法 |
| 3 | 认证或授权不足 |
| 4 | 对象不存在 |
| 5 | revision、身份、计划或其他前置条件冲突 |
| 6 | 能力或等待条件不支持 |
| 7 | 服务或必要来源不可用 |
| 8 | 关键操作效果未知，需对账 |
| 9 | 操作已失败/取消，所要求的成功条件不可能达到 |
| 124 | 等待窗口结束，未观察到所要求的条件 |
| 130 | 调用者中断当前客户端等待或跟随 |

具体领域 code 比退出码更精确。不存在“失败一律 exit 1 再猜文字”。operation wait --until terminal 可以成功返回一个 failed 终态；--until succeeded 在已知 failed 时返回 9。timeout/中断仍尽可能输出最后回执和恢复 cursor，不取消被观察的操作。

### 6.3 观察和执行期限

--timeout-ms、--wait-ms、任务执行期限分开。任务执行期限只有在对应 owner 能执行约束时才出现，例如 job 的 process deadline；不能把 Bot 启动等待预算称为任务硬截止。

默认响应有界：集合分页、日志字节上限、证据固定视图、正文显式读取。没有无限 --all 或把全库灌入 Agent 上下文的默认输出。过滤器是固定 Schema，例如 bot、state、time range；不用 SQL/jq/任意程序作为服务端查询语言。

mutating command 可按声明支持 --until/--wait-ms，其语义等价于提交一次后观察该回执，不重发业务命令。客户端断开后，已接受操作和后台采集继续由其 owner 管理。

### 6.4 事件合同

后台持久保存必要的状态快照、变化记录和来源证据，不只做代理与短暂缓存。event list 是历史查询，event watch 是实时接续；精确协议和保留策略仍为候选。bot list/get 等只读快照可以返回作用域绑定的 snapshotCursor，随后 watch 从同一边界接续。服务侧快照与本地序列具有一致性，不因此声称所有上游在同一瞬间原子采样。

NDJSON 帧类型为 event、gap、end。帧保留 eventId、source、sourceGeneration、scope、sequence、occurredAt/observedAt 与 schemaVersion。heartbeat 只维持传输，不当业务进展，也不持续向 Agent 刷屏。

cursor 绑定安装、stream generation、过滤范围和保留窗口。重复可去重，缺口不可静默跳过；超保留期、重启或来源断线返回 gap 和重新获取快照的明确动作。慢消费者的队列有界，溢出报告 gap，不无限占内存。

Gateway 原生缺 replay 时只能校准当前快照；本服务的持久事件不能补造没接收到的历史。身份变化、源陈旧、未知 schema、文件监听漏报等都保留 coverage。

## 8. 典型 Agent 旅程

以下用例是合同检查，尚未实施新 CLI 或运行真实任务。

### 8.1 不认识系统的 Agent 读取 Bot

1. describe 获取精简索引，按需 describe bot get 读取具体输入/输出合同。
2. system identity get 了解真实调用身份与 scope；capability get 核对所需能力。
3. bot resolve 找到精确 Bot ref。
4. bot get --view activity 获得状态、来源、时间与 snapshotCursor。
5. event watch 从该 cursor 继续；遇 gap 重新取快照。

不需要学习 daemon/monitor/modeld 的全部实现。

### 8.2 更改未来模型，处理丢失回执

1. bot model get 读取当前选择、revision 和在途 TURN 的 captured 模型。
2. bot model set 明确选择跟随默认或指定 modelRef，连同 revision、调用者保存的 request-id 提交；回原生走相应明确动作，具体输入形式待定。
3. 响应丢失后，operation get --request-id 找回同一操作。
4. operation wait 观察 configured；如需要观察实际采用，使用明确 supported 条件并保留等待时限。
5. 在途 TURN 仍使用旧模型时，输出 configured-next-turn，不伪造 applied。
6. 验证默认从 M 切换为 N 只影响跟随者，显式指定 M 者保持 M；更新 M 自身配置时，其使用者后续轮次采用新配置版本。

### 8.3 向现有 Bot 提交输入并等回复

1. message send 明确原生 Human 角色和真实调用 actor，提交一次并保存 submissionRef。
2. message delivery wait --until response-observed 观察相关回执。
3. 如确有可关联且支持终结观察的 run，再 run wait 等待相应执行条件。
4. timeout 继续原 submission/run；不换 request-id 重发正文。

Web UI 不因此增加聊天 composer。

### 8.4 确认归属丢失并准备继任

1. 确认 Box-owned 后，默认观察与材料保全持续运行；逐 Bot 排除或修改策略独立记录。
2. 后台从合格来源确认官方所有权丢失，形成 incident；观察间断本身不算回收。
3. 后台依据当前策略、可靠材料与已验证能力准备并推进替换，不要求外部 Agent 常驻批准每个确定性阶段。
4. 真实 checkpoint 或有依据的降级恢复分别披露覆盖；可独立完成部分继续，缺证部分保留阻塞。Bot 可辅助交接理解，实际效果由回执验证。
5. 外部 Agent 可查看、调整策略或处理明确例外；需要手动 replace 时，候选 preview 展示材料、未知效果和关系影响。
6. operation 与 handover 分别显示目标可用、关系迁移和旧身份可退役条件，不把旧 ref 改指新身份，不用时间到期替代退役证明。

### 8.5 管理服务故障

1. system check 从明确的本机离线诊断路径读取安装/进程/日志证据。
2. system service start/restart 由本机生命周期 owner 执行。
3. modeld 不因 Web/管理服务重启被重复创建或切换模型。
4. 若 Box 冻结，外部 Agent 使用独立授权的 box wake/recover。
5. 恢复后 collector 继续游标或报告 gap；未知业务操作仍按原身份对账。

### 8.6 检索并修改源材料

1. 从已授权来源搜索 Memory 或 Project 文件，返回 scope、来源位置、新鲜度和缺口。
2. 显式读取正文，按来源能力选择相应修改入口；仅可读来源明确不支持写入。
3. CLI/Web 提交同一领域用例，绑定原内容 revision/hash 与实际支持的并发合同。
4. 核验源数据修改结果；索引未追上时披露索引延迟，不能以搜索命中代替写入回执。

### 8.7 管理异常与自动通知

1. 后台记录有证据的异常发生与变化，CLI/Web 读取同一记录。
2. 调用者完成必要配置/授权后显式启用；可独立执行测试投递，不要求先通过测试或制造真实故障。测试未执行/未通过与启用状态分别返回。
3. 后台在无人打开页面时继续投递、去重和有限重试，未知投递先对账。
4. ack/snooze 只改变处理或提醒状态；恢复由事实核验，通知已送达不表示异常已解决。

## 9. 验收标准

命令重组的验收必须覆盖：

- 直接切换新命令，旧语法无对外兼容期；仓内与已知调用方同步迁移，旧 writer 退出。按意图、参数分支与结果验证，不能因整理目录丢失必要能力、配置、回执或恢复材料。
- command descriptor 派生的一致性、未知字段拒绝、无 TTY 语义分叉、版本不兼容错误。
- describe 按日常 Bot、操作 Agent、维护者视图渐进展开；视图只减少发现噪声，不授予权限。默认不输出完整命令树或全部 Schema，完整静态合同仍可逐项发现。
- 写前记录、同键重试、同键不同输入、回执丢失、进程重启、晚到结果、记录回收后的旧请求拒绝。
- CLI 与 Web 同时修改同一资源，跨 App 的原生并发限制如实披露。
- query/get 无业务写入，显式 observation refresh 合并预算，collector 在无页面时继续运行。
- operation、run、message、job 的等待条件和中断语义分别测试。
- source 断线、缺 replay、stale、gap、历史截断、未知 schema、慢消费者和磁盘压力。
- caller self 身份、Bot actor 与 Human message role 分离、名字歧义、旧身份不隐式重定向。
- server/modeld/SSR 独立退出；self maintenance 不死锁；不创建两个 collector 或账本 writer。
- 新 CLI/API 的实际程序通过同一 Effect 组合与可替换外部能力测试；包装 JSON 或重命名测试不等于架构完成。
- packed Node、真实 Gateway/Host、真实 UI 和长期运行分别证明；命令注册与离线测试不代替现场资格。

本文描述未来验收，不将本轮文档落盘视作实现或 live 验收。
