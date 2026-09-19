# grokbox 产品合同

本页拥有用户可观察的语义、权限和非目标。当前命令及参数以 [registry](../packages/cli/src/registry.ts)、help 和可执行测试为准；精确配置以 [schema](../packages/runtime-kernel/src/internal/config/schema.ts) 为准。正文不维护第二份命令树、实现进度或现场结果。尚未交付的接受目标在对应专题中明确区分，不能当作现有命令。

## 1. 产品定位

`grokbox` 是 Grok Bot 云电脑的非官方 CLI 与控制面，`gbox` 是完全等价的 binary alias。主要工作面是单 Box 内的 CLI/runtime；已有外部连接和生命周期能力保留其实际支持范围，不承诺所有命令在云电脑内外等价可用。网络安装、连通性和访问策略由用户管理，不把网络产品变成模型运行时的一部分。

发布的 Node 版本、依赖和 executable 由 [package.json](../package.json) 及安装包测试拥有。Bun 是仓库开发工具，不是最终用户运行 CLI 的必要条件。低于支持版本时，Node shim 在加载 bundle 前返回 `runtime_unsupported`，不能先发生运行时副作用。

正常 Bot、群、消息与原生状态由 Gateway/Host 操作。daemon 提供受控文件、进程和远程 RPC；Sandbox 是独立的外部机器生命周期面；quota 使用独立显式来源。Box-local 模型执行不经 Profile/SSH/generic exec 远程转发。

## 2. 默认入口与连接

无配置时存在逻辑 `default` Profile；只读发现可合成默认值，不创建文件。Profile 选择依次为显式 `--profile`、`GROKBOX_PROFILE`、`client.currentProfile`、`default`。不存在、歧义、错误类型和不支持的 capability 均明确失败，不悄悄换身份或目标。

`init` 是幂等连接初始化，不是项目生成器；显式参数及其是否已实现由 help 决定。初始化、bootstrap、daemon 启动与 Host 通道切换不是同一个动作。任何安装、凭据轮换、访问扩权和 endpoint 修改都必须保留无关配置，执行范围由相应命令的确认与策略决定。已存在的远程/peer 适配不意味着自动安装网络软件、登录、改 ACL 或开放公网。

`--profile` 只选择已有 Profile；`init` 和 Profile 管理用各自位置参数命名对象，不赋予同一 flag 两种含义。读操作和 doctor 不启动服务、不唤醒机器、不领新凭据。

## 3. 命令与目标解析

唯一完整命令面来自 [registry](../packages/cli/src/registry.ts)。日用入口包括 on/off/upgrade、host、models、agents、groups、send、history、config 和 ops；维护入口中的 runtime/daemon/profile 工具仍是正式的已注册接口，不再称为“临时实现、文档不可提及”。[operator Skill](../skills/grokbox/SKILL.md)按能力展示所需子集。

所有普通目标先精确 ID，再唯一 name，再在 name 无命中时匹配 title；kind 不符、零命中和歧义分别返回稳定错误。安全敏感的原生状态/Routine/复制操作要求 exact UUID 及命令声明的 revision/operation/confirm，不能用普通名称匹配降低其约束。内部执行只使用已解析身份。

不提供 raw Gateway、任意 API method、隐式 shell 或通用 harness setter。新增命令须有语义、权限、错误、未知结果对账及 [LIVE 路由](tickets/LIVE-integration-validation.md#command-coverage)。

## 4. 输入、输出和全局选项

只有 registry 声明的 flag 才进入 help/parser；未知 flag 在网络请求前拒绝。纯本地命令不暴露无意义的网络选项。runtime 本地边界不得通过 `--profile` 绕过。

`send` 和 `fs write` 的显式 `--text` 优先且不读取 stdin，即使同时有可读管道或处于非 TTY；只有没有显式正文时才读取非 TTY stdin。两者都没有则 `invalid_usage`。正文不进入错误回显。

除声明为 Markdown/流的命令，成功 stdout 是结构化 JSON envelope；失败是脱敏错误，稳定 code、已产生的 operation identity 和下一步应可读。可选表格是相同结果的投影，不改变语义。具体错误集合和退出码由源码拥有，不在本页复制易漂移列表。

Timeout 说明调用观察窗口结束，不证明远端未执行。unknown 不能被自动换 nonce、换模型或重放整个操作改成成功。

## 5. Profile 合同

### 5.1 配置与作用域

日常人读配置只有 config 与 models 两份；canonical durable 文件、home 别名、client/target 作用域、schema 和迁移流程归 [配置指南](configuration.md)。Profile、daemon/desktop/runtime/ops 偏好共用配置 writer；机器 binding/grant、writer floor、daemon verifier 和执行回执不是可移植配置。

无文件的逻辑默认与损坏文件不同。未知字段、重复 JSON 键、错误类型/引用和不支持的 schema 不得被旧 parser 丢弃，也不能静默改读旧树。迁移必须显式、可对账，不能仅因新文件存在就换权威。

### 5.2 Profile 字段

Profile 是 `client.profiles.<name>`；精确字段和默认值由 [config schema](../packages/runtime-kernel/src/internal/config/schema.ts) 定义。transport、daemon endpoint/ref、Gateway endpoint/ref/headers、discovery、SSH、Sandbox 和 quota 各有自己的作用域。带点名称使用 JSON Pointer，不把点号误解释为层级。

配置中的 secret 使用支持的 `env:`、`file:` 或平台限定的 `keychain:` 引用，不接受内联 token。file secret 须为受保护、当前用户拥有、非 symlink 的 regular file；无法核验时不宣称安全。便携导出不包含 secret 位置和安装身份。provider 凭据的更窄规则见 [runtime](box-runtime.md)。

### 5.3 连接与凭据

`auto` 根据能力和配置选择实际 transport；错误不授权远程 RPC→SSH、daemon→任意本地文件等语义降级。Gateway-only 连接不获得文件/进程权限。显式 SSH discovery 仅服务于其声明的连接建立/代际恢复，不是普通业务失败 fallback。

daemon credential、Gateway Bearer/routing headers、macOS App session、Sandbox account identity 和 quota identity 分开解析。某个 credential 在一条方法上成功，不证明另一能力已授权。缺失、锁定、损坏、过期、拒绝、歧义和不完整必须可诊断且不泄露秘密。

### 5.4 提交与生效

配置变更共用 schema、锁内重读/CAS、原子发布、读回和域 revision。保存、消费者采用、进程运行和实际效果分别取证。`--wait-applied` 只等该域真实回执，不能替消费者确认或隐式重启；超时保留已提交 identity。远端不提供 configuration capability 时拒绝 target 写，不能默写本地 Box。

## 6. Capability 路由

每个 leaf 声明所需能力，transport 只是实现。Gateway 提供原生产品方法；daemon handshake/策略限定 host 文件、进程、Jobs、桌面和诊断面。静态 Profile 投影不等于当前方法授权，真实写入前仍须验证。

Sandbox inspect/wake/keepalive 和 quota.read 各自拥有显式来源及资格。一个 token ref、一次 inspect 或一条通路可达都不能推导其他方法已授权。[Sandbox](cursor-sandbox-control-plane.md) 与 [quota](quota.md) 分别拥有细节。

## 7. Grok Bot 产品操作

### 7.1 Agents

Bot 和 Group 是原生 roster 中的不同对象。show 不附带历史；历史查询有独立入口。普通资料 update 不回填/修改 harness；create 可以请求执行类型，只有 Server 确认和原生读回才构成已创建/归属事实。创建 unknown 先按原 identity 对账，不换 nonce 重建。

`agents ownership` 是有限、只读、source-scoped 的 Server/本地对照，分类为 confirmed_box、confirmed_temporal、conflict、unconfirmed；App 路由、迁移和写权限是独立维度。缺桥、认证/身份不明、重复行、代际变化或过期不得显示 confirmed。当前共享 ownership 判定也被模型选择和 managed STEP 消费，不再描述为“只有 CLI 预检”。其新鲜度策略与执行 fence 归 [执行合同](runtime/execution.md)。

标题是展示，不是权限或模型事实。`owner=` 表示观察归属，`m=`/`e=` 表示受管选择/请求档位；用户标题须保留。show/hide/sync 不能相互隐式改变可见性。use --for 可更新该 Bot 的展示，reset 只刷新已经显示的 trailer；标题失败不能回滚已保存选择。源缺失时保留可解释的缺证，不能凭旧标题授予执行权。

Routine 管理已存在 list/show/enable/disable/delete、单份 disabled apply、provision outcome/reconcile；完整批量、agents create/update --routines-from、通用 invoke/native outcome 仍不能由这些子集推导。准确差额归 [ops/T53](tickets/T53-agent-routines-cli.md)。默认新任务 disabled；未列出的任务不删除；禁用不证明在途运行已取消；原生无 CAS 时不以本地锁宣称跨 App 排他。原生调度仍是权威。

<a id="bot-continuity"></a>
官方式 duplicate、当前状态、clone、replace 和 spawn 是不同操作。各有限源码入口与剩余边界统一由 [连续性](runtime/continuity.md)说明；操作分别见 [当前状态控制](maintainers/current-state-control.md)、[生命周期与交接](maintainers/bot-lifecycle.md)和 [duplicate](maintainers/native-agent-duplicate.md)。准备、激活、启动、业务交付、关系迁移与源退役分别取证，没有会话列表/切换或跨机器迁移。

### 7.2 Groups

Group 由原生 Gateway 写入，不是 CLI 自建集合。成员修改拒绝 nested group、重复和超限集合，Gateway 拒绝是最终事实。群发、成员迁移和删除的授权必须落在具体对象范围内，名称相近不构成同一身份。

### 7.3 Send

`send` 是明确 Human 输入，不伪造 peer sender。`accepted:true` 或 `status:accepted` 只表示 Gateway 已入队；回执必带 `clientNonce`，send 不提供 `--wait`。同次观测沿用这个 nonce：

```bash
grokbox history outcome <id-or-name> --nonce <clientNonce> --runtime --json
```

`--request-id` 是次查找，不另造主键；unknown 不重发正文。完整命令选项由 help 拥有，身份、范围及结果解释归 [结果观测](maintainers/run-outcome-observation.md)。

### 7.4 History, Memory, Export, Events, Running

outcome 无 `accepted` 成功词；`data.state` 为 unknown、recorded、failed、progress、delivered 或 expected_result_observed。recorded/echoObserved 不是执行完成。`executionCompleted` 保持 `not_proven`，不能从可见回复推断全部辅助步骤已成功。

nonce/request-id/step-id 按命令约束选择；STEP 不是首个 display request。已关联失败不会被空 tray 或其他日志 gap 抹掉。显式 runtime 证据不全时，保留真实 delivery 并标记相应 unknown；同源/前后 harness 复核不等于原子快照。wait 只按该结果合同结算，不重发、不 repair。

history search/tail/thread 是 transcript 读面；Memory 的 agent/user/project 层与 transcript 不同。Memory 默认 metadata，正文需显式读取。is running 是 roster 投影，false 不是命令失败；父运行、监听子任务、外部 worker、App 发送队列需要分开观察。

export agent 是盒内受保护的 allowlist 文件快照，默认不包含 transcript/blob 整库、secret 或全局 Skill/MCP 账号。skill/workflow 引用不是 per-Bot 所有权；related workflows 只在明确选项下追加。目标非空、路径逃逸和秘密材料 fail closed，测试用合成 fixture。

模板 pack 与 export 复用安全材料处理；pack 不上传，stage/publish/import/visibility/delete 各按正式入口和确认执行。没有可靠上游列表不虚构 template list。模板导入不是安装本地 Skill，也不是开启任务或运行时维护授权。

events 是按来源 allowlist 投影的有界 NDJSON；daemon cursor 带代际，restart/eviction 明确 gap；direct Gateway 不伪装可恢复 cursor。慢消费者、断连、畸形和超限流不能被解释为空闲成功；正常事件不包含正文、环境或凭据。数据读取、保留和诊断不获得执行权。

## 8. 云电脑文件命令

fs 通过受控 host/daemon capability，路径须落在授权 named root，检查 symlink、操作权限和上限。Gateway 不假装通用文件 API。读区分文本/二进制；写使用受保护父目录、临时文件、flush/rename 和预期 hash，承认外部 writer 的 syscall 竞态限制。

upload/download 验证 chunk 顺序、size 和 SHA；只有完全相同的重复 chunk 才幂等。mutation 使用有界 ledger 和稳定 operation ID；lost response 查 committed/not_committed/conflict/unknown，不盲重放。remove 使用 root-local、owner-only recoverable trash，递归有独立 capability/确认，不提供永久删除。二进制不暗中进入普通 stdout。

## 9. 云电脑执行与 Jobs

exec 默认结构化 argv，首项为 policy executable alias；shell 单独授权。cwd 是允许 root，env 只从 allowlist 增加，child 不继承 daemon secret。可执行权限不是 cwd sandbox。RPC 等待窗口与进程 hard deadline 不同。

jobId 在 spawn 前分配并持久化，相同 fingerprint 不重复 spawn，冲突明确拒绝。断连不取消 Job；restart 无法核验的旧非终态为 unknown。日志有界、cap 后继续 drain，subscriber 不持有 Job 寿命。cancel 有独立身份、FIFO/持久结算和 Linux 进程组身份复核，不能把旧 PID/PGID 当当前授权，也不伪称消除了最终 signal syscall 竞态。元数据不持久化 argv、env 值或输出正文。

## 10. Sandbox 与 quota

Sandbox keeper 在 Box 外运行；Box freeze 后本机进程不能自我唤醒。只读 status、一次 wake、维持 lease、停止后 freeze 和 recover 是独立资格。keepalive 不调用模型或 sendPrompt；普通网络 ping 不证明 Sandbox lease。只对声明范围给出实测支持，不承诺任意账号的 App-free wake。

quota 使用明确的 credential-owning source、固定 HTTPS/无 redirect、有界 schema 验证和 fresh sanitized 输出。无跨 source/secret fallback，不从 transcript 推算，不因成功读 quota 推导 wake 权限。账号、token、raw body 和 usage events 不进入正常输出。来源及具体边界分别见 [Sandbox](cursor-sandbox-control-plane.md) 与 [quota](quota.md)。

## 11. Daemon 与恢复

daemon owns listeners、RPC authorization、Gateway discovery、host adapters、Jobs/有限流和 shutdown。只读 status/doctor、ensure/恢复和首次 bootstrap 分开。doctor 命令完成不等于健康：消费 `data.ok` 和各 boundary，而非只看 exit 0。

默认 Unix socket 或认证 loopback，不默认公开 0.0.0.0。已有外部 endpoint/bootstrap/recover 只在其明确作用域内操作并保留无关映射、root policy 和凭据；SSH/网络身份不替代 RPC 授权。模型 runtime 的 controller 不通过网络恢复获得额外执行权。

## 12. Box-local model runtime

模型切换在同一确认 Box 归属的原生 Bot/上下文内发生，不改 Server harness、不修改官方 App、不以清缓存修复语义。未 opt-in Bot 正常使用官方 session；managed Bot 缺配置/桥/资格时明确失败，不静默回官方或另换 provider。

选择是下一 TURN 的意图，在途 TURN/STEP 保留捕获的 model/binding/effort/credential 身份。main/default 不自动 opt-in 其他 Bot；targeted reset 是单 Bot 安全回官方，不要求重新获得 managed 准入，不全局停用。普通回官方与完全卸载补丁是两个不同证明面。

Host 拥有原生 Agent loop、tools、root、checkpoint、Memory、Transcript 和 SendToUser；kernel/modeld 拥有一条受控模型执行程序。provider 不执行第二 Agent loop，不复制会话 store。输入内容和工具顺序不可暗裁剪/重排；不支持图像或协议时在副作用前可见拒绝。完整 validated-batch 才向 Host 放行工具，多个调用本身不是错误；放行不意味着副作用事务或已执行。

默认请求不自动恢复。明确启用的 pre-output HTTP 恢复有独立额外请求/时间预算、每次声明和权限复核；已输出、unknown 网络、鉴权、工具错误和重启不重放。confirmed-overflow 的零放行/一次额外主请求合同独立，不能成为无限 retry。辅助 memory/episode 的合格空结果可以是 no-op，主请求空结果不是成功。详见 [执行合同](runtime/execution.md)。

status 分开 desired、loaded、ready、captured、执行、交付与 evidence gap。配置保存、health 和旧日志不签署当前 Host/原版 App 可用。实际支持模型/对象/制品和现场资格只在 [LIVE](tickets/LIVE-integration-validation.md)；不得用一次 pong 替代工具、长上下文、持久化和回官方旅程。

### 12.1 原生提醒与自主运维

接受的默认用户体验是发现异常→固定必要现场→通知配置目标 Bot→只提醒并结束。通知不能自动诊断、建单询问、公开或执行维护；用户后续委托允许在其范围内自主操作与验证。此限制不是把所有 Bot 永久变为只读。

现有实现分段提供证据/存储、Routine、配对、预检、显式发送、通知授权和 daemon sender；完整 collector 常驻装配、跨 owner 容量与安全退役的差额必须继续保留，不能统称只剩 live。默认目标、字段、状态及剩余实现归 [operations](runtime/operations.md) 和 [OBS/ops 来源票](tickets/README.md#incident-evidence)。

通知授权、接收者模型/数据/费用、配对、任务启用和实际投递分别检查；HTTP accepted 不是用户收到。unknown 不广播、不重建接收者、不重放执行。关闭通知不关闭必要存储维护。高级路由、自动维护、公开 issue 和整盒外部失联观测不是默认提醒的隐含功能。

<a id="context-maintenance-product"></a>
### 12.2 本地上下文维护

受支持 managed 会话在新输入、restore/切模型、工具结果之后的下一主请求前按本地窗口检查，而非只等 provider 报 overflow。模型容量、本地预算和实际/估算用量分开；缺 usage 或前次失败不能按零处理。

首要目标是旧失败长会话的下一条新输入：先维护，再完整处理这条新消息一次；不要求新 Bot、清历史或重放旧 STEP。Host 验证并提交候选 root/checkpoint，丢失回执按原 operation 对账。摘要是捕获模型上的有界、无业务工具请求，不能从展示历史拼第二份 prompt 或暗换模型。

auto/manual、硬预算、摘要计量、Pi 受控复用和验证矩阵归 [context](runtime/context.md)，精确数值/版本归 [configuration](configuration.md) 和代码。无改善、固定输入过大、取消/换代、提交 unknown 都有可见边界，不循环超预算请求。摘要有损，不保证逐字召回；成功摘要文本也不证明原生持久化或现役采用。

## 13. 错误与证明

稳定 code、阶段、身份和 next 由实际错误合同投影；例如 config conflict、commit unknown 和 apply pending 不能压成空失败。SDK warnings、HTTP 状态/请求 ID 和 failure summary 必须有界脱敏；损坏诊断降低 evidence quality，不改写已知执行失败或伪造 invalid_stream。

实现、offline、实际 packed、原生隔离、provider/live、App 可见和重启持久化是不同证明。独立 review 缺结论仍是缺结论；读回、reconciliation 和安全 cleanup 优先于盲目再试。

## 14. 安全边界

每种凭据只在其能力 owner 解封；不写 argv、fixture、snapshot、普通日志或模板。provider secret 归 modeld，Host/preload 不导入 SDK/Effect/凭据解析。Gateway Bearer 不经 daemon RPC 返回。tailnet identity 不替代 method/capability auth。

GET 不创建数据库、迁移、repair、续租或扩大权限。诊断 GC 不删除用户状态、恢复材料和 unknown 执行记录。离线修复是明确维护动作，先 fence 原 writer；不与正常 writer 自动互换。详见 [SECURITY](../SECURITY.md)。

## 15. Bundled Skills

默认 `grokbox skills get grokbox` 只返回小入口；`--topic` 从固定 manifest 选一个 companion，`--full` 是显式完整参考，不是每个 Agent 的启动前置。core 命令参考派生自 registry。topic/path 非法在读文件前拒绝。

模板桩只给版本匹配入口和授权边界，正文与发布 stub 一致；导入模板不暗装 Skill。入口预算、manifest/目录/导航、Node 安装包加载和模板一致性由 [skills tests](../test/skills.test.ts) 保护。细节进入对应主题，不通过扩入口预算把维护手册塞回首页。

## 16. 验收与失效

命令、配置、原生 ABI、权限、writer、存储/保留、工具/模型协议或制品改变时，复核所属合同、负例、操作指南和受影响 LIVE 场景。不是所有变化都重跑所有模型，也不是文档更新自动放行。

[验收清单](tickets/LIVE-integration-validation.md)按实际发布声明选择范围；未来目标存在不构成无限前置。历史失败保留，已发生但未知的效果不清掉；新窗口固定实际候选、授权、预算与退路，完成后只清理本次拥有且可安全终结的资源。
