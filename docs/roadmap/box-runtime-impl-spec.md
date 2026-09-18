# Box-runtime 单轨重建实施规格

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Current Implementation Spec · accepted target。2026-09-16 modeld 执行核心收口由 [S10](#modeld-effect-core) 与 T43–T50 承接；此前 Server归属/Host-only/T41/V30 的未覆盖义务继续有效。源码/测试与各 Ticket 的验证状态说明实际完成范围，规格不冒充部署。** 本文拥有目标包/模块树、内部端口、执行合同、退场边界和实施证明。[plan](box-runtime-plan.md) 拥有策略、Phases 0–4 与产品出口；[ADR D1–D12](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md) 保留产品/信任边界；[新票据](../tickets/README.md) 承载切片与证据。源码/可执行测试拥有当前实现真相；本文不是已实现或已部署声明。

本批次采用 owner 指定的**破坏式、单轨重建**。POC 是研究素材，不是 grokbox 内部兼容面。保留 Host 产品行为，放弃 POC 的内部 API、目录、response-only 路径与旧 wire 兼容承诺。本文取代 plan 中旧内核、旧 wire 或旧 status DTO 的过渡保留口径；不削弱 ADR D1–D12 的安全要求。

<a id="stable-delivery"></a>
## S0. 当前交付：真实 Grok Bot 的限定范围稳定换模

2026-09-12 owner 确认继续实施，并要求**先治理本 Spec/Ticket，核对回收旁支，再继续源码**。R2 草案已经合入本节；ME-01–ME-08 仅是输入映射，不创建第二套 Spec、票号或进度账。旧 owner brief / path / handoff 只保留历史诊断，不再阻塞于 A/B/C 战略选择。

### S0.1 用户结果与范围

**2026-09-12 owner 最新裁决：生产模型锁定 Pi `ccs-sub2api-xai/grok-4.6`。** 复用已经成功的凭据/Responses 协议资格，不再把模型选择、luna 额度或更多 provider 调研作为主线。目标是补齐并验收真正生产会经过的全部链路；遇到运行时障碍应定位首个失败 owner 并修复，不用可绕过的 mock/短会话或简单 pong 降低发布门。允许必要的 Host/modeld 切换与已命名测试 Bot 的有界 CLI e2e；不绕过工具安全拒绝，不以授权代替结果证据。当前施工先执行T37归属准入和T38身份写入收口，再接T24可逆选模、T39原生往返与T40持久发布；T32/T35已实现机制复用，其真实恢复/后台摘要差额仍是长会话门，不用新治理掩盖旧缺证。

尽快让用户在真实 Grok Bot 中按 Bot 独立选择并持续使用自定义模型。权限、上下文安全和不重复副作用不可退让；架构泛化、更多 provider、完整自有 Harness、WebUI 美化不是先决条件。首版限定当前机器、一个已资格化 Host profile/固定制品、已核验模型/endpoint 及批准 Bot；现场支持范围、运行版本证据和未验项统一从 [LIVE 唯一索引](../tickets/LIVE-integration-validation.md)及其日期报告读取，不从模型名字猜容量。

- **体验检查点**：已有安全普通窗口、续聊和基础工具可先验证；未合格恢复保持关闭，不称长会话稳定。
- **稳定日用检查点**：两个 managed Bot 的不同选择、未配置 Bot 负对照、普通/工具多 TURN、首请求 overflow 恢复、恢复后续聊、实际会经过的 Memory/episode、checkpoint 后新进程恢复，以及正常配置持续生效/安装/停用退路。日常链路不能静默关闭以缩小验收。
- **当前新增必需能力**：[S12 默认本地上下文维护](#context-maintenance)覆盖旧失败会话下一条输入、首请求/工具后预算、手动及有界摘要；不再将基本proactive后移。更多provider/Host ABI、后台预生成优化、完整工具/存储writer接管仍属后续扩展，不能作为本轮旧会话恢复的前置。

必须保持：Bot 选择隔离；managed 主模型不因错误隐式回官方；历史执行身份/选择不可改写；Host 窗口、metadata 和工具关联零隐式裁剪；恢复不重复工具/终态；其它 Bot 与原生功能不退化；新旧 writer 不竞争同一事实；CLI 配置成功/单次 pong 不等于用户可用。

<a id="host-only-model-switch"></a>
### S0.1.1 Host-only 与可逆模型选择（2026-09-12 最新裁决）

**唯一代码介入面为Box Host及grokbox运行时；不修改/重签/注入官方Mac App，不把重启/清客户端缓存作为常规修复。** 早先桌面coordinator/renderer的分析用于界定合同和兼容性，不再作为可实施App补丁方案。

“官方模型 ↔ 自定义A ↔ 自定义B”必须是同一确认Box归属的Bot、同一原生会话/历史上的推理选择；不得伴随harness、Server身份、session/store更换。已准入TURN保持原绑定，未来选择在下一TURN生效；不影响其它Bot。官方选择使用原生`originalSession`，不是偷偷迁入temporal。支持模型须经过内容/工具/窗口/原生持久状态的双向资格，不能以静默丢消息实现随意切换。

支持准入须分清Server原始身份与Box/客户端投影。原生未过滤的Server Agent列表是确权入口；App的server-roster是temporal过滤视图。普通身份Update没有harness；已发现官方BOX→Temporal受控迁移，不存在“创建时box就永久不变”的已证保证。未找到普通用户可用的反向迁移契约前，Server已temporal或本地/Server冲突的Bot不能靠强写box宣称已接管。只改Host也不能控制绕过Host的App→Server主推理；支持范围与变化必须诚实表达，不能永久压住官方身份同步或迁移hold。

日常“回官方模型”与“完全卸掉补丁/恢复未修改Host”是两个验收面；后者还需原生checkpoint读取、部署/退出和升级迁移边界，不从`originalSession`单元测试推导rollback完成。施工继续用同一Ticket序列：T37归属门、T38身份writer/test2、T24选择、T26原生消费者、T39完整往返、T40持久发布；T32/T35和连续性保留既有合同。不另建ME或平行状态账。私有协议证据在grok-bot `private interoperability notes (not distributed)`。

<a id="server-authority-rollout"></a>
### S0.1.2 Server归属优先与后续处理（2026-09-12 最新接受原则）

本节是接受的后续方案，不是已执行的身份修复或生产放行。对已登记的Bot，以同账号/身份范围下原始Server行的公开UUID、Server行ID和harness确认执行归属；本地目标是与之保持一致。我们不通过修改Server harness、屏蔽其正式迁移或制造本地分叉实现换模型。空/未知、无匹配、错权限/运行代都不能默认box。归属权威不等于展示/模型状态都以Server最新副本为准：确认box的会话仍由原生Host提交执行与上下文，Server为合格同源读取副本，Mac为客户端视图。

**归属准入**：`agents ownership`仍是只读查证；当前工作树已把可复用判定提取到kernel，并由模型选择及production modeld/STEP程序消费，不再只有CLI预检。现场scoped bridge与原生迁移/完整packed入口仍须T37资格，未部署代码不冒充现役强制门。不让Host依赖CLI，不复制第二套分类器。保留四类ownership，desktop/migration/freshness/模型资格为独立维度；confirmed_box不等于productionAccepted，也不独立证明viewer拥有写权限。

在启动/重新领养、首次启用或切换模型及后续新TURN的准入边界确保有界新鲜证据；同批读取去重，不逐token/逐tool盲查Server。复用原生resume-ownership/暂停与迁移屏障，身份/Host代/官方归属变化使旧准入失效。新managed执行遇冲突、过期或读取失败应有界等待或明确拒绝，不悄悄转官方/temporal；现有副作用按真实已发生/未知结算，不盲重试。读取快照不是跨Server/Box原子租约，不能仅靠轮询声称永无竞态。日常配置变化只影响下一TURN，与官方撤销执行权不同。

**收口原有写入**：现有create可请求box但须以Server实际确认闭环；没有成功确认不默改、不重建。普通资料update不再携带/猜测harness，显式切归属不得作为普通profile更新。现有`harness-server-write`等本地优先保护须在新准入门和冲突保全建立后审查退场/替换，不能简单先删再把所有现场自动同步。保留诚实的box/temporal观测和只读Server桥。安全对齐仅经已资格化的原生身份writer，在身份稳定、在途工作及原生数据已处理的前提下执行；不得手改SQLite、用合并消息或清Mac缓存替代。

**测试对象**：test0是确认box的正例候选，test1保持官方/未opt-in负对照；test2的Server temporal/本地box冲突保留为历史反例，从正向managed/heavy canary名单移除。先保留私有、可恢复且带来源的必要证据/原生状态，再用它检验只读诊断和本地managed准入拒绝（provider/tools/SendToUser零新增效果）。Host不能拦截已绕过它的App→Server发送，不以在App向冲突Bot发新任务来证明Host门有效。未来确需恢复一致时，先单独确认影响，再经原生安全对齐回Server登记的temporal；本地box历史留作独立归档，不声称两条模型上下文自动合并。不可逆地修平现场前必须固化可重复的离线冲突fixture。

**施工顺序、交付owner与阶段出口**：

| 顺序 | 必须交付 / 可以交下一棒的条件 | 唯一owning ticket及协作 |
|---|---|---|
| 1 | 共享归属规则进入实际异步TURN准入；非CLI入口也不能绕过；冲突零新增provider/tool/SendToUser | [T37](../tickets/T37-server-ownership-admission.md)；T24/T26接线 |
| 2 | 普通资料更新无harness；先门禁/保全后撤本地强写；test2冲突夹具可重复，现场修复另行确认 | [T38](../tickets/T38-identity-write-alignment.md) |
| 3 | 逐Bot官方/A/B选择，desired与当前captured分开；新TURN生效，旧TURN不重绑、其它Bot不变 | [T24](../tickets/T24-runtime-route-binding.md) |
| 4 | 同Bot官方→A→B→官方→A真实原生回程；custom checkpoint可被官方读取，工具/Memory/恢复不退化 | [T39](../tickets/T39-native-model-roundtrip.md)；T21/T26/T32/T35修本域缺口 |
| 5 | 原版App输入/历史/最终结果、不同层级Working同一执行；无App补丁、异源合并或清缓存要求 | T39编排，[T26](../tickets/T26-runtime-host-fullstream.md)/[T36](../tickets/T36-composer-working-activity.md)各签本域 |
| 6 | 持久启动/重启、限定Bot放行、日常官方选择和完整未补丁退出均有实测；独立review及固定制品 | [T40](../tickets/T40-persistent-release-and-rollback.md)，复用T25/T28控制程序 |

T37开发不等T38反向依赖；T38的writer退场依赖T37有效门。T24单元与T39 owned夹具可提前并行，正式真实往返须满足前述门。T40服务隔离实现与T39并行，只有**最终放行**才合取所有必需证据，不能让T39/T40互相等整票Done。每个文件/工作面一名writer，固定验证输入后再集成。T29 WebUI、更多provider与完整Server/Agent Runtime不是前置。

真实验收用批准的grok-4.6和另一个已批准/合格模型，不借缺真实第二模型的mock冒充往返完成；只读fixture允许构造更多模型与迁移反例。合法temporal和其它官方Bot不得因managed门而失效。原App的真实路由缺证或仍有已证冲突时不能以“Host看起来正常”放行；在Host-only约束下报告该Bot/版本的具体兼容边界，不扩展到未授权App补丁。

<a id="delivery-command-contract"></a>
### S0.1.3 命令、证据与支持范围的最终合同

下表为目标，不声明现有命令已实现全部门。新增verifier case在S9明确标待实现，用户入口复用既有CLI，不提供通用harness setter。

| 入口/事实 | 目标行为 | 当前差额owner |
|---|---|---|
| `agents ownership` | 保持只读；四类归属、来源/时效/ID/本地稳定性与独立App/migration/权限事实，缺失不猜box | 读取已有；T37共享规则与真实准入 |
| `agents create --harness …` | 请求类型不等于已确认类型；Server确认/回读后才合格；未知用原nonce对账，不二次create/强写 | T38 |
| `agents update` | 普通资料body无harness，显式修改既有归属写前拒绝；未知字段不补box | T38 |
| `runtime models use … --for …` | 归属/模型预检，原子保存下一TURN选择；不改身份，不重绑在途执行 | T24+T37 |
| `runtime models reset --for …` | 显式撤掉单Bot managed覆盖不以managed准入为前置；Box仍走原生官方，其它原生归属不变。不给冲突/缺桥对象签执行权；不全局停用，选择保存与实际生效分开 | T24 |
| 模型/status投影 | 区分desired、当前TURN捕获、loaded/runtime状态与缺证；省略/损坏配置不伪装成用户选择official | T24/T27 |
| `history outcome` / alerts / runtime日志 | 原nonce/TURN/代对账；进度不当完成，多STEP后续失败优先，读取不重发/repair | T26/T39 |
| `runtime start`及部署/退出 | 复用唯一控制程序；干净环境与重启持久，准确区分日常官方选择与全卸载 | T28/T40 |
| monitor init/run/快照/事件/incident与ack/snooze（本地子集已实现） | 独立网页的长期采集与管理事实；查询不写、显式管理不改变准入；Host tray仍是另一来源 | T41，未来T29共用API |

**门的语义**：Server归属决定执行资格，不独立决定权限或上下文事实；新鲜读取不是原子租约。官方归属撤销与普通模型选择更新不同，执行中效果必须如实结算。不得通过高频全量查询解决竞态，具体证据年龄/等待/批量上限由T37以canonical policy和可控时间反例固定，未完成不能签该票。

**test2关闭分层**：冲突识别、零副作用阻断、防再次隐式写错是发布必需；保全后的真实temporal校准需要独立影响确认。可以保留活样本并有合成可重复反例，但不能既不修也继续把它当managed正例，或借归属一致宣称合并了两条上下文。全局reconcile影响不能伪装成逐Bot操作。

**支持不缩水也不夸大**：确认box且未修改App的完整官方/A/B往返、工具/Memory/reload/长会话为目标范围；Temporal主推理不经过Host，不能硬改字段来冒充支持。运行事实未知/在途不明时明确阻塞；owner同意模型不等于该模型的每种内容/窗口资格都已通过。Prompt cache性能允许未命中，执行与上下文正确性不允许依赖命中。

<a id="continuous-observation"></a>
### S0.1.4 持续观测、SQLite 与告警（T41本地子集已实现，完整目标未关闭）

Web UI是确定的后续产品方向，但浏览器仍暂缓；**持续观测不能依赖打开网页**。新增[T41](../tickets/T41-continuous-observation-and-alerting.md)承载浏览器之前的共享采集、观测持久化与告警。具体页面/远期扩展归[future](future/README.md)，不在这里提前建设前端、远程控制或另一个orchestrator。以下修订旧的“MVP绝不使用SQLite/观测数据全部可丢弃”口径；不改Server、canonical配置、Host会话或STEP ledger的权威。

**对象与范围**：Box是执行机器，Bot是有harness的Agent；不能混同两种归属。观测键至少有可信Box身份、账号/team/backend的不透明scope、Bot公开ID/Server行ID，以及独立Host/Gateway/service运行代。机器路径/IP/PID/显示名不是稳定Box身份；暂缺身份时unknown，不能把另盒缓存拼上。单盒先落地，字段可扩展不等于已经支持多盒管理。

**共用采集、不共用错误权威**：复用T37原生Server读、T27/T33状态/事件和既有配置回执。一个受现有Effect runtime管理的采集任务，事件触发+有界poll；同范围请求合并、批量/并发/等待/退避有界，准入查证优先，不按页面/tab/每token重复查询。客户端关闭不停止采集，服务重启失效旧live证据。T37可用相同collector的合格新鲜证据，但**不得从SQLite快照或告警状态恢复执行授权**；T37不等待T41数据库/通知可用。观察到撤销立即交原生准入屏障处理，不等告警写盘或用户确认。

**变化不是超时**：保留last-known及其last-success，与当前fresh/stale/unavailable独立。失败/缺页/权限变化不伪造harness改变、删除或恢复正常。记录source revision/sequence（上游确实提供时）、自身observationId/collector epoch、前后观察时间与完整性；本地序号不是Server版本。轮询只能给出“上次观察A至首次观察B”的区间，不能声称精确迁移时间、操作者或完整中间历史。scope切换/旧代迟到不能形成新scope的变更。

**存储选定SQLite，角色受限**：目标位置`${durableRoot}/observability/observations.sqlite`，由单盒后台独占写入角色；API/browser不访问文件，Host leaf不import SQLite。Node-portable driver、迁移/备份/保留策略及大小上限由T41实现前明确验证，不顺带升级Node/Bun或在网络挂载跨盒共享DB。逻辑内容分三类：可重建current projection/原日志索引；保留期内不可假称可重建的observed transitions；本域权威的告警确认/静音/发生周期和通知回执。后两类不是可随意删的缓存。原J13 writer及provenance receipts不迁移；不导入Host消息正文/Memory/secret，不让DB成为第二配置、身份、执行或部署账本。

**写入与故障边界**：一次接受的采样/变更/对应告警状态在本地事务内一致提交，再发布带cursor的观测事件；与上游没有分布式事务，掉电间隙可能造成观测缺口，不能编造历史。网络调用不在DB写事务内。数据库故障报告gap/monitor degraded，不清库假恢复，不阻塞已允许的推理/原生记录或重跑任务；准入独立取其可信事实。未知schema保全只读，迁移/压缩/retention/重建是受控维护，GET不触发这些写。事件慢消费者有界、游标过期/重启有gap，重新取快照不能覆盖终态或跨scope拼接。

**告警是管理状态，不是执行状态**：初期监控明确归属变更、Server/local冲突、证据过期/采集失联、相关已存在的运行代/配置不一致。重复采样更新同一个incident的lastSeen，不每次发新告警；去重键含scope/对象/规则/发生周期。open/resolved与ack/snooze分开，ack不等于恢复，静音不改变T37。首次接管就已冲突的test2可产生baseline conflict，不虚构此前迁移时间。恢复要有新鲜正证据，断线不自动resolve。通知只含安全ID/错误码/影响/证据指针；显式配置并批准的渠道才投递，投递重试只重发通知，绝不sendPrompt/reconcile/adopt。稳定deliveryId用于渠道支持的幂等；超时已收未ack诚实unknown，不承诺全渠道exactly-once。

**本地在线能力与远期边界**：T41交付CLI可查的事件/incident、ack/snooze和一个显式启用的有限通知出口（测试用fake，不默认外发）。整机离线不能靠盒内进程自报；外部失联监测、多盒汇总、多渠道升级规则归future。快照+游标+有限订阅合同先落内核，Web UI后消费。既有`alerts list`仍读取Host tray，新的monitor incidents有自己的语义，不悄悄替换或合并同名告警。

**当前实现与后续范围（2026-09-18核对）**：`runtime monitor`已有显式init/run、纯GET、磁盘SQLite增量事务、incident/ack/snooze、消费cursor、source gap与局部retention/增量空间回收；早期sql.js全镜像/16MiB寿命上限不再是现实现合同。实际实现与限定证明归[T41](../tickets/T41-continuous-observation-and-alerting.md)及[观测维护页](../maintainers/continuous-observation.md)，policy常量归kernel `monitor.ts`。当前出口仍`local_only`、`productionAccepted:false`，正常run不证明安装自启或Bot收到提醒。[OBS-00–06](../tickets/README.md#incident-evidence)与[专项Spec](template-ops-automation-spec.md#storage)补未知/无STEP入口、完整度要求、固定证据及全安装容量治理；现有GC不等于全部对象已安全退役。

**依赖**：T37先完成共享事实与真实门；T41可与T38/T24/T39并行，复用T25/T40长期服务安装能力。T40签持续生产时验证T41单盒最低监控闭环，T37开发和普通推理不依赖DB，T41不等待T40整票放行。T29仅在前端排期后消费；共用ConfigurationWrite的revision/冲突合同现在明确，真正第二写入入口落地时实现，不造UI-only writer。没有T41或没有外部通知渠道的运行应如实说明监控范围，不把future能力列入已完成。

<a id="template-ops-automation"></a>
### S0.1.5 原生 Bot 运维、默认提醒与有界证据（2026-09-18）

长期目标是原生Grok Bot自主帮助用户排障、管理Bot、换模型和使用grokbox；当前首发主链收为持续发现→固定关键现场→通知配置目标Bot，携带安全摘要、ID与可用JSON取证命令→默认只提醒并结束。不自动分析、询问Issue、公开或催问。用户随后委托或独立预授权时，Bot可在对应范围内自主执行并核验；提醒策略不是通用Bot永久只读限制。[本轮决策](../decisions/2026-09-18-observable-native-bot-ops.md)替代旧默认支持/发布路径。

专项施工合同唯一归[Template Ops Spec](template-ops-automation-spec.md)，新[OBS-00–06](../tickets/README.md#incident-evidence)拥有最低证据、未知故障入口、分层视图与有界存储；既有[T43–T56](../tickets/README.md#template-ops-automation)复用原生Routine、目标配对、可靠投递与后续诊断/维护，T52/T56延期且仅保留未来用户决定后的gh路径。配置仍经唯一ConfigurationWrite；目标binding/执行grant归各受信机器状态owner，不由普通配置签署。具体下一版schema切换在T51统一，不更改当前config3的实现事实。

本地collector不调用模型、不发Host信号；同一T41 SQLite保存incident、证据引用和outbox，原生Bot仍拥有Agent loop，原controller仍是唯一维护writer。普通日志轮转、事故分层GC与执行安全状态退役分开；GET不采集/清理/续租，关闭通知不关闭必要存储维护。S13连续性恢复有自己的私有manifest/blob与权限，不拿诊断JSON当resume材料。

后续预授权维护继续要求exact SHA/完整切片与依赖资格、Server gate、原生排空屏障、真实回执和未知结果对账。Bot交接后结束自身回合，不能等待自己的Host重启并占busy；路由/模板/严重度不扩大权限或费用。首发不等待自动维护、完整恢复或Issue，也不能以离线配置/投递成功声称现役已开启或用户已读。

<a id="configuration-rebuild"></a>
### S0.1.6 AH-99/AH-100 配置底座收口（2026-09-17 Spec-only）

[统一配置重建 Spec](configuration-rebuild-spec.md) / [T57–T60](../tickets/README.md#configuration-rebuild) 是本轮配置根、文件形状、通用命令、writer/迁移的唯一专项合同；运维 T43–T56 只拥有业务规则。对外两份日常文档 config.json/models.json，Box 实体留 durable，client Profiles/daemon/desktop/runtime desired/ops 意图聚合；机器 binding/grant/安装安全状态不进普通配置。删除尚未实施的 ops-policy 第三文件与 runtime ops config 目标。

公开 config/models/ops 主线、同一 ConfigChange/CAS 与按域 dependency revision；Host 保留 canonical models 的 no-follow/selectionRevision，不读大 config 或 ops/Effect/SQLite。当前 v2 新增 chatDialect 等模型字段必须保全，不为统一配置重做 provider schema。迁移先 fence 旧 writer、固定计划、阶段恢复与 consumer 读回，新文件存在不自动胜出，保存不等于已应用。AH-101 行为独立，实际迁移/服务中断仍须授权。本轮仅建立设计/Tickets，不修改 Linear 状态或宣称旧文件已退役。

### S0.2 最小完整控制边界与用途

复用现有 `runtime-kernel` 的 STEP program/ledger、binding、auth 和当前 v5 同连接，不增加第二 orchestrator、Context Store、Memory writer 或 provider loop。Host 侧的 **Managed STEP Scope** 是 T35 的生命周期边界，不强制新类、包或服务：在 provider 开始前取得真实有效 root/ctx/身份、协调本 root 的摘要入口，退出时释放并使旧能力失效。Host 保留摘要策略、root/归档/checkpoint、工具、Memory、SendToUser 的实际 writer。

| 用途 | 本阶段模型/owner |
|---|---|
| main attempt0 / attempt1 | 当前 Bot 的同一受理 TURN/STEP/binding/selection/ServiceEpoch；至多两次 managed attempt |
| dedicated compact summary | 当前接线为Host专用external；S12目标为Host材料/接受 + 捕获模型的独立conversation-compaction请求，不回到等待中的managed STEP，不作主模型fallback |
| memory-extraction / episode | 已接受 F5 purpose、独立 aux id/生命周期、来源 TURN 捕获选择；Host 写 Memory |
| tools / native subagent | 原 Host 工具与子代理选择语义；不声称所有子代理已换模 |
| 未 opt-in Bot | 原生官方路径；不消费 managed recovery 能力 |

**续聊投影**：Host state 保留实际 plain reasoning、tool-call/result 及其顺序。当前 CCS 协议将已知纯文本 reasoning 按与工具历史相同的带 type JSON 文本投影，流式/非流式共用同一转换函数；不得因为 OpenAI SDK 缺原生 itemId 就静默丢弃，也不得伪造 itemId/签名/加密内容或把未知 part 变空文本。该 provider 投影不反写为 Host state；opaque/native-only reasoning 仍需独立资格。

期望模型修改在**下一 TURN**生效；当前已准入 TURN 及其恢复沿用捕获选择。权限撤销与下一 TURN 配置变更分开，撤销必须 fence；当前实现若仍将普通配置变更当旧 TURN 失效，这是 T24 的差额，不偷偷改产品目标。容量、vision/tools 和 usage 走 canonical model/adapter 合同；未知不能变成估算的“已资格化”预算。

### S0.3 T35/T32 的恢复完整性

1. **先就绪后启动**：STEP 身份、root、ctx、disposer 均已初始化，slot 真实可用才启动 provider；late-register 或占位 slot 不能合格。
2. **同 root 摘要协调**：managed 执行/恢复期间不允许 approaching-limit、responseSummaryLaunch 等旧自动入口并发接受同 root。已有独立可完成的 external summary 可在启动前有界收口并重取窗；self/未知依赖不盲等、不删除 Promise。官方分支原行为不变。常见路径永远 blocked 不是完成。
3. **唯一失败恢复预算 owner**：kernel 只在已确认 structured overflow、attempt0 静止且未放行正文/思考/工具时取得一次额外主请求资格；Host 外层不得增发推理 retry，不换 STEP 绕 ledger。S12的发送前/手动维护不需要provider错误，使用独立维护operation并复用同一Host接受能力，不消耗或扩大该失败重试预算。
4. **统一期限**：当前 grok-4.6 生产候选的单 STEP 硬上限为 180 秒，Host/client/modeld 使用同一 canonical 常量，不由各层再续一个完整周期；admission/partial socket 的短期限不变。父执行剩余预算覆盖摘要、snapshot 校验、attempt1 与结算预留。传递剩余预算后接收侧建立本地期限，发送方仍判最终到期；不能比较跨进程 monotonic 原点，不能靠进度无限续租。固定 5 秒或单纯调大等待不构成修复。
5. **root 接受 fence**：摘要开始前取消可证零 invocation；开始后不得假称零 effect。root 接受前检查其 owner/身份/期限；旧授权不能提交到新活 root。root 已改就如实记录，断连不叫回滚；未能确认的 native 工作隔离到受影响 root，不能全局堵住其它 Bot。`Promise.race`/禁发 resume 不是 commit fence。
6. **合法新窗口**：从同一 active root 回读、保留 carrier/metadata/system/tail/tool 关联，验证 snapshot 与目标预算。字符串返回、消息数下降或 digest 变化不单独证明改善。只允许原 binding 的一次 attempt1 与一个逻辑 terminal。

现有小补丁足够就复用；无法控制摘要接受/外层 retry 时取得必要接点或接管完整相关 runStep 段，而不是堆 timer。具体 release profile 的 exact SHA/唯一 anchors/生命周期/旧入口退出由 [T32 seam qualification](../tickets/T32-host-compact-seam.md) 证明，未知路径仍不部署。

### S0.4 验收矩阵（定义要求，不声明全部已通过）

| id | 必须验证的场景/反例 | 执行 owner |
|---|---|---|
| V01 | A/B 不同模型、C official；实际请求隔离 | T24 / [LIVE 会话往返](../tickets/LIVE-integration-validation.md#live-session-roundtrip) |
| V02 | 当前 TURN 改下一 TURN 选择；原 TURN/recovery 不换绑定，历史不改 | T24 |
| V03 | 真实启动顺序的首请求立即 overflow；旧 late-register 必须红 | T35 |
| V04 | pending external/self/background 交错，同 root 无并发接受且可推进 | T35 |
| V05 | 一次 compact、合法 resume、一次 attempt1、唯一 terminal | T32 |
| V06 | 401/429/413/EOF/超时/已放行内容不恢复、不重复 effect | T32 |
| V07 | 慢于旧 5 秒但在父预算内可完成；超总预算不续跑 | T32 / T35 |
| V08 | 摘要前/中/root 接受前后取消；迟到 fence、未知隔离、无伪回滚 | T35 / T32 |
| V09 | 重复/旧 nonce、错 tuple/generation、断连迟到零重复 | T32 |
| V10 | executor 隔离、metadata、非法 bind/append/getter、新 snapshot 资格 | 连续性 F1/F2/F3 / T32 |
| V11 | managed 恢复失败后 Host 不放大 retry；official 负对照 | T35 |
| V12 | 能力启用范围与故障注入范围分别约束；多 Bot 并发无等待环 | T32 / [LIVE 原生连续性](../tickets/LIVE-integration-validation.md#live-context-native-continuity) |
| V13 | source 与实际 packed 相符，旧 SHA/profile/缺 case 不绿 | 连续性 F6 / 来源票的固定制品证明；实际加载另见 LIVE |
| V14 | owned checkpoint 后退出进程再 restore；不是 RAM/UI 回填 | 连续性 E04/E08 |
| V15 | Memory/episode 正反向 purpose/父选择/错误不入 Memory | 连续性 F5/E07 |
| V16 | 原版App真实发送/显示与实际Host模型、工具和交付关联 | T26/T39 |
| V17 | 正常配置与凭据读回/干净启动/重启持久；不依赖临时env/注入 | T40，复用T25/T28 |
| V18 | 固定版本升级/停用/退路；不覆盖root、不重放未知STEP | T40 / rollback acceptance |
| V19 | 有限代表性多TURN日用旅程，恢复后续聊、工具/必要aux不退化 | T39 / 连续性E10 |
| V20 | 原始Server归属、scope/freshness/失效与真实Host准入；缺证/冲突零新增effect | T37 |
| V21 | 普通资料无harness、创建确认、错误本地优先writer有序退场 | T38 |
| V22 | test2合成及真实冲突保全/阻断；校准影响另行确认，不合并分支/重放未知任务 | T38 |
| V23 | 同Bot官方→A→B→官方→A；custom原生checkpoint由官方读回，身份/历史不变 | T39，T24/T26提供机制 |
| V24 | Working/typing/权限/消息streaming同正确session/run/代，结束后不被旧事件复活 | T36，T26/T39协作 |
| V25 | 日常单Bot回官方与完整未补丁Host退出分别证明；退出后读证不依赖已卸bridge | T40 |
| V26 | 同原生窗口前缀/编码稳定，cache冷/热不影响正确性；真实usage或未观测诚实投影 | T39 |
| V27 | 固定候选、独立review、实际支持矩阵与限定Bot放行/停止条件；必需缺证不签生产 | T40 / [LIVE 唯一索引](../tickets/LIVE-integration-validation.md) |
| V28 | 独立网页的共享采集/有界刷新、scope/代/freshness变化、旧观察与真实撤销分开；无伪迁移/删除 | T41，复用T37/T27/T33 |
| V29 | SQLite观察/管理分层，崩溃/损坏/迁移/保留与cursor gap；DB不恢复准入、不写配置/Host状态 | T41 |
| V30 | incident去重/恢复/ack/snooze、通知有界重试和幂等边界；不执行任务或修复，网页关闭仍监控 | T41 / T40 |

自写 fixture、原生隔离资格、live Host + 合成 overflow、真实 provider overflow 分层记录；不能互相冒充。负例优先离线，真实入口与运行配置必须实测，不将破坏性负例反复打入日常现场。关键缺证保持候选，不要求无限 soak/所有未来 ABI。

### S0.4.1 生产验收的结果观测（2026-09-12 App warning 补充）

Owner 明确生产目标为已可用的 grok-4.6；不再围绕 provider smoke 循环。真实工具/续聊/恢复/持久运行是主线。`Parallel tool calls are not supported` 的现场反例要求补齐 T26 Host 合同和 V16/V19 观测：

- 生产 managed 工具策略为 `validated-batch`：默认向 provider 请求 `parallel_tool_calls=false`，显式调用选项保留；生成偏好与 Host 执行能力分离。不能仅在第二个合法调用完成时拒绝。完整批次验证后才按首次出现顺序释放所有 start/delta/complete 与同序 response calls，原生 Host 继续拥有执行/权限/结果归并。未闭合、身份冲突、坏参数、无有效成功终态及提交前取消均零工具材料释放。显式 `fail-closed` 只作为已声明单调用消费者的策略，不是生产 managed 默认；不以丢工具、自动重试或第二执行器实现兼容。
- App 的 `getTrays` 是 Host 内存快照，会去重、淘汰、dismiss、随新发送清除及重启丢失；不得称它为持久警告数据库。CLI 增加只读 `alerts list`，不暴露或执行 raw actions/secret detail。
- `history outcome` 按原 nonce/精确 requestId 对齐 transcript、当前 warning；本机可显式关联 runtime journal。SendToUser 进度、模型完成、Host 拒绝、最终业务结果分别表达；没有 warning 不等于成功，历史和新 Host 代不能混接。预期结果匹配只证明观测到所需内容，不自动证明整个 run/checkpoint 完成。
- 同一个 Bot 的 box/server 展示账本不得混接：roster/事件保留有限 `harness`，省略或未知不伪造为已观察 box；结果查询在每次采样前后检查声明路由，`--expect-harness box`（本机 `--runtime` 隐含此要求）遇变更/缺失/不符返回 unknown。采样一致不等于原子快照，更不证明桌面缓存来源；已混用的 test2 保留反例，干净 Bot 验收不能替代回切缺陷处理。入口与边界见 [harness 观测](../maintainers/transcript-harness-box-vs-server.md)。
- **V16/V19 的桌面入口资格（遵守S0.1.1，不改App）**：原App的缓存restore/server-roster分类不仅能改显示，也能令 `sendPrompt` 改走server。Box profile稳定、CLI route观测和provider成功都不足以关闭真实App门。对批准的managed Bot，发送、历史读取、订阅与renderer安装必须遵循同一具来源的路由决定；过期缓存/identity副本不能覆盖当前正式归属；官方真实迁移须被尊重，逐Bot变化须隔离旧响应，合法temporal保持不变。这是生产入口/上下文边界，不是T36转圈视觉优化；协议研究留在私有private interoperability notes (not distributed)，公开差额归T26与 [harness当前页](../maintainers/transcript-harness-box-vs-server.md#actual-desktop-recheck-2026-09-12)，不新增并行任务账。
- **Working/typing 同源验收**：消息历史、运行/活动状态、单条消息streaming和本地待发送状态分开建模，但必须指向同一选定路由与正确Bot/session/run代。App 0.47普通working由running/composing决定，currentActivity只补充具体活动；不能以单字段缺失判不转圈，或以任一来源的busy覆盖当前执行。结束/失败/取消只终结对应run，旧busy不得复活、新run不得被旧done熄灭；断线过期保持unknown/reconnecting。此语义验收归[T36](../tickets/T36-composer-working-activity.md)，与T26的路由资格共同关闭，不只是视觉美化。
- Host 在实际 terminal/rejection 时持久写入有界错误码/阶段/Agent/TURN/STEP，与模型端因 socket 被关而记录的 cancelled 分开。只读观测不得 resend、重试、dismiss 或 repair；超时返回未证而不是生成成功。公开实现不依赖截图或私有 SQLite 回填。
- 生产复验暴露的多 STEP 观测差额：发送 requestId 可能只对应首个 STEP；后续同 TURN 工具/SendToUser 的失败必须通过实际 Agent＋TURN＋serviceEpoch 关联，不能只查首 STEP 后显示 accepted。不得按时间或同 Bot 猜关联；同 TURN 出现多个运行代应明确 unknown。
- SDK 的 length/content-filter 不得归一化为成功 stop；成功 finish 但既无可见文本又无完整工具调用，也不能以纯 reasoning 或空输出冒充完成。保持已放行内容的真实副作用边界，拒绝不触发隐式主模型 fallback。

### S0.5 输入映射、施工顺序与权限

ME-01 → 本节/票据索引的基线与旁支核对；ME-02 → T24 与连续性 F3；ME-03 → 连续性 F1/F2/F4；ME-04 → T35 与 T32 seam；ME-05 → T32；ME-06/07 → T32 来源制品证明与 [LIVE](../tickets/LIVE-integration-validation.md#live-context-native-continuity) 的现场检查点；ME-08 → 连续性 F3/F5/E04–E11 的日用子集。交接只链接这些 homes，不另记完成态。

当前施工与交接以[S0.1.2](#server-authority-rollout)和[Ticket索引](../tickets/README.md)为准：**T37 → T38 → T24选择差额 → T39（合取T26/T32/T35/T36）→ T40生产放行**；T40隔离服务实现可并行，不制造环。新增T37–T40承接不同职责，不是改名重做旧票。此前E09与恢复代码证据复用，不重做已有功能。export已有port则复验不重做；旁支commit不等价于代码差额。固定单一候选与验证输入后再阶段收口，清理前保全dirty/untracked与活跃引用；主仓库Git数据和v2工作树保留。

owner 允许实施、阶段提交、必要旁支回收和安全清理；不是无限live/费用授权。test0可用于确认box的正向候选；**test2当前仅保留冲突诊断/负例，不再作为正向managed/heavy模型探针**，其未来修复影响另行确认；test1不opt-in。新正向测试Bot须明确创建并经Server确认box，不能默认扩展到业务Bot。每个live窗口固定候选、问题、成本/停止条件并先满足离线/独立review门。不得手清 circuit、重放未知 operation、无目的 unload 或扩大到业务 Bot。临时试验结束复原并关闭注入；持续正常 rollout 须有明确 Bot 范围，不能拿历史 GATE 解锁当永久全局启用。

<a id="scope"></a>
## S1. 实施模式与硬边界

1. **只有一棵目标树、一套业务程序、一份当前 wire 合同。** 禁止 `legacy/`、`vNext/`、平行 kernel、旧路径转导新路径的 re-export shim、`old || new`、`effectMode` 和长寿命 migration flag。
2. T20 先做实体切割：转移仍成立的纯规则/控制机制，移除旧推理执行链及调用入口。旧测试先提取 expected vectors/oracles 到新 owner 的合成 fixtures 并指定后续激活票据，不继续 import 退场 API；未激活向量不可计作通过。尚未接好的推理/控制能力在 composition boundary 显式 `runtime_not_ready`，不能借 POC 兜底或返回 fake success。T26 必须消除推理占位，T28 必须消除控制占位；占位不是可发布功能，也不是保留旧内核的 feature flag。
3. 中间提交可以是**可编译、能力未齐**的单轨版本；不得部署到现役 Host。每票只声明实际证明的能力。删除测试或跳过断言不算恢复能力。逐票从相同目标路径装配，不创建一个完成后再搬家的新实现目录。
4. **Grok Bot Host** 指上游进程，继续拥有 root/合法上下文分区、compact 材料与接受、session/store、Agent loop、工具、Memory/Transcript、SendToUser、官方 renewal 与 Gateway publication 的实际 writer；managed STEP 的准入、attempt/recovery及S12本地工作预算归kernel，Host摘要调度/接受按S0.2–S0.3与S12受控委托。**grokbox root** 指自己的 CLI/modeld/console 执行根，两者不得混称。
5. Host leaf 做双向归一化，保持 Effect-free、SDK-free。默认两处薄 patch；新增 patch 须按 ADR D2 有版本/收益/耦合/失效证据并获精确批准。没有所需 root/compact 事实就拒绝受影响能力，不编造接口。
6. 持久根仍为 `/workspace/.grokbox/box-runtime/`，live root 仍为 `~/.grokbox/run/`，CLI 安装仍为 `~/.grokbox/runtime/`。不迁走 Host store，不 prepend `store.db`；live 的 `GROKBOX_LIVE_PROMPT_*_CAP` unset。长期事实留给 Host Memory 蒸馏。
7. 本轮已进入实施。源码退场及旁支清理先核对语义与 dirty/untracked，保全可恢复引用/快照；不使用 reset/clean 强制抹除 WIP，不在源码树留 `old/` 墓地。主仓库 Git 数据、现役 fd/服务及用户数据不因 housekeeping 被删除。
8. **运行时 API：Node-portable。** Bun 只作 package manager 与本地 `bun test` / `bun run` / `bun scripts/*`；pin 仍为已声明的 `bun@1.3.14`，本规格不升 Bun/Node engines。published CLI/daemon、Host preload、modeld、CLI runtime、`runtime-kernel` 生产模块只用 Node-portable API，禁止 `import "bun:*"` 与 Bun globals（`Bun.file`、`Bun.serve` 等）。测试 runner 不得把 Bun-only API 泄漏进生产 import。盒上可以本地跑 Node 24；engines 下限仍是既有 Node 20+ 政策，本批次不改。

<a id="layout"></a>
## S2. 唯一目标树

### S2.1 包边界

锁定**一个新增私有包** `@grokbox/runtime-kernel`；保留私有 `@grokbox/box-runtime` 和 `@grokbox/cli`。不再增设 Host、backend、contracts、UI npm 包。npm 仍只发布 `grokbox`，`gbox` 仍是同一 binary alias。

| 包 | 唯一责任 | 不能放进去 |
|---|---|---|
| `packages/runtime-kernel` | 纯数据合同/选择规则；Effect-owned RouteBinding、STEP、控制用例、status 语义及 capability ports | Host 私有 ABI、SDK、fs/net/process 实现、CLI/HTTP/DOM、Live Layer 选择 |
| `packages/box-runtime` | Host leaf；Node/SDK adapters；modeld/CLI runtime/console 的资源装配；独立 guardian helpers | 第二 admission/控制决策器、另一份模型选择规则、私有产品 store writer |
| `packages/cli` | 参数/帮助/JSON 输出；意图交 runtime facade；later/T29-only roster bridge 才复用已有 Gateway 只读客户端 | runtime 配置读改写、adopt steps、模型 credential/provider 选择、status 推断 |

Effect 同 pin `4.0.0-beta.107`，kernel 与 box-runtime 使用现有 catalog。AI SDK `5.0.253` / OpenAI `2.0.125` 只留 box-runtime backend；不顺带升级 Bun `1.3.14`、Node 20+ 发布目标或测试框架。新私有包通过现有 `packages/*` workspace 发现并 bundled 进同一个发布包。生产模块的 Node-portable 禁令见 S1.8；`bun:*` / Bun globals 不是“开发便利可进 Host/modeld/kernel”的例外。

### S2.2 文件落点

以下为**最终必需骨架**，不是要求 T20 建空文件。注明后续票据的叶子到该票才创建；标 **later / T29-only** 的 `console/` 与 browser 资产不属 T20 骨架。小型 owner-private helper 可在同目录内增加，禁止自行增加另一层 `domain/application/services/utils`。顶层入口只显式导出本表规定的符号族。

```text
packages/runtime-kernel/
  package.json
  src/
    contract.ts                  # ./contract：纯 DTO/判别联合/校验器/预算，Effect-free
    hash.ts                      # ./hash：共享确定性 canonical JSON/SHA-256；无 IO/Effect
    selection.ts                 # ./selection：唯一配置解析与有效选择/修订计算，Effect-free
    ports.ts                     # ./ports：唯一 Effect capability Service 定义
    inference.ts                 # ./inference：runStep/cancelStep；唯一推理程序入口
    commands.ts                  # ./commands：配置、prepare、preview/apply/reconcile 用例
    status.ts                    # ./status：观察用例 + 唯一 facets projector
    monitor.ts                   # ./monitor：T41已挣得的纯采样/policy/freshness合同；无IO/SDK/SQL
    testing.ts                   # ./testing：仅测试准入的 Fake Layers/control barriers
    internal/
      contract/                  # context.ts, identity.ts, events.ts, errors.ts, status.ts, limits.ts
      selection/                 # models.ts, selection-revision.ts；不包含 IO/SDK
      inference/
        route-binding.ts         # TURN 选择/auth lifetime 与失效
        step-ledger.ts           # STEP/attempt 去重、容量、状态迁移
        step-program.ts          # admission → auth → provider → terminal/unknown
        stream-state.ts          # canonical event 校验、工具门禁、终态聚合
        overflow-recovery.ts     # T32：唯一一次恢复预算，不是独立循环
      commands/
        configuration.ts         # models/desired 用例；T29 加第二 writer 防覆盖
        controller-operation.ts  # T28：一个 confirmed operation program
        target-policy.ts         # 纯 target/preflight 判断，不另执行操作
        operation-state.ts       # 唯一控制状态/receipt 转移
        reconciliation.ts        # 只产生同一 operation 的意图，不另写进程
      status/
        projection.ts            # 六 facets，纯投影
      testing/
        fakes.ts                 # capability 替身；不复制 step/controller 程序
  test/
    selection.test.ts  route-binding.test.ts  step-ledger.test.ts
    backend-contract.test.ts  status-facets.test.ts  controller.test.ts
    overflow-recovery.test.ts

packages/box-runtime/
  package.json
  src/
    runtime.ts                   # ./runtime：命令/长期进程边界的窄 facade
    preload.ts                   # 唯一 Host bundle entry；绝不经 runtime.ts 导入
    internal/
      host/
        profile.ts               # 精确 profile/transform 纯规则
        compile-hook.ts          # CJS _compile 接缝
        self-identity.node.ts    # 仅当前 Host 自身身份，不引入全局 census
        selection.node.ts        # 有界 no-follow models 读取，调用 kernel/selection
        context-codec.ts         # Host ABI → ContextSnapshot/root 完整性
        compact.ts               # T32 资格后：调用 Host 自有 compact 的窄 delegate
        session.ts               # 原 Host session/executor 方法与同步 handle
        stream-codec.ts          # canonical events → Host fullStream/response/usage
        modeld-client.node.ts    # 唯一 Host IPC client；TURN 固定 service epoch
        terminal-journal.node.ts # J13：仅 Host terminal/rejection append
      wire/
        modeld-wire.ts           # 纯帧编解码；当前单版本 DTO 来自 kernel/contract
        modeld-probe.node.ts      # Host/observer/ensure 共享的有界只读 health，无 Effect/SDK
      modeld/
        server.node.ts           # Effect-owned listener/client/frame sink，不做 admission
      backends/
        registry.ts              # root 装配的有限 kind→实现表；不扫描/尝试 fallback
        ai-sdk.ts                # ModelBackend Live Layer；唯一 SDK stream 入口
        openai-prompt-adapter.ts              # Host snapshot → OpenAI Chat/Responses prompt
        openai-events.ts          # SDK event → canonical event；id/name 有界关联
        provider-error.ts         # 固定失败类/候选证据，不回传 raw body/Cause
        echo.ts                  # 显式 stub/echo 能力，同一 ModelBackend port
        pi-rpc.ts                # T30 通过 qualification 后才创建
        cursor-sdk.ts            # T31 通过 qualification 后才创建
      io/
        configuration.node.ts    # canonical 文件 read/write；不另定选择规则
        authority.node.ts        # committed/pending/disabled/unavailable 读证据
        credentials.node.ts      # scoped auth lease；值不离开 adapter 可信边界
        artifacts.node.ts        # protected stage/read-back/sync/publish/locks
        journal.node.ts          # 非 Host 事件 append；watchdog 唯一 compactor
        observation.node.ts      # config/进程/receipt 等只读快照
        provenance.node.ts       # 合同切片、整包 provenance 与安全 retention
      process/
        linux.node.ts            # census/inspect/signals，仅显式 ports
        launch.node.ts           # reviewed launch/env/preparation/wait 能力
        guardian.node.ts         # 独立 deadman acquire/release；不并入父 Fiber
        profile.node.ts          # profile authoring/read/验证 IO
        helpers/
          guardian-child.cjs  injector-hold.cjs  grokbox-temp-supervisor.cjs
      roots/
        layers.ts                # 显式选择 Live Layers；无全局实例/隐式 env resolve
        modeld.runtime.ts        # modeld run 及 prepare 的同一服务 scope
        command.runtime.ts       # CLI 一次性命令/foreground prepare
        controller.runtime.ts    # 长期 watchdog 与 confirmed operation ownership
        console.runtime.ts       # later / T29-only：HTTP/操作/borrowed-or-owned modeld lifetime；T20 不建
      console/                   # later / T29-only；T20 不建空目录、框架、假 API 或 Playwright
  test/
    architecture.test.ts  host-codec.test.ts  openai-prompt-adapter.test.ts
    host-session.test.ts  host-fullstream.test.ts  modeld-wire.test.ts
    modeld-lifecycle.test.ts  runtime-pipeline.test.ts  host-journal.test.ts
    controller-io.test.ts
    backend-conformance.test.ts  overflow-bridge.test.ts  diagnostics.test.ts
    # later / T29-only: console-api.test.ts console-state.test.ts console-browser.test.ts
    fixtures/                    # 自行编写 Host/profile/SDK/进程 fixtures，绝不放 provider dumps

packages/cli/src/commands/runtime.ts   # 只路由；不吸收当前未提交 WIP
packages/cli/src/commands/runtime-roster.ts # later / T29-only：既有 GatewayClient 的本盒只读 composition bridge
packages/cli/src/registry.ts           # 命令唯一 registry
packages/cli/src/program.ts            # dispatcher，只绑定 facade
scripts/check-runtime-boundaries.mjs   # T20：结构/import/export/退场检查；生产模块 bun:* / Bun globals 失败
scripts/pack-runtime-helpers.mjs       # 唯一打包清单，指向新 helpers/preload；later / T29-only 才加 browser
scripts/verify-runtime-rebuild.mjs     # T20 起维护：有限 case→真实测试命令映射
test/runtime-cli.test.ts               # 既有 CLI 集成测试位置，不另开 CLI test 树
test/packaging.test.ts                # 既有 Node20 发布验证位置
```

`contract.ts` 只转导 `internal/contract` 的纯声明/校验（含共享 identity/authority 判断）；不得从 Effect 模块 `export *`。仅 `hash.ts` 允许 `node:crypto` 的确定性 SHA-256；selection、Host 与 kernel 使用同一 canonical JSON/hash，不把通用 digest 藏在 model selector。除此之外 kernel 不导入 `node:*`、`bun:*`、环境或 wall-clock IO；Effect Clock/ports 提供时间和外部能力。未来 browser 只导入 `contract`，不导入 Node hash/selection；该约束属于 T29，不要求 T20 创建 browser。

`box-runtime` package exports 只有 `./runtime`；移除原 `.` mega barrel。preload 由 pack 脚本直接构建，Host 私有模块不是其它 package 的 API。kernel 只开放显式 subpath，不导出根 barrel、不开放 `internal/*`；后续配置/观测专题的新增边界以package exports与边界测试同步维护。T43/T53新增`./routines`，只承载原生Routine的纯输入/安全输出/校验，执行仍经既有`ports`与`commands`，不会把Gateway、原生存储或新的scheduler放进kernel。

<a id="imports"></a>
### S2.3 谁可以 import 谁

| Caller | 允许 | 禁止 |
|---|---|---|
| kernel contract | 同目录纯模块 | Effect、Node IO、Host/SDK、其它 package |
| kernel hash / selection | hash：仅确定性 crypto；selection：contract/hash 与自己的纯规则 | provider mapper/SDK、fs、env |
| kernel programs | contract、hash、selection、ports、Effect、同 owner 内部实现 | box-runtime、Live adapters、CLI/HTTP、runPromise |
| Host leaf | kernel `contract`/`hash`/`selection`、host 内部模块、纯 wire/有界 probe、最小 Node builtin | kernel Effect 入口/ports/testing、roots/io/process 全局实现、server、SDK |
| modeld server | contract/wire、注入的 inference public program/当前 Runtime | 选择/credential/复投策略、Host ABI、实例化另一 kernel |
| backend adapters | contract、ports、自己的 codec/auth 实现、所需 SDK | inference/commands/status 程序、Host/store/SendToUser、进程 mutator |
| Node IO/process | contract、ports 与被声明的纯规则 | 调用上层 use case、构造 Runtime、反向导入 roots |
| roots | kernel public programs/ports、Live adapters、有限 framework boundary | 在 wiring 里重写选择、admission、状态或恢复规则 |
| CLI | box-runtime `runtime`、kernel contract、CLI 输出/参数；仅 later/T29 roster bridge 可复用既有 GatewayClient/redaction | kernel internals、SDK、runtime 配置/模型 credential/adopt 决策；任意 Profile roster；`bun:*` / Bun globals |
| console API/browser（later / T29-only） | API：runtime-bound commands/status；browser：安全 contract + client/state | 原始Host store/SDK/ABI、第二业务程序、浏览器直连SQLite/通用exec；T20提前创建这些文件 |
| 生产 Host / modeld / CLI runtime / runtime-kernel | Node-portable APIs 与上表允许列 | `import "bun:*"`、`Bun.file` / `Bun.serve` 等 globals；把测试 runner 的 Bun API 当生产依赖 |
| 测试 | 所有者包内可测 private；跨包只走 public/testing 或真实进程入口 | 测试专用 admission、生产 Layer 偷用 Fake、绕过 SDK encode 证明请求保真 |

结构检查解析 import/export/require/dynamic import 和 package exports，追踪 re-export；测试必须证明故意加入 forbidden edge 会失败。preload 再检查实际 bundled bytes、external imports、import-time effects；仅“没有直接 import Effect”不够。不能只靠 tree shaking 掩盖错误依赖。

<a id="contracts"></a>
## S3. 核心合同与唯一事实 owner

### S3.1 数据与身份

- **ContextSnapshot**：version、profile/ABI identity、`systemMessages`（包含已解析 root，恰好一次）、`messages`（Host-selected 非 system 有序消息）、tools schema、options、snapshotDigest。system 不同时留在两个分区。没有 SDK session、可执行 tool、secret、store 引用；Host ABI 私有字段只由 `host/context-codec.ts` 读取。服务以同一 canonical hash 重算 snapshotDigest（排除 digest 字段），不信任 caller 自报值。
- **Selection**：`agentId + modelId + selectionRevision`；共享算法对该 Bot 的有效配置规范化后 SHA-256，覆盖 backend/provider/model、endpoint、credential reference 身份、capabilities/codec/limits。排序 object keys，不排序 messages/tools 等语义数组。无关 Bot 的修改不改变此 revision；不含 credential 值，也不把 configRevision 当 selectionRevision。
- **HostEpoch**：compile/source/profile/稳定 Host 身份及 adoption identity，并绑定实际加载的 bridge artifact digest/wire version；**ServiceEpoch**：modeld 本次 incarnation。**TURN** 使用 Host `sessionOptions.invocationId`，**STEP** 使用 executor `stream` 的 invocationId；不得互相回退。内核 ledger key 为 `(HostEpoch, agentId, TURN, STEP)`，binding key 为 `(HostEpoch, agentId, TURN, ServiceEpoch)`。
- **RouteBinding**：服务内部不可变 Selection + resolved config + auth fingerprint/lease + bindingId；不是可写配置。Host 只保留 modelId/revision、固定 ServiceEpoch 与 opaque bindingId，不拿 resolved credential 或 canonical activation。
- **Attempt**：同 STEP 内部 attempt=0；T32 才可增加一次 attempt=1。attempt 不伪装成新的 Host STEP。不向客户端承诺跨服务重启续传或 exactly-once。
- **PreparedCall / AuthLease**：定义在 `ports.ts` 的进程内 opaque handle，**不是 `contract.ts` 的 JSON DTO**。prepare 产物包含安全 size/capability 摘要与 adapter 私有的已编码输入；auth lease 只给受控 backend 使用。不能 stringify/写 wire/日志，不能暴露 SDK 类型。infer 消费同一 prepare 产物，不再重选/裁剪上下文。
- **StepOutcome**：身份、是否开始 dispatch、terminal/unknown、finish reason、usage availability、已放行工具/文本计数、gap；不携完整 output 数组。完整响应由 Host stream reducer 在内存聚合。
- **InferenceEvent**：owned discriminants `text_delta`、`reasoning_delta`、`tool_start`、`tool_delta`、`tool_complete`、`backend_finish`。最后一项只由 stream-state 消费为 outcome，不作为第二个 wire finish 转发；SDK error event 转 typed BackendFailure。wire terminal 唯一，Host reshape 才生成原 ABI 的一次 finish/response。

<a id="ports"></a>
### S3.2 Ports：名称就是合同，不再加同义 Promise interface

这些 Effect Service 的定义统一在 `kernel/ports.ts`；具体实现位置固定如下。名称/操作是边界合同，不要求逐 helper 生成 Service。

| Port / public program | 合同与实现位置 | 禁止 caller / 行为 |
|---|---|---|
| `ConfigurationRead` | 读一次 canonical models/desired 的有界快照；`io/configuration.node.ts`。parser/选择规则只在 kernel selection | inference 不能写配置；Host 不调用这个 Effect Service |
| `ConfigurationWrite` | 为 commands 保存 canonical 文件，返回 source receipt；同一 IO 文件实现，modeld root 不提供此能力 | UI/CLI 不直写；第二 writer 出现前不建通用 CAS 服务 |
| `AdmissionAuthority` | 当前 committed/pending/disabled/unavailable、Host identity、inhibit/recovery 证据；`io/authority.node.ts` | caller 自报 committed、health 或旧日志不能替代权威 |
| `BackendAuth` | `pin` 在 TURN scope materialize；`verify` 在后续出门前核对原身份；返回 opaque lease + 安全 fingerprint；`io/credentials.node.ts` | secret 不进入 contract/wire/status/journal；不 mid-turn remint/换账号 |
| `ModelBackend` | 纯 `prepare(selection, snapshot)` 验证/编码为 PreparedCall（零 auth/网络）；`infer(admittedCall, prepared, authLease)` 为**一个**有界 canonical event Stream + typed failure。实现 ai-sdk/显式 echo/测试 Fake，后来合格 pi/Cursor | 不执行 tools、不自循环/重试、不读取隐藏 history；不得导入 kernel 程序 |
| `RuntimeEvents` | append 受名称/角色约束的安全观察，失败返回 evidence gap；`io/journal.node.ts` | 不从事件行驱动重试、不得代写 Host `model_step_terminal` |
| `ModeldControl` | commands.prepare 请求 ensure；`roots/modeld.runtime.ts` 的 process-owned lifecycle facade 使用共享 probe/唯一 server 返回 owned-or-borrowed receipt，无新 Runtime | status/GET/backend 不可调用 ensure；stop 只由 owning root 收尾，不开放通用进程控制 |
| `ControlResources` | lease/artifact、精确 process/launch/guardian 与 waits；由 io/process adapters 组合提供 | 只有 controller operation 消费写能力；observer/modeld/HTTP 无 signals |
| `ObservationRead` | 同源 config/attestation/进程/服务/事件等只读观察；`io/observation.node.ts` | 不 repair、compact 日志、关闭 circuit 或发模型请求 |
| `runStep` / `cancelStep` | `kernel/inference.ts`：唯一 admission/ledger/producer 程序；event sink 是请求内 Effect 能力，结果为 StepOutcome | 只能 server/test public consumer 调用；backend 不回调此程序 |
| `commands` | `kernel/commands.ts`：models/use/reset、desired、prepare、preview/confirmed apply/reconcile | CLI/API 不重新组合这些业务步骤 |
| `status` | `kernel/status.ts`：ObservationRead → 六 facets；任何环境同一 projector | 没证据不能“最近一次成功=现在健康” |
| `HostSeamCodec` | `host/context-codec.ts` + `host/stream-codec.ts` 的普通 TS 函数，session 是唯一调用面 | kernel 不认识 PromptSession 私有字段；不是第二个 ModelBackend |
| `HostCompact`（T32既有；S12演进） | `ports.ts` 定义Host维护capability，已有当前STEP同连接snapshot恢复；S12扩展为root/operation限定的inspect/prepare/accept/readback，Host实际writer不变 | 仅kernel统一维护程序消费；CLI只提交具名维护用例，backend/monitor无root写权，不暴露通用RPC或保留第二compact executor |

Auth lease 只在同进程受信任适配边界使用，backend 的 unseal 能力由 root 装配，不用全局 secret registry。验证与 SDK 使用同一已 pin 身份；读取发生变化就拒绝，不拿新的值继续旧 TURN。新 backend 的 auth 差异封装在同一能力后，不强塞 HTTP key 假设。

<a id="config"></a>
### S3.3 配置与第二 writer

保留当前 canonical models/desired 文档的单一格式与路径；不因物理切割强制迁移数据。`provider` 的既有 OpenAI 模式属于产品协议选择，不是旧/新 kernel 分支。`stub/echo` 可保留为**明确选择的无网络 backend**，必须走同一 admission/stream/terminal port；不能当默认异常 fallback、假健康或第二 test executor。

T23 将 provider allowlist/能力描述收回 kernel 的有限数据规则，解除 `models.ts → modeld-openai-map.ts` 反向依赖。root 在 `backends/registry.ts` 装配有限 kind→ModelBackend 实现表，精确查找，未知 kind 拒绝；不是 accepts 扫描、轮流尝试或另一 admission registry。AI SDK Chat/Responses 共用 CCS codec；删掉仅测试走 raw messages、生产走另一编码器的双轨。新 backend 需要的 schema 变化由 T30/T31 在同一 parser 更新；若必须换格式，使用显式一次性离线转换，不留双 parser，也不删除原始用户数据。

当前单 writer 只做 schema/gate、unique protected stage、read-back/sync/rename 和回执。真实第二 writer（未来 WebUI 或其它）出现时，在**同一入口**加短锁 → canonical 重读 → expected configRevision → mutation/publish；CLI 同时接入，不另建 UI-only lock。`configRevision` 用 canonical 内容摘要即可，不建 revision DB/projection 文件族。锁防合作 writer 的丢更新，不宣称对任意外部编辑器的原子 CAS。该 CAS 属于 T29 合同，不是 T20–T28 的默认施工项。

<a id="chain"></a>
## S4. 一条完整执行链

```text
Host queue/root/compact
 → patched createSession → selective gate → Host session/executor
 → Host-selected ContextSnapshot + thin Selection + STEP
 → Host IPC client（TURN 固定 ServiceEpoch）
 → modeld 当前版本 server（Phase 1 v3，T32 后 v4）→ kernel.runStep
 → authority + expected-selection + snapshot/capacity 检查
 → ModelBackend.prepare（纯 codec/能力/大小预检）
 → TURN RouteBinding/auth lease → 单个 ModelBackend.infer Stream
 → canonical stream-state → bounded wire events + terminal
 → Host stream-codec / 同步 fullStream handle / independent response+usage
 → Host tool loop / session-store / Transcript / SendToUser / Memory
```

1. compile/profile 不匹配不注入。非 route、非 ordinary main、未配置 `assignments.agents[agentId]`，按对象身份返回 `originalSession`。main 不是 per-agent fallback。T11 的 createSession 前置本地失败仍可官方 passthrough；一旦创建 managed session，任何失败都可见，不能重新走官方。
2. Host session 构造时抓住有界选择字段，与同步 `getModelId()` 一致。context-codec 接收 Host 已选 state/root/tools，不读 store.db。每个批准 profile 证明 root 的来源和恰好一次；未知不能当空。
3. `stream(ctx, STEP, tools, options)` **同步**返回原 handle。一个 eager producer 开始 IPC；response/usage 不从 fullStream tee 取数据。首个 health 的 ServiceEpoch 缓存于 TURN，不是每个 STEP 重握手。
4. server 只 decode/限流/关联 sink。kernel 先验证 Host authority、配置 opt-in、expected selection、内容、重复及 snapshot/codec 预算；ModelBackend.prepare 不能解析 auth 或发请求。所有 request-specific auth/provider effects 在这些检查后。snapshot/selection hash 使用规范编码；错误 body 不参与身份建立。
5. ledger 在首次等待前占位；每 TURN 最多一个 active STEP（工具并行不是 STEP 并发）。并发不同 STEP 返回 `turn_busy`，重复同 STEP 不启动第二 producer。首个 accepted frame 交回 bindingId；后续 STEP 必须借用它。ack 丢失不授权重新首绑。
6. TURN scope 拥有 config/auth pin；STEP scope 只拥有本次 provider/emit 资源。STEP 取消不会释放并重新选择 TURN；不确定效果可 poison TURN 并明确拒绝后续。普通配置保存只影响新 TURN；generation/deactivation/auth 身份失效可拒绝继续。
7. credential/等待后，在 dispatch 前复核 authority、同一 pin 身份和取消；第一次 STEP 校验选择仍相符。后续 STEP 不因 canonical 选择更新偷偷切模型，也不把无关 Bot 保存判为失效。BackendAuth/SDK 都无隐式 retry。
8. ModelBackend 仅跑一次推理。kernel 消费它一次，把 event 通过一个有界 sink 送给 transport；观测者不能再次求值 cold Stream。canonical validator 校验工具 id/name/参数、sequence、terminal 和预算。
9. 支持流式的 Provider 在 terminal 前即可抵达 Host fullStream。wire terminal 不重带 parts/output；Host reducer 聚合 messages/usage，完成 promises 与 UI reader 进度分离。声明 buffered 的 backend 仍提供同一合同，不另开 complete-only API。
10. Host 再执行工具/SendToUser 并提供下一 STEP 的 selected context。runtime 不自动 append assistant 到 Host history、不代执行 tools。Host normalized terminal 写 J13；provider finish 不等于 Host 交付，更不等于 App 显示。

<a id="binding"></a>
### S4.1 STEP、重复与退休

状态只有 `reserved → admitted → running → terminal`，另有吸收态 `unknown/refused`；实际模型 attempt outcome 与 Host-delivery evidence 分开。每条状态判断使用结构化 tag/code，不从 error.message 分类。

ledger 只保留摘要/身份/有界 outcome，不保留完整 snapshot、PreparedCall、SDK stream 或 output。STEP 结束释放这些 payload 与热 ledger 记录，精确身份摘要由 `ExecutionHistory` 保留。生产 root 使用独占锁的 LevelDB adapter，不能在 IO 失败后回退内存测试实现；每次新 service incarnation 在监听前退休旧代索引。运行期 auth lease 仅由 TURN scope 持有，冷存储不含 lease 或密钥，资源重获必须验证原 fingerprint。Host client 的 TURN 表只保留薄 binding/拒绝事实，不全局持有所有 session/response/replay；handle 自身的有界 reader 缓存由 Host 持有引用的生命周期管理。

- 相同 key + 相同 snapshot/selection：新 submit 返回 bounded `duplicate`/原 outcome metadata，**不返回可执行工具或完整流重放**。同 key 改 payload 为 conflict；缺 STEP 不能用 TURN、lastHandle 或最近请求补齐。
- 同一个已返回的 Host handle 支持多 reader 游标；另一次 `stream()` 不获取该 handle 的 executable replay。多个 reader 不代表多个 Agent/tool executor。
- client EOF/abort、request timeout、stop：先记确定的拒绝或 unknown，再取消 owned work。后到 success/tool chunks 丢弃；不能从 EOF 合成 finish-success。
- TURN 空闲只触发冷存储和凭据资源释放，不再自动 expiry。后续 STEP 恢复原 binding、resolved model、selectionRevision、ownership 与 credential fingerprint，不能因为 cache miss 新绑或换模型；显式已失效/poisoned 身份仍拒绝。service restart 后旧 TURN 携旧 ServiceEpoch 被拒绝；Host leaf 不重握旧 TURN。新 TURN 才可以选择新服务代。
- 有界 tombstones 保留到已证明 Host epoch 退场；满额显式 capacity，不 LRU 驱逐再重投。没有可靠 turn-close 就不发明它；持续运行超过限额须有单独退休/soak 证明，不阻塞最初 binding 切片。

<a id="wire"></a>
### S4.2 Phase 1 v3 wire 与初始资源预算

**当前收口为 v5（2026-09-16）**：错误帧增加纯 kernel `FailureSummary`，另有有序恢复进度控制帧；成功/工具事件仍严格校验。v4 只用于显式运维替换的有限只读身份/容量核验，不能被新 Host 用来执行 STEP。Host/modeld/profile-bound caller 成套切换；同代错误摘要必须匹配 Agent/TURN/STEP/service/Host/binding，摘要缺失或损坏仅降低诊断、不改写原失败。`provider-recovery` 是原 kernel STEP 的可选执行程序，不在 SDK/backend、monitor 或另一个 Runtime 中重试：显式许可且未发布有意义输出/工具材料的429（非额度）/502/503/504，按本 STEP 额外请求与时间预算恢复；同 snapshot/选择/凭据/ownership 复核、独立持久 attempt 声明及结算、可取消等待、一次终态放行。持久错误、流结构错误及已有输出不会授权重放；服务重启不复活旧请求。配置和观测语义见维护文档。

以下为阶段谱系，不是当前同时接受多个协议的声明。**Phase 1 只接受 v3**；请求包含 version，有限类型为 health、run-step、cancel-step。T32 将同一当前 wire 一次性升级至 v4，以支持当前 STEP-scoped HostCompact 能力的同连接 recovery 往返；不维护 v3/v4 并行 server。旧版本明确拒绝，无 feature negotiation 降级、旧 complete codec 或兼容 server。健康探测不读取模型凭据、不验证 activation，也不因旧协议不响应就删除其 socket。

**T40当前v4服务复用补充（2026-09-13）：** 新增显式只读`service-info`，请求只含method/version，返回serverGeneration和rootId（durableRoot+runRoot规范化路径摘要，未知为null）。普通health响应不增加字段，保持旧调用语义。ensure/start在borrow前必须匹配rootId；不匹配或旧服务不支持时拒绝，不终止原服务、不重写配置或删socket。此声明只解决连接到错误配置根的问题，不是操作系统进程身份证明、所有权租约或生产准入。别名/目录重定位和重启仍需重新查证，不宣称瞬时无竞态。

socket/root 权限为 0600/0700。compile binding 是运行时事实核对，不宣称对恶意同 UID 进程的 peer authentication；console 也不提供 raw inference RPC。

run-step 请求携 HostEpoch/agent/TURN/STEP、expected ServiceEpoch/Selection、snapshot，以及后续 STEP 的 bindingId。响应按 accepted → event(sequence, canonical event) → terminal(outcome)；每连接一个请求，exact keys 和严格 UTF-8。cancel 精确指向原 tuple，不取消下一 STEP。

预算唯一落点为 `kernel/internal/contract/limits.ts`，开销超限明确拒绝/终止，绝不截断上下文：

| 预算 | 初始值 / 行为 |
|---|---|
| 配置读取 | 128 KiB，有界 no-follow regular-file reader |
| snapshot JSON / encoded provider request / wire frame | 4 MiB / 8 MiB / 8 MiB；分别计算实际 bytes，frame header 4 bytes 不计入 payload |
| canonical output 与 Host replay | 每 STEP 默认 1 MiB 语义 UTF-8 输出；重复帧头与同工具最终参数不重复收费，不以累计分片数限制生产流。replay 与工具参数按固定存储块合并，另设 8 MiB 表示存储估算保护；块大小为分配目标，不是执行额度。terminal 留独立有界结算空间，预算失败记录 layer/metric/limit/measured，原始事件数和传输字节只作观测 |
| server active clients / active STEP | 各最多 64；同 TURN 一次；超额 busy/capacity |
| 单进程 retained payload 总预算 | 128 MiB，所有 incoming/request/queued-output 缓存按实际 bytes 计入；分配/增长前预留，耗尽拒绝新 work，不能靠每连接各自有界隐藏总量 |
| admission wait / partial socket / request wall deadline | S10 已移除历史10.5 s复合准入计时器；资格检查共享每STEP累计10 s，partial socket仍1 s，整个STEP共用入口180 s期限，accepted不续期。证据从原始请求开始计龄，最大5 s；跨STEP缓存2 s，同一已认领STEP按S10.4复用仍合格的原始证据，不刷新时间起点 |
| TURN cache / execution history | 无累计 STEP 配额；空闲 5 min 是资源冷存储条件，不是续步期限。热 TURN 软目标按活跃容量设置；精确去重摘要落磁盘，claim 持久后才 dispatch。测试包含小缓存、长期 STEP、冷恢复及存储失败 |
| owned shutdown | 默认 2 s cleanup budget；超时关闭本地 transport、记录 unknown/cleanup gap，不等待外部模型永远结束 |

这些是安全资源预算，不是 model context window/token 准确值或 SLA；不得以它们造 `overflow_confirmed`。snapshot/codec 预检在 auth 前；SDK 最终 HTTP body 的实际 bytes 再在 transport egress 前核对，超限零 provider request，不谎称此时凭据尚未读取。模型 token 限额无可信来源时为 unknown，不按名字猜测。buffer/queue 的各份内存都计量，不能另留无界 terminal.parts、全量 pending chunks 或隐藏 replay。

<a id="host-output"></a>
### S4.3 Host 输出合同

`host/session.ts` 提供 `getModelId`、`getExecutor`、`getExecutorWithoutResolvedModelTracking`；executor 提供 append/clear/getMessages/getState/stream。getter 为独立 Array，append 不执行函数，非法输入显式失败。原 ABI 需要的 `extendedUsage/providerMetadata/invocationId` promises 也必须存在。

`host/stream-codec.ts` 是唯一 Host reshape：text/reasoning、tool start/delta/complete、finish/response、camelCase usage 与 modelId 一致。删除内部 `toolCalls` 别名和多套 response normalizer；canonical events 不是 Host `StreamPart` 类型换名。保留已验证 Host wire 字段，不能为了“去兼容”删掉上游真正消费的字段。

工具按调用 id 关联，名字必须属于该 snapshot 的工具声明（Host 最终授权不变），不能缺失后补通用名。生产 `validated-batch` 支持多个调用及交错参数流，参数完成顺序不改变首次出现的调用顺序；冲突重复、坏 JSON/未知形状明确拒绝。整个成功批次通过前不释放任何工具 start/delta/complete；相同 complete 去重，任意一处错误拒绝全批次。显式单调用消费者仍可拒绝多调用，但不是 managed 生产策略。已在先前 STEP 释放的工具及提交后 Host 的执行结果不可伪称回滚或零副作用。

slow/late/no reader 不阻塞 producer completion；超出有界缓存须明确 failure/gap，不能丢一部分然后成功。关闭一个 reader 只退订它；Host abort 才取消本次模型。真实 usage 缺失在 canonical/status 中为 unavailable；ABI 必须数字时只用声明过的 unknown 投影，不拿 1/1/2 或 cache=0 当真实账单。

## S5. Effect 根、控制与证据

<a id="effect-root"></a>
### S5.1 Lifetime

```text
grokbox process Scope / 唯一 ManagedRuntime（framework callbacks 需要时）
 ├─ owned modeld listener / accepted clients
 ├─ TURN scopes：binding/auth lease（不挂首 STEP scope）
 │    └─ STEP scopes：backend stream、验证、emit、deadline
 ├─ controller operation scopes：lease → preflight → guardian → signals/wait → commit/recovery
 └─ console HTTP / 观察订阅（later / T29-only；无 provider 请求的初始化；T20 不建）
```

资源有 allocation 时即配对 finalizer，成功返回前保证 ownership 注册；必须覆盖 `bind` 未完成时 interruption、listen 后后续步骤失败、late callback、stop 重入。不能 `tryPromise(bindUnixKernel)` 完成后才 addFinalizer，也不能全流程 uninterruptible。Node syscall 可以是窄 Promise adapter，业务程序不能藏回 Promise/timer 链。

停止先拒绝新 work，再结算/取消，最后释放 owned resources。不能移动/替换竞争 socket 来“恢复”它；底层 close 对 pathname 的实际影响必须在 Node20 disposable fixture 证明，无法证明安全就阻塞 A9，而非放宽所有权。取消结果不是 provider 已撤销的证明。释放失败记录安全 cleanup gap；禁止吞掉后声称完全释放。

`runtime modeld run`、`runtime start` 的 ensure 与 console 都使用同一 `modeld.runtime.ts`。已有服务是 borrowed，不拥有 stop 权；prepare 若本进程新建服务，CLI 打印 receipt 后持有实际foreground root，直到signal或自身服务终止，不悄悄detach另一daemon。`StartedModeld.finished`在真实Scope清理后结算，listener非预期close/error必须传到命令失败，不能保留一个等待下次用户signal的空服务；正常取消不误报自身释放事件。browser关页只退订，不结束process/已确认operation。

当前`command.runtime.ts`用Effect Scope把route配置预检、root-qualified acquire、唯一配置保存、未确认reconcile、status/output和前台lifetime合成一个命令程序；CLI仅组装signal/root/输出。开始写出的canonical desired不因后续失败自动回滚，取消不能遗留脱离Scope的写入；cleanup_gap不得吞成正常退出。`configRevision`与reconciliation/status分别说明保存和观测，`productionAccepted:false`、不安装自启、不触发adopt仍明确。source CLI/Unix和实际Node制品的start/borrow/orderly-restart现已有有界证明；不把它升级为安装自启、真实凭据推理或当前Host/App上线资格，实现/离线结果归T40，当前现场缺口与回执链接归 [LIVE](../tickets/LIVE-integration-validation.md#live-runtime-persistence)。

<a id="controller"></a>
### S5.2 一个 Controller operation program

T28 将现有 coordinator/adopt/identity 编排收进 `kernel/internal/commands/controller-operation.ts`，用 ControlResources 做 IO。入口都是同一程序：只读 preview；无授权 reconcile 只观察/写已允许意图；`runtime re-adopt --confirm` 或一次 console 确认才提供 mutation capability。未来自动 reconciliation 不获得本次隐式授权。

不可省略 lease → exact ownership/source/profile/compile/topology/gateway/launch 预检 → 首信号前复核 → independent guardian → 精确 signal/spawn/wait → attestation/journal read-back → receipt/recovery。保留 direct-launch 与 transient-adopt **两种真实 launch capability**，但只在同一个 operation state machine 中作有限策略选择，不维护两套 coordinator。无 LegacyWitness、optional unsafe defaults、第二 manual mutator 或旁路 heal。

guardian 仍是独立进程，只对精确 frozen wrapper 幂等 SIGCONT；不是随父进程死亡的 Fiber，不 kill/start/retry。禁止对官方/竞争进程兜底 SIGKILL。日志/签字 IO 失败不能伪造回滚；确认时的 target drift、PID reuse、Gateway 未发布均不能报告成功。

<a id="status-journal"></a>
### S5.3 T13 与 J13

T27 在 Phase 1 开始、无需等待真流/UI，就提供唯一 status DTO：`schemaVersion`、各项 source/observedAt/gap 与六个独立 facets：bridge/activation、modeld readiness、controller liveness、mutation permission/inhibit、operation recovery、Host delivery observation。移除旧 `watchdog.state=degraded` 聚合口径，而不是同时输出新旧解释；circuit 自身事实继续保留。

| 输入证据 | 必须输出 | 不能推导 |
|---|---|---|
| 当前 attested、stored circuit open、无 pending | bridge 有证据 + mutation inhibited；liveness 无证据则 unknown | “全部 degraded”或清 circuit 后绿色 |
| journal pending/invalid/unavailable | recovery-required/unknown，指明来源 | 旧 attestation 覆盖恢复问题 |
| modeld health成功 / service-info确权 | health只证可响应；真实status按当前数据根输出scope与serviceEpoch，matched才ready、mismatch为false、缺证为null | Host已签字、controller alive、provider可付费或Bot有执行权 |
| model terminal / Host normalized terminal | 对应阶段的事实 | SendToUser 已执行/App 已显示 |
| 缺事件/截断/不支持旧记录 | missing/partial/gap | 没有发生过调用 |

J13 **不迁移**：Host 的 `terminal-journal.node.ts` 唯一写 Host normalization/rejection 事实；modeld 写自己的 invocation/provider 观察，controller 写控制观察；watchdog 是同一事件日志的唯一 compactor。共享纯格式/allowlist 不等于共享写权限。旧记录留在原数据根，不能删除历史来达成 single-track；不支持的历史 schema 报 gap，不猜补字段。

所有 STEP/inference 事件从本地已验证 tuple 关联 Host/agent/TURN/STEP/ServiceEpoch/binding/attempt；控制事件关联其 operation/target，不伪造 STEP。不从 provider body、最近时间戳或 UI cache 构造因果。Host append 可缺 service/binding 证据时明确 unknown，不造值。日志失败只影响证据，不阻塞 Host 回复或触发重跑。J13 的 Host-side IO 仍是已记录的有限例外，不能顺带在 Host 加 Effect。

## S6. 后续表面仍只有一个内核

<a id="webui"></a>
### S6.1 T29 内核/API 边界（默认主链外）

T29浏览器仍暂缓；[T41](../tickets/T41-continuous-observation-and-alerting.md)在UI之前建设持续观测，合同见[S0.1.4](#continuous-observation)。当前交付顺序见S0.5，不重做历史Phase 1。未来UI不得另写下列边界：

- CLI 与未来 API 只调用同一 `commands` / `status`；不得出现第二套业务程序、admission 或 controller。
- `ConfigurationWrite` 是唯一配置写 port。单 writer 阶段不做通用 CAS；真实第二 writer 出现时按 S3.3 在同一入口加短锁 CAS，CLI 同时接入，禁止UI-only lock或SQLite配置/执行SoT；T41的本地观测及incident存储是独立允许范围。
- 命令边界绑定本盒 runtime root 与 agentId；拒绝任意 current Profile 拼接或远程 Profile。身份不明不保存。GET/只读观察零 write、零 signal、零模型 spend。
- `console/`、`console.runtime.ts`、roster bridge 与 browser 资产均为 **later / T29-only**；T20 不建空目录、假 API 或 Playwright。

未来页面/会话认证/真实浏览器验收的唯一详细路线在[future/webui-console](future/webui-console.md)，[T29](../tickets/T29-runtime-webui.md)承接实施门。只读快照/事件复用T41，页面关闭不停止collector；单盒查看/能力配置与多盒future分开。这里不提前建立console骨架。

<a id="backends"></a>
### S6.2 T30/T31 backend

pi RPC、Cursor SDK 各自独立 qualification；在证明前只有票据/测试要求，没有假 adapter 文件。具体协议/package/版本、运行面与权限须源证据固定；不从名称猜 API。不能提供一次显式 snapshot 的 inference-only 能力就 blocked/deferred，不把完整 Agent 的最终 string 当 ModelBackend。

复用同一 ModelBackend/BackendAuth/STEP 程序。无隐藏 root/history/Memory、tools execution、auto-compact、retry/failover、仓库修改或后台 Agent loop。native session 是 backend 私有 scoped resource，不是 Host TURN；默认不跨 Bot/turn 复用有状态 session。通过共同事件/取消/auth/usage conformance 后才接有限配置选项。不可阻塞其它 backend 或 T32。

<a id="recovery-diagnostics"></a>
<a id="pi-ai-qualification"></a>
### S6.2.1 进程内 pi-ai 资格（独立规划，不是CTX前置）

[PI-AI-01](../tickets/PI-AI-01-model-backend-qualification.md)评估直接库 `@earendil-works/pi-ai` 能否实现现有ModelBackend，减少provider适配维护；不是T30的Pi Agent RPC，也不要求把Agent/Session搬入Host。当前生产仍是AI SDK；本节不宣布替换获准或多backend同时真实运行。CTX使用core算法可以保留AI SDK传输；core依赖中出现pi-ai代码也不表示其Provider执行路径已被采纳。

候选实现唯一位置 `box-runtime/src/internal/backends/pi-ai.ts`，资格数据使用现有backends共同合同，不向kernel/Host/CLI导出Pi类型。复用现有BackendAuth提供冻结credential，限制Provider注册/数据，禁用ambient认证/用户Pi目录/自动目录刷新/OAuth副作用和库内额外retry；任何真实请求都经过同一预算/审计/取消边界。必须核对具体Provider是否支持fetch注入，未知不能靠通用接口声明推断。不得为了支持Pi更改endpoint/API/wire model、静默clamp reasoning档位、丢工具或改usage会计。

离线比较按同一合成Chat/Responses输入分别运行两个adapter，独立记录实际HTTP/body/stream/events/终态和真实调用次数；对照不是生产shadow双发。覆盖当前qualified dialect（含MiniMax）、thinking/effort/工具配对、usage/cache/reasoning、畸形流/空输出、错误分类、字节/token门、未知响应和取消迟到。现有pre-output/overflow恢复由kernel唯一拥有，candidate不因替库扩大副作用。Node/ESM/依赖与真实制品门同S12.0，升级最低运行版本必须明确决策。

资格出口为source-bound adopt/propose-changes/reject或blocked报告：说明节省/新增的维护差异与未证项。`pi-ai-backend` verifier及 `backend-pi-ai-conformance.test.ts` 均待实现。即使离线通过，默认切换、模型范围和移除AI SDK必须另行批准并修改同一registry/部署门；未决定时保留现有生产，不自动在失败时切回/切出candidate。只有最终批准的live Provider/Host/App采用进入对应LIVE条目，源码/打包/无网络资格不能移为live-only。

### S6.3 T32/T33 recovery / diagnostics

本节限制的是**失败后额外模型请求**，不是所有compact的触发条件。默认本地preflight、旧会话下一消息、空闲手动与目标预算的当前新增施工归[S12](#context-maintenance)；T32复用它的Host维护能力而不另建摘要器。

T32 仅在 typed 当前 attempt outcome + 合格 provider-specific 非冲突证据确认 context overflow，且原 attempt 已 terminal、**没有已释放 executable tools/用户可见内容**时请求 Host 自有 compact。attempt 结束不等于 Host STEP 已结束：先将失败保留在 kernel 内，不能先发 error bubble/STEP terminal 再恢复。

v4 在原 run-step 连接增加一个 server `compact-request`（原 tuple、一次性 recovery nonce、期限与可信目标预算）及 client `resume-step`（原 tuple/nonce、新 snapshot）。Host IPC client 将控制帧交给 `host/compact.ts` 的已批准 Host delegate，不投影成 assistant/tool event；delegate 使用 Host 选上下文，不能自己总结。server 只接受当前连接匹配、未消费且未过期的 nonce；拒绝其它追加请求/旧代/重复回复。重新验证原 binding/authority/snapshot 后同一 ledger 执行 attempt=1，最终才产生唯一 Host STEP terminal。v4 caller/profile/bridge digest 同票切换，旧 v3 拒绝，不留双版本。

compact seam 必须证明能在这个 Host 挂起点调用、不会与等待中的 Host loop 死锁；未知时拒绝，不编造 callback 能力。auth/429/generic 400/500/HTTP too-large/timeout/unknown、取消、无改善、二次失败均停止，零额外 compact/retry。候选日志不是命令；无匹配字段时拒绝，不能从 body 捞 id。T32 不等待所有 T30/T31 或完整 UI。 **Wait-point / first-request overflow live close is [T35](../tickets/T35-host-compact-wait-point.md)** (implementation authorized under S0; live qualification remains gated). Composer `currentActivity` App residual is [T36](../tickets/T36-composer-working-activity.md), not a T32 substitute.

T33 扩充只读 source-scoped retention/cursor/gap、operation/交付观察。只有可核对来源/代/序列的 Host 能力才提供 publish watermark；否则 not_observed。缺记录、模型 finish、Gateway PID 不成为 App delivery 证明，不驱动 SendToUser/model replay、re-adopt 或游标写入。

<a id="delete"></a>
## S7. POC 退场清单

以下源路径均相对 `packages/box-runtime/src/`。只保留经过断言证明的性质；不是把整文件包一层、重命名为 service 后宣布完成。旧文件及根 `index.ts` 在 T20 撤销入口后不留 re-export；重建所需向量转移到新测试，历史 done 票据不改状态。

| POC 来源 | 目标 / 处置与截止票据 |
|---|---|
| `index.ts` | **删除** mega exports；CLI/test 改显式入口，T20 不留 alias |
| `modeld.ts`, `modeld-as1.ts`, `modeld-default.ts` | 旧执行器/complete-array/As1GeneratePort **不搬**；由 T23/T24 新 ports/program 替代。显式 echo 只重写成一个 ModelBackend；旧 accepts 扫描/composite/default factories 与 stub kernel 不保留 |
| `seam.ts`, `session.ts`, `replay-stream.ts`, `abort-signals.ts` | Host ABI/有界 reader 性质保留到 host/session 与 stream-codec；旧 StubRouteDriver、submit/stream/parts 三分支、response-only、40ms delay、requireStepId=false、toolCalls 别名、fixture usage **不搬**。T26 出口无内部 PromptSession shim |
| `envelope.ts` | 纯 ContextSnapshot 校验 → kernel contract；Host 私有字段 decode → host/context-codec；T21 丢弃静默解封/丢结果途径，不能保留第二 envelope SoT |
| `modeld-openai.ts`, `modeld-openai-map.ts` | T21/T23 转为 openai-prompt-adapter/openai-events/ai-sdk；raw messages 测试旁路、关键词 drop、preview 截断、SDK 错误正文、silent tool schema catch/continue **删除** |
| `models.ts` | 分到 kernel selection/config commands、io/configuration、host/selection.node；main fallback、misnamed stub-only guards、provider mapper 反向 import **删除**，T24 无第二 resolver |
| `modeld-binding.ts` | compile identity 合同 → kernel contract；Host 自身构造 → host；不把 HostBinding 与 RouteBinding 混为一物 |
| `modeld-ipc.ts`, `modeld-serve.ts` | T20 拆掉混合模块；T25 v3 wire/server、Host 独立 client。`callStubModeld`、v2 server、terminal.parts、晚注册 finalizer、竞争 socket 搬移还原逻辑 **不搬** |
| `modeld-credentials.ts`, `modeld-store.ts` | C1 no-follow/fingerprint 性质转到 credentials/authority/config adapters；逐 helper runPromise、默认 process.env/默认 live ports 混注 **不搬**，T23/T25 |
| `provider-overflow.ts` | backends/provider-error + T32 classifier；raw snippet、401 与 overflow 非互斥/只靠 message 匹配的恢复权威 **不搬** |
| `events.ts`, `observation.ts`, `observe.ts`, `coordinator-state.ts` | 纯 DTO/projector → kernel；Host append、普通 append、观察 IO 各归其位；旧聚合 status 与 body logger **不搬**，T27；深层 T33 |
| `coordinator.ts`, `runtime-start.ts`, `identity-op.ts`, `transient-adopt.ts` | T28 合成一个 commands/controller program；LegacyWitness、另一个 manual path、未注入 ports 就默认 live、Promise 编排包 Effect **不搬** |
| `watchdog.ts`, `inject.ts`, `live-inject.ts`, `identity`/`h3` 独立流程入口 | 旧 observeAndHeal/独立 inject/deactivate 执行器退场；真实策略/预检规则合到同一 controller，T28 不留旁路符号 |
| `h3-identity.ts`, `h3-live.ts`, `live-readopt.ts`, `official-chain.ts`, `launch-strategy.ts` | 纯 identity/topology/preflight 规则 → kernel commands；实际 Linux/launch/wait → process adapters；CLI/root 只装配，T28 |
| `process.ts`, `live-proc.ts`, `guardian.ts`, `guardian-process.ts`, `launch-env.ts` | 精确身份/信号、T12 allowlist、独立 guardian 性质保留到 contract/process adapters；Host 只复用 self-identity，不 import 全 census |
| `preload.ts`, `hook.ts`, `argv.ts`, `transform.ts`, `live-slices.ts` | preload entry 保留；精确 profile/compiler 与参数规则移到 host leaf，T20；额外 patch 非默认范围 |
| `reviewed-profile.ts`, `compile-receipt.ts`, `attestation.ts`, `op-lock.ts`, `runtime-artifact.ts` | 纯判断 → contract/commands；IO → profile/authority/artifacts adapters，T20 定位、T28 Effect 收口；J13 不迁 writer |
| `paths.ts`, `ephemeral.ts`, `local.ts`, `runtime-helpers.ts`, `errors.ts`, `hash.ts` | typed root config、local facade、kernel error/hash 归各 owner；无全局 path/env locator，禁止再造 utils 包 |
| `contracts.ts`, `host-bundles.ts` | 纯 provenance DTO → contract；只读/retention IO → provenance.node；不当作 Host 执行依赖，不删除现役/last-reviewed 证据 |
| `guardian-child.cjs`, `injector-hold.cjs`, `grokbox-temp-supervisor.cjs` | 移入 process/helpers，pack 输出名称保留；T22 移除默认 raw Host fd，T12 env 传递保留 |
| 旧测试、root `src/`、机器脚本 | 测试向量按新 owner 移植，不打包 Fake/旧入口；root `src/` WIP 和机器私有材料不吸收，不当实施依赖 |

**允许保留的不是 compat track**：上游 Host ABI 的必要字段、明确选择的 echo backend、Chat/Responses 两个真实协议、direct/transient 两种真实 launch 能力、以及用户现有 canonical 配置/证据。它们必须各自走唯一现役实现，不以 `legacy` 分支接旧 kernel。已知旧符号若出现在新代码，其含义/唯一 caller/截止票据必须逐个审查，不能靠改名逃过清单。

<a id="tickets"></a>
## S8. Phase 与票据顺序

**T41已接受：** 复用T37事实与T27/T33观察、T25/T40长期root，在浏览器前实现SQLite/incident。它不反向阻塞T37的安全门；T40最终持续生产验证T41最小闭环，Web UI、多盒和高级通知仍future。

T20–T36保留原票已证实现和正式关闭状态，新增T37–T41均open；不再把已有源码说成全部未实现。历史T1–T12等done保持原范围，不能代表当前重建已再次通过。旧 open T13/T14b/T15/T16 只作产品范围索引，执行权转下表。票据中的依赖是真门禁，编号不是强制全序。

| Phase / 排期 | 新票据 | 真正依赖 / 完成边界 |
|---|---|---|
| 0 · 首切 | [T20 骨架切割](../tickets/T20-runtime-layout-cut.md) | 先锁树/exports/检查器，撤旧入口；只承诺结构，不承诺 runtime 可用 |
| 0 · 紧随 | [T21 双向 codec 输入保真](../tickets/T21-runtime-codec-fidelity.md) | T20；优先 A3fu/A7 的实际 SDK body，A6 不 gate |
| 0 · 独立 | [T22 raw fd](../tickets/T22-runtime-raw-output.md) | T20；可在 T21 后穿插，不阻塞 T21/内核工作；任何 live 前必须闭合 |
| 1 · 尽早 | [T27 最小 facets/J13](../tickets/T27-runtime-status-facets.md) | T20；主排期 T21 后立即做，不等待 T25/T26/UI |
| 1 · 内核 | [T23 ModelBackend DI](../tickets/T23-runtime-model-backend.md) | T20/T21；AI SDK + Fake/echo，一个 Effect port |
| 1 · 内核 | [T24 RouteBinding/STEP](../tickets/T24-runtime-route-binding.md) | T23；expected selection、TURN/STEP/epoch、auth 与拒绝证明 |
| 1 · 资源 | [T25 Effect root/A9/v3](../tickets/T25-runtime-effect-root.md) | T24；root acquire/interrupt/close 与生产 transport |
| 1 · 接通 | [T26 A8 Host fullStream](../tickets/T26-runtime-host-fullstream.md) | T21/T24/T25/T27；唯一端到端 producer/Host reshape，无推理占位 |
| 1 · 控制/整合 | [T28 Controller cut](../tickets/T28-runtime-controller-cut.md) | T25/T26/T27；同一 Effect control program/安全 IO，无控制占位；Phase 1 默认出口 |
| 2 · deferred | [T29 命令边界/CAS](../tickets/T29-runtime-webui.md) | T27/T28；共享 commands/status、第二 writer CAS、identity 绑定。浏览器 MVP 另标 deferred，不自动开工 |
| 3 | [T30 pi](../tickets/T30-runtime-pi-backend.md) / [T31 Cursor](../tickets/T31-runtime-cursor-backend.md) | T23–T26；不依赖 T29；彼此无依赖；资格不成立就阻塞本 adapter |
| 4 | [T32 confirmed compact](../tickets/T32-runtime-confirmed-compact.md) | T24/T25/T26；另需 Host seam/provider qualification；不依赖 T29/T30/T31 |
| 4 | [T35 HostCompact wait-point](../tickets/T35-host-compact-wait-point.md) | T32 seam；S0 的完整 managed 控制边界；first-request overflow |
| 4 · required UI semantics | [T36 Working](../tickets/T36-composer-working-activity.md) | V24生产语义门；不等于WebUI/视觉美化，不替代T32/T35 |
| 1/4 · next | [T37 Server ownership](../tickets/T37-server-ownership-admission.md) | 真实归属准入/失效；复用T24/T26接口，开发不等待T38 |
| 1/4 · follows T37 | [T38 identity alignment](../tickets/T38-identity-write-alignment.md) | 无隐式harness写入、test2保全/阻断、单独确认的校准 |
| 4 · integration | [T39 native roundtrip](../tickets/T39-native-model-roundtrip.md) | T24选择与T26/T32/T35/T36所需证据组成原生完整往返 |
| 4 · release | [T40 persistent release](../tickets/T40-persistent-release-and-rollback.md) | 服务实现复用T25/T28可并行；最终发布合取T39及全部必需门 |
| 4 · pre-WebUI | [T41 continuous observation](../tickets/T41-continuous-observation-and-alerting.md) | T37共享事实后并行；单盒SQLite/incident/通知，T40接服务生命期，不等T29页面 |
| 4 | [T33 深层诊断](../tickets/T33-runtime-diagnostics.md) | T27/T28；不依赖 compact、WebUI 或所有 backend，缺能力保留 not_observed |

原重建依赖链：**T20 → T21 → T27 → T23 → T24 → T25 → T26 → T28**；不是要求重做已有实现。2026-09-12 当前主链以 S0.5 为准。T22 独立穿插。T29 与合格 backend、T32/T33 各自满足依赖后推进，**T28 后不默认施工 WebUI**；backend 受阻不堵住 T32/T33。每个写入车道一名 writer，跨 worktree 先后集成；规格不授权创建云端 agent、花费或改现役服务。

<a id="proof"></a>
## S9. 防呆证明与关闭规则

T41的观察事务/incident/通知须按V28–V30独立证明，不把已有归属查询、全仓旧计数或UI绿灯当完成。准入不等待SQLite；DB失效不能关闭或绕过T37。future候选的测试入口未实现前仍明确为计划。

### S9.1 执行面

T20 增加一次性 `bun scripts/verify-runtime-rebuild.mjs <case>`，有限 case 映射下表列出的真实 `bun test <path>`/结构检查，不能根据票号打印 pass。不存在的文件/命令、跳过所有断言、未知 case 必须非零。公共 CI/test 自包含；不得依赖本机 inv-pi、私人 upstream 或 credential。

证明编排统一用已 pin 的 Bun `1.3.14` 跑 `bun install --frozen-lockfile`、`bun run typecheck`、受影响测试、`bun run build`、`bun run verify:package`。这不授权生产模块使用 Bun runtime API。本规格编写不运行 runtime suites；历史 typecheck 失败不是重建豁免。实现前记录基线诊断；触及文件不得新增/留下错误，Phase 1 整体出口必须 typecheck/build/package 通过。禁止缩小 tsconfig、删业务断言或一揽子 skip 取代修复。

| case / 必须断言的性质 | 目标 fixture/test 路径与依赖现实 | 必須能抓到的负对照 |
|---|---|---|
| `layout` | box-runtime/test/architecture + check-runtime-boundaries；真实源码/exports/esbuild graph | 虚拟 forbidden import、残留旧入口/flag、preload 贡献 SDK/Effect、生产模块 `bun:*` / Bun globals 时失败 |
| `codec` | host-codec、openai-prompt-adapter；两个自行编写 Host root/state profile + **真实 AI SDK 调用，mock fetch 截获 Chat/Responses HTTP body** | 去掉 user-contained result、长尾、root，或补 Human user/raw tool 后失败；不能用 mapper 自己生成 expected |
| `backend` | kernel/backend-contract + backend-conformance；同一 port 的 Fake/echo/SDK mock | 多消费 cold stream、工具 execute、SDK retry、缺名关联/secret 泄漏被抓住 |
| `binding` | selection/route-binding/step-ledger；Effect TestClock + barriers + counted ports | 选择捕获后换同 id endpoint/ref/opt-in；凭据/provider 次数必须 0；旧 TURN 重握后测试必须失败 |
| `lifecycle` | modeld-lifecycle；Fake allocation barriers + 真实 Node20 disposable Unix process | allocation 后 interrupt、listen 后失败/late completion 留 listener 或动到竞争 path 时失败 |
| `stream` | host-fullstream/runtime-pipeline；真实当前版本 Unix（T25 v3，T32 后 v4）+ 同一 Live graph 的 SDK mock + Host consumer | terminal barrier 未开前未收到首 chunk就失败；拿 final parts 冒充 true stream 不能通过 |
| `status` | status-facets/host-journal；同源/错代/缺失/损坏证据 + counted read/write ports | open circuit 被清、pending 被盖、GET 写入、finish 当 delivery 都失败 |
| `raw-output` | controller-io + helper fixture；受控 child fds / fake renewer env | 默认打开 raw file、stdout/stderr 泄漏 sentinel，或丢掉 T12 env 都失败 |
| `control` | kernel/controller + controller-io + runtime-cli；Fake process tree/文件 + 已隔离 disposable processes | PID reuse、target drift、失败收尾、parent death guardian、重复确认第二次 signal 被抓住 |
| `console`（later / T29-only） | 仅 T29 显式排期后：console-api + 共享 CAS/identity；浏览器路径属 deferred UI MVP | 第二业务程序、UI-only lock、错盒写入、GET effect；未排期时不得为通过本 case 铺空 console/ |
| `pi` / `cursor` | backend-conformance + 各自协议 fixtures，真实依赖另列 qualification | 工具执行、hidden context、跨 Bot state、取消后重跑/隐式请求不能通过 |
| `compact` | overflow-recovery/overflow-bridge；同一 kernel + fake Host compact + provider outcomes | 401+overflow、429、payload-too-large、EOF、候选日志、重复 completion 任一产生恢复即失败 |
| `diagnostics` | diagnostics + status-facets；retention/gap/source/epoch vectors | 错代拼 timeline、缺事件推出零调用、无 watermark 显示 delivered 即失败 |

表内缩写测试路径相对 S2 树的所属 `test/`；票据给完整命令。验证 runner 为每个 child command 输出 case、argv（无秘密）、exit code、断言/skip 数；最终 JSON 含 commit SHA、dependencyReality、supports、notProven、artifacts。不能只根据 exit 0 或测试数量推断语义完成。

<a id="ownership-release-proof"></a>
### S9.1.1 T37–T40新增证明面（入口与完整资格分开）

沿用同一个`verify-runtime-rebuild.mjs`，不另建runner/模拟产品服务。各case的已实现子集由owning ticket和实际report确认，未知case必须非零退出。既有source/packed continuity和旧全仓结果只复用其原范围，不能提前覆盖新增门。

当前`ownership-admission`、`identity-alignment`已增加source case；另有T24的`model-selection`覆盖owned官方对象/Chat/Responses往返。前两者与选择case均在报告保留原生迁移、writer退场、真实官方/checkpoint/App等未证边界；case通过不自动关闭整票。下面`model-roundtrip`与`service-release`仍是待实现的完整证明面，不以选择fixture改名替代。T39的固定原生消费者/packed状态适配器跨进程研究保留在私有资格资料，不把owned JSON标作原生checkpoint；T40已增加独立`service-lifecycle`子集，启动/退出取消与资源释放通过也不代表完整持久服务已实现。另有`runtime-start`源码CLI/Unix+命令Scope和实际Node制品start→borrow→orderly restart入口；早先真实CLI复验被拦已由后续正常验证推进，准确实现证据归T40，现场证据从 [LIVE](../tickets/LIVE-integration-validation.md#live-runtime-persistence)索引。此case仍不关闭持久服务owner/安装自启/现场凭据或整机恢复门。

| case / 目标证明面 | owner | 必须执行的独立oracle |
|---|---|---|
| `ownership-admission` | T37 | 全入口gate、scope/ID/freshness/撤销竞态；conflict/unconfirmed provider/tool/SendToUser零新增效果；合法official不受损 |
| `runtime-start` | T40 | 源码CLI调用唯一Scope：先route配置校验、匹配数据根后借用或持有前台服务；desired保存、未确认reconcile、输出失败/取消释放；无Host adopt。单独补packed原命令，不以modeld-run通过代替 |
| `identity-alignment` | T38 | 实际update body没有harness；create原nonce确认；先门禁后writer退场；test2保全/未知结果/全局影响不能隐藏 |
| `model-roundtrip` | T39 | 同原生状态官方/A/B/官方、custom checkpoint原生读回、真实SDK请求及独立工具/Memory/交付计数；冷缓存仍正确 |
| `service-release` | T40 | 干净启动/重复start/重启、准确进程身份、持久凭据、日常官方与完全卸载两种退路；不依赖卸载后的bridge证明成功 |
| `service-lifecycle` | T25/T40（已实现的前台子集，不代替上一行） | source root的typed failure/defect/interrupt、调用方取消与stop超时gap；真实Node制品启动/borrow/SIGTERM/occupied-path；独立HOME、零真实provider/Host，不签安装自启或完整rollback |
| `observation-monitor` | T41（本地SQLite/CLI/冷Node子集已实现；完整关闭仍需右列） | 真SQLite临时DB+FakeClock/Server/notifier，采集合并、stale/changed分离、原子变化/incident、断电与迁移/retention、ack重启持久、投递未知、零模型/配置/Host写入；DB坏也不能绕过或阻塞独立准入 |

所有新case都分别运行source和本次packed相关入口；provider/Host policy替身与local-real IO明确标注。真实原生、外部provider、原版App和完整主机生命周期为后续明确授权的独立证据，不让公共CI依赖私人机器。

**工具链预检：** runtime-rebuild与continuity verifier都在child build/test之前核对实际Bun与packageManager的精确版本；错配返回toolchain_mismatch且零child，不把默认安装升级后的结果算作已固定候选。候选报告同时保留toolchain与前后source指纹；仅源码不变不能代替工具链一致。

**统一关闭记录分工**：owning ticket 维护实现、测试与独立 review；[LIVE](../tickets/LIVE-integration-validation.md)唯一维护现场进度、未验项、阻断与下一责任，日期报告保留当次命令/退出码/case/断言、source/制品稳定性、原生Host/App版本、Bot/TURN/nonce/generation、凭据引用而非值、支持范围与实际影响。其他文档回链，不复制第二份当前现场进度账。数据缺失、只见accepted、跳过case、界面不可读、工具拦截或版本漂移不能标passed；缺一项必需证据不以别项高通过数抵消。

T38现场校准另有确认门，保留活反例不等于未实现阻断；T40可在冲突阻断已证且test2明确隔离时发布其它合格Box对象，但必须诚实记录test2尚未修复。缓存命中率本身不是正确性通过条件，未知cache指标不造0；所有其它日用关键路径不因“可选性能”被删出范围。

### S9.2 必要端到端 vectors

- 一个工具调用 → Host 工具结果置于 `user.content` → **无新 Human turn** 的下一 STEP，双 SDK body 均保留 id/name/result/isError 与尾部。mixed text/result、同正文含控制词、长 args/results、空字符串/false/0、中文/UTF-8、超过 1500/8000 的边界均覆盖。
- root 在 state 内与 root 在独立字段的两个 profile：required root 恰好一次；未知/遗漏/错误 provenance 在 credential/provider 前拒绝。工具 schema 不能因为 catch/continue 消失；vision 声明/未知内容拒绝与安全预算不能偷变截断。
- binding：首次读/写竞态、不同 Bot、相同 modelId 改 endpoint/ref、credential 改变、长工具空档、expiry、restart、重复和 cancel-before-submit；不靠 sleep 证明顺序。
- fullStream：terminal 被 Deferred 阻住时首 token 已到 Host；early/late/no reader、关闭一个 reader、tool interleave、serial violation、malformed event、EOF、缺 usage、output budget、cancel 后 late event。Host fake 有唯一工具执行计数器及独立 transcript/UI reader，不能把三个 reader 当三个 tool executors。
- lifecycle/controller：每个 acquire 注入失败/interrupt，正常 release 条件下所有 owned 计数归零；另行注入 release 自身失败时验证 cleanup gap/非成功，不豁免普通泄漏。借用资源保持存活。真实进程 fixture 只能命中自己创建且身份锁定的 child，不扫描/信号现役 Host。

所有 offline fixture 在任何生产模块导入/Layer 构造前设置独立 HOME/roots、剥离真实 auth env、封锁外网/真实 credential，注入进程端口。HTTP mock 也需请求计数/URL allowlist；单纯给 SDK 一个 fake stream 不能证明实际 HTTP 编码。不能直接运行尚未隔离的旧全量 Host/guardian suites。

<a id="review-live"></a>
### S9.3 独立复审与 live 门

实现者提交可复现证据，不自签关键合同。**Astra/max 必须复审**：T20 树/退场/import graph；T21 实际 request oracle；T23–T26 selection/Scope/stream/取消 proof；T27/T28 权限与证据 writer；T29 仅在显式排期后审 CAS/identity（浏览器 MVP 另审）；T30/T31 qualification；T32 恢复预算；T33 claim ceiling。T22 可随下一次 core review 同审。复审绑定 exact SHA，修改关键路径后旧 review 失效；不把模型名字硬编码成构建依赖。

票据 Done = **本票范围**代码/退场完成 + required offline proofs + 上述独立复审，无本票占位/未知必需断言。只有 T20 明列的未建能力可作为结构交付的 notProven，不能据此关闭后续功能票；T26/T28 必须分别清零推理/控制占位。依赖事实不成立时标 blocked，不勉强实现。offline Done 不等于 live-qualified；每次 live 另需 owner 明确授权、当前身份/源 SHA/profile/bridge artifact 预检与成本/停止边界。

- **L1 core canary**：在已有T22/T26/T28与新增T37/T38所需offline门、独立review及当前授权齐备后采用固定候选；正例用重新确权的test0 `00000000-0000-4000-8000-000000000114`或另一个明确批准且Server确认box的测试对象。test2不作正例、不从App向它发任务证明本地门。验证真实首 chunk/Host terminal/一次工具续步/SendToUser 与官方 renewal；分别记录 observed 层级。test1 `00000000-0000-4000-8000-000000000113` 保持 unassigned，验证官方路径，不 opt-in。
- **L2 backend**：每个新 provider/backend 的真实协议/auth/流取消资格独立采集；SDK mock 和 L1 AI SDK 不能给 pi/Cursor 背书。
- **L3 compact**：仅在T37确认box、T32/T35接点及目标provider资格可用的批准对象上验证一次恢复；test2不得沿用旧heavy角色。不能无预算灌大prompt或反复live重试。
- **模型往返与原版App门**：T39的官方/A/B/官方持续会话、T36的V24、T40的持久启动/完整退出都是本轮必要产品证据，不因下面T29浏览器MVP延后而跳过。旧计数/旧Bot回复只覆盖原版本原范围。
- **新增票复审**：T37审归属范围/时效/真实fence；T38审writer退场/保全/操作影响；T39审原生回程与golden独立性；T40审实例/凭据/退出和最终证据合取。测试与review绑定固定内容，关键变更失效后重审，不自签生产。
- **UI proof（T29 deferred MVP，非默认主链）**：仅在显式授权做 console 时才适用。实际浏览器覆盖登录、选择保存、旧 revision、reload/断线/重复确认与 safe rendering；Playwright Chromium 只作 pin 的 dev-only driver，由 Bun 测试驱动，不替换既有 runner。缺 browser 环境就阻塞此证明，不能 skip 后宣称通过；headless reducer/API pass 不能冒充 UI proof。默认离线 mock runtime，访问现役实例另需授权。T20–T28 不得为了本条铺 `console/`。

只把最小可公开 interoperability facts 与自行编写的 fixture 放进 repo。真实凭据、Host dumps、私人源码/完整对话及机器路径证据留在受控外部；公开票据只引用可复核 SHA/计数/结论和明确未证明项。

---

<a id="modeld-effect-core"></a>
## S10. Modeld 执行核心收口（2026-09-16 accepted target）

本节是本轮**唯一施工规格**，不新增第二份 build bible。范围是 modeld 执行与资源生命周期；策略裁决见 [ADR](../decisions/2026-09-16-modeld-effect-core.md)，责任取证见 [boundary audit](../maintainers/modeld-authority-boundaries.md)。本节细化/替代 S2–S5 中涉及 modeld 的重复启动、粗粒度 authority、共享读取与状态同步机制；未点名的 codec、Host loop、compact、原生持久化和 J13 义务保留。历史已完成票不重开，新工作使用 T43–T50。

**实现与证明路由：** 当前执行核心已接入生产程序、v6 控制协议与有界观察；原始 [离线验证报告](../reports/2026-09-17-modeld-effect-core-offline.md) 保留历史候选范围，外层超时交互及组合v2复验见 [T49](../tickets/T49-modeld-qualification-and-release.md)。后续证据复用与可用性收口归 [AUTH](../tickets/AUTH-ownership-evidence-availability.md)，不重开历史完成切片。独立复审与原生/live资格仍分别取得，不将测试通过写成所有票据 Done。

### S10.1 交付范围、归因与决策门

目标：一次受管理 STEP 的 claim、资格等待、prepare/auth、唯一推理、输出放行和结算可沿一条程序追踪；短暂取证失败不假称已失权，明确失效不能被缓存复活。Effect 管理长寿命资源、等待与取消，而非增加一套权限/Agent 平台。

| 类别 | 处理规则 | 本轮例子 |
|---|---|---|
| 接入必需成本 | 保留不变量，收口实现 | claim-before-dispatch、原选择/凭据固定、Host 协议/工具边界 |
| 自有策略或实现问题 | 在自有 owner 内修正并退出旧路径 | request-start 年龄策略、first-waiter cancellation、重复 authority 读取、通用 poison |
| 外部触发 | 记录来源和不确定性，不扩大本地副作用 | slow List、RPC cancellation、Provider rate limit/outage |
| 已证原生缺陷 | 三路对照与固定版本证据后，在最窄适配边界治理 | 不预设具体缺陷已成立 |
| 正常原生行为或未归因 | 不伪修，不扩张 modeld | child-only Working、缺 nonce 的 App 发送异常 |

责任来源与严重性是两个维度。跨身份执行、重复副作用、终态复活阻断发布；合法执行误拒、取消/资源不收敛阻断可靠性验收；诊断/展示另有证据门。列表读取不是执行租约，客户端计龄不能证明未声明的服务端缓存一致性。

**D-native：当前唯一执行路径保留补充 Server 证据门。** 已有 `allowed/bound` 是必要本地事实，不是 per-Agent/per-TURN 可撤销执行授权。T43 先审原生覆盖；没有足够证据不得删 Server 门，也不得留下运行时 `native|polling` 双执行模式。未来若证明原生能力充分，另行裁决替换来源，不重写 STEP 程序。

**D-policy：结构重构不默认放宽 5 s。** 初版 canonical policy 保留既有 5 s 年龄、10 s 单次 source 上限、既有 STEP 总期限。15 s 证据/15 s 单次等待/30 s STEP 累计等待只是上一轮候选，不是已批准默认。新策略必须固定、校验、版本化，经 T49 批准矩阵启用；禁止按观测延迟动态扩权、从响应完成重新计龄、隐藏扣除 RTT。持续 9 s 读取在 strict 5 s 下仍应拒绝，不能把此情况标为重构回归或伪造恢复。

**D-deployment：未建立可靠失效协议前保留原有部署证据复核。** 拆出局部职责不等于把 attestation 缓存成永久权限；文件 mtime/watch 不独立授予执行资格。

### S10.2 固定骨架与最终 owner

不新建 package/daemon，不升级数据库/SDK/Effect pin/测试框架。public exports 延用已存在的 `contract`、`ports`、`inference`、`runtime` surface；不引入另一套同义 Promise Port。

```text
packages/runtime-kernel/src/
  ports.ts                               # typed AdmissionAuthority；保留 ModelBackend/BackendAuth
  internal/contract/
    ownership.ts                         # identity/classification；不拥有网络/数据库
    authority-policy.ts                  # 唯一策略、预算、恢复/终止原因代数
    ownership-observation.ts             # source/waiter/证据的安全投影
  internal/inference/
    authority-gate.ts                    # 一个资格等待/裁决程序；checkpoint 在这里
    step-program.ts                      # STEP 编排；不得再内嵌第二 authority 实现
    step-ledger.ts                       # 纯占位/终态转换
    route-binding.ts                     # 同一服务的 binding/资源与有界维护
    execution-history.ts                 # 持久化 claim 合同，唯一事实 writer

packages/box-runtime/src/
  internal/roots/modeld.runtime.ts        # 唯一服务 acquisition/lifetime，CLI Promise 门面复用
  internal/modeld/
    server.node.ts                       # 有界 transport/STEP scope/control-frame/terminal
    unix-listen.node.ts                  # syscall bridge，资源数量/清理证据
  internal/io/
    ownership-admission.node.ts          # native snapshot -> typed evidence 的 adapter
    ownership-coordinator.node.ts        # 服务拥有的 source op/等待者/刷新；Effect
    execution-history.node.ts            # 单 DB owner；明确写入原子边界
    store.node.ts                        # 部署快照；不再承担远程 ownership 策略
  internal/host/
    ownership-read.ts                    # 原生认证的单次、有限读取及不可合作操作 guard
    ownership-slices.ts                  # 固定 Gateway DTO、能力/代匹配；无通用 RPC
    modeld-client.node.ts                # Host 薄 bridge；不加入业务 retry/Effect
  preload.ts                             # Host-only finite adapter wiring；Effect/SDK-free

packages/cli/src/
  runtime-ownership.ts                    # 现有本地认证 Gateway transport 的窄注入
  ownership.ts                           # 独立只读诊断；不把 modeld 在线设为硬前提
```

新文件只因独立策略/生命周期/替换压力获得位置。T46 的按身份同步与 claim 方法优先在现有 owner 中实现，不为了对称建立 actor 框架、registry 或万能 state engine。前述骨架是目标，未创建模块不能作为已有能力引用。

| 能力 | 最终 owner | 允许的依赖/消费者 | 禁止 |
|---|---|---|---|
| 原生资格与工具实际执行 | 官方 Host | 窄 bridge/已资格接点 | modeld 代写原生 profile、停止 temporal 子任务 |
| 归属取证调度 | modeld 服务 Scope | borrowed NativeOwnershipSource、执行等待者 | 首等待者拥有共享 RPC、每 token poll |
| 执行许可与 STEP 生命周期 | runtime-kernel | typed authority、原 binding、cancel | CLI/monitor/SQLite 授权、通用 catch 复活旧 TURN |
| 模型/凭据 effect | BackendAuth/ModelBackend adapters | 原 pin、统一取消/预算 | SDK tool loop、adapter 私有业务 retry |
| 执行身份持久化 | ExecutionHistory | kernel claim/settlement | 日志回放授权、写失败回退内存 |
| 部署证明/修改 | 既有 controller + canonical artifact | modeld 只读适配 | 第二维持器、观察触发重领养 |
| 观察 | 各事实源 + 既有 journal/monitor | 有限投影 | 观察失败更改已发生的业务结果 |

### S10.3 类型、时钟与一条执行链

`OwnershipEvidence` 是可校验事实，不是许可；`AuthorityPermit` 是内核进程内某检查点的短寿命决定，不接受 caller/JSON/日志/SQLite 反序列化；`AuthorityObservation` 只作观察。Server version/lease 未提供时显式 `not_observed`，本地 observationId 不冒充 Server revision。

**缓存边界不可省略：** 原始 Host snapshot 同时包含远端注册与本地 scope/migration/execution。modeld 不得缓存整份 snapshot 后当作新的本地事实反复准入。T45 的 source adapter 必须分开远端 evidence 与当前 native local witness；缓存只复用远端部分，每次候选许可仍读取当前本地身份/暂停/绑定事实，并确认前后 Host 代/scope。需要的 local-only 能力在既有 `ownership-slices.ts` 的有限 DTO 中落地并资格化，不另外暴露通用 native RPC。旧 Host 不支持该能力时明确拒绝优化路径，不用缺字段猜测本地 ready。

`AdmissionAuthority.current` 的 `unknown` 边界收敛为有限的 admitted/refused union。可恢复失败、明确失效、未知结果、调用者取消、实现 defect 不合并。原生未知输入仍由边界 decoder 处理，不因加强类型跳过 runtime 校验。

1. 有界接收 frame，校验协议/Host/service 身份与字段，登记单一 STEP 总期限。
2. 在原 ledger 中持久 claim；未知写回执拒绝继续，重复只返回已有 identity，不重发。
3. 读取必要部署/本地 fence；消费合格证据或加入一次有界资格等待。
4. 同一等待消费 STEP 剩余预算；更新进度但不造模型 token、Bot 消息或延长期限。
5. 取证成功后重新核对 scope/Host generation/取消/原 binding；失败不发布中间终态。
6. 固定模型选择与 credential fingerprint，prepare 可以挂起但不能进行模型副作用。
7. 在真实 dispatch 前核对本地 fence 与仍合格的证据；不能因为 prepare 前过门就跳过。
8. 仅一次 ModelBackend.infer；provider recovery/compact 仍由既有内核 ledger 按原合同管理。
9. 在工具材料放行和成功完成边界核对资格。暂缺证时保留有界结果，不重新 infer；硬失效/期限/缓冲上限到达时真实终止。
10. 同一 STEP 最多一次终态；持久 settlement 与观察各按原 writer 结算。工具材料释放不冒充实际执行/投递。
11. 释放 STEP 等待者/stream/缓冲；TURN 资源按原 idle policy 服务拥有；没有需求则停止执行取证刷新。

模型已经被调用过时，资格等待恢复不产生第二次模型调用；当次终态已发出或服务代已退出后不自动恢复。暂时 `waiting` 只发生在同一尚未终止的 STEP；不为旧 TURN 提供新握手/新模型捷径。明确失效应对原 binding 保持单调，不被后续 box 观测覆盖。

**单一期限：** server 与 kernel 共用同一进程内 ingress 单调时钟起点；`runStep` 的可选 timing 是内部调用参数，不是 wire DTO，未来起点在 claim 前拒绝。180秒请求期限从入口一直覆盖到流结束，accepted 不续期；资格门拥有其更小的累计等待预算。移除历史10.5秒复合准入计时器与500ms常量，不用外层同量级计时器抢走已返回的源失败。总期限先到且无源结果时只报告 deadline，不拼出虚构的 RPC 原因；不可中断的持久化确认仍可能延迟取消结算，不靠 detach 伪造停止。

**时钟：** 进程内预算用可注入单调时钟；ISO 时间只作跨日志关联。固定 Effect 版本的 `Clock.monotonicTimeNanos` 才是 elapsed-time 来源；`currentTimeMillis/currentTimeNanos` 都是可跳变墙钟，不得因单位是 nanos 就当成单调。跨进程不直接相减 monotonic tick。共享请求由协调器记原始操作起点；Host 返回有界相对耗时/身份，收到时间不刷新 evidence。墙钟跳变、未来时间、未知原始年龄拒绝执行而不产生负年龄。

### S10.4 共享 source operation 与等待者

原始读取是服务/操作 Scope 的子任务，等待者属于各自 STEP/诊断 Scope。每个 source op 有唯一 id、固定 scope/Host generation/目标覆盖/开始时间/截止时间/有限 outcome；每个 waiter 有独立 id/加入时间/截止时间/原因。一个 waiter 取消不取消其他有效需求；后加入者不延长 source 截止时间。

相同合格范围需求合并，目标集合仍有界；不得让不在目标覆盖中的 Bot 借到假证据。同来源实际并发与排队都有硬上限；等待开始副作用的 STEP 优先于提前刷新与纯观察，且有公平性测试。没有等待者/刷新需求则停止；不可合作 source 尚未实际结算时不能丢掉占用并无限启动替代请求。

源失败因果向所有等待者一致传播：`source_deadline`、`source_cancelled`、`source_cancelled_unknown`、`scope_invalidated` 与 `waiter_deadline`、`caller_cancelled` 分开。`rpcCode=1` 只证明取消类别，不自行补出取消者。保留 readId/waiterId/原始年龄/剩余预算/settled-or-unknown。

只有协调器执行只读取证重试。有限次数、剩余预算、抖动/退避、不可恢复错误表由 canonical policy 拥有。Host adapter、CLI、每个 checkpoint 和 SDK 不各开 retry。诊断直读不静默变成执行 fallback。旧 evidence 在硬窗口内且无反证可按策略使用；过期不放行，刷新失败不得续期。

**同一 STEP 的证据复用（AUTH，strict-observation-v2）。** 固定策略保留原始证据最大5 s、跨STEP复用2 s、累计资格等待10 s、单请求入口180 s与原有重试次数。kernel以当前durable claim生命周期内的对象身份，通过进程内`AuthorityReadControl.evidenceOwner`标识同一STEP；该字段不进入wire、配置或journal，也不是许可。协调器在原有有界source池中用弱关联记录该owner最后成功验证的operation ID，没有第二份证据payload缓存。仅该owner可将该source复用到原始5 s以内；新STEP（即使同TURN）、新owner/服务代、不同目标、被淘汰/retired的source不能借用此关系。原始时间不重置，边界到期重新取证并消费剩余预算。

每个检查点仍读取当前本地scope/pause/binding与前后部署证据；取证及本地复核期间观察到的失效都不能被稍后的ready快照撤销。减少2–5 s期间同STEP的远端重读会降低远端注册变化的采样频率，这是显式策略取舍，不是无语义影响的缓存优化；现有5 s客户端证据窗口不变，但它仍不保证Server快照一致性或即时远端撤销。不可据此删除Server门或缓存本地授权。持续超过5 s的来源仍会拒绝，短暂慢读只有在预算内取得另一份新鲜证据才能恢复。

`ownershipWait.evidenceUse=source|shared|cache|step`记录取得路径，`policyId`区分历史v1与当前v2；历史投影只读，不是运行时模式选择。`availabilityCause=read_elapsed|evidence_elapsed|permit_elapsed|wait_budget`由检测点记录读取已超龄、后续复核过期、许可消费前过期或累计等待耗尽。缺字段的历史原因不补猜，解释不能改变错误分类或授予重试。CLI与STEP使用同一个纯`authority-presentation.ts`映射只读的ownership/incident/doctor建议，不能用title sync、启动Host或创建Bot冒充修复。完整离线链路与待验收范围由AUTH的唯一回执维护。

### S10.5 资源/存储/取消合同

一个 modeld 服务程序，Promise facade 仅在宿主边界运行它；不是搜索并删除所有 Promise/runPromise。原生 callback 可有薄桥，但不得拥有隐藏业务循环。Effect pin 保持根 catalog，Host/preload import fence 和 J13 不变。

同一服务保留唯一 ExecutionHistory writer 与数据锁。STEP claim/对应 TURN 元数据有明确原子边界；durable acknowledgement 先于派发。按 TURN/STEP 同步，跨 Bot 的慢 IO 不得无条件持有全局状态更新锁。全局容量/索引变更短而有界，执行外 IO 后提交必须核对身份/revision；不得用“移出锁”制造 TOCTOU。

资源回收移到服务维护路径增量执行；前台只作必要有界压力检查。同一 TURN 的 scope 不被第一 STEP 释放；最后需求释放后不永久保持后台取证。取消/关闭分成 waiter ended、Fiber interrupted、signal sent、source settled、external outcome known/unknown；Scope close 不等于外部事务回滚。

listener → client/STEP 和 service → source op 的父子关系明确。stop 先不接新 work，再有界取消/结算，最后关闭持久存储/listener。缺失 cleanup receipt 是 gap，不是 success。effect 内 defect/interruption 保留；安全日志只做有限投影。

### S10.6 协议、观察与兼容

若 T47 增加 accepted 前的 authority control frame，使用显式下一 wire 版本并更新 Host/modeld/profile 同代矩阵；不偷偷让旧 peer 忽略新执行语义。没有需要的 wire 变化时不得仅为票号盲升版本。

观察至少关联 readId/waiterId/evidenceId/policyId 与既有 Agent/TURN/STEP/Host/service identity；区分 queue/source/shared-wait/backoff/local-fence/storage 时间。来源健康、证据可用、执行等待/拒绝是独立维度。backendAttempts、canonicalEvents、Host tools released、工具实际执行和用户投递仍是独立事实。

事件来自同一状态转换；source cause 不经各层重新猜测。观察失败不改变准入/工具/Provider 结果；claim 存储不是观察日志。metric label 只用有限枚举，IDs 保留在 bounded traces，避免高基数指标与原始凭据/正文泄漏。

modeld 不在线时 CLI 仍能作现有只读诊断；monitor/SQLite 不能 gate 普通执行。执行证据仅可从 live source/当前合格内存对象获取，不可由 SQLite 冷读恢复。

### S10.7 里程碑、Ticket 与退出

| 里程碑 | Tickets | 交付面 | 必须退出 |
|---|---|---|---|
| M0 · 责任/骨架冻结 | T43 | native coverage、责任矩阵、source baseline 与可运行 proof 入口 | 仅凭布尔值替代原生授权的假设 |
| M1 · 唯一服务/取证 owner | T44 → T45 | 服务 acquisition、typed evidence、共享 source/等待者/取消 | 重复启动编排、首等待者拥有 shared RPC |
| M2 · 执行状态/持久性 | T46 → T47 | 按身份同步、有界回收、等待/门禁/一次终态、必要 wire | 统一 poison、无界前台维护、重复远程策略 |
| M3 · 观察与制品 | T48 | 各层因果、CLI/monitor、import/pack/privacy、三路对照工具 | 观察推断权限、错代证据、false-green 验收 |
| M4 · 验证与发布 | T49 | 固定策略、热路径基准、独立 review、受控灰度/回滚 | 旧运行路径和未声明兼容入口 |
| 非主链 · residue | T50 | 一次 review/fix/re-look 后非阻断遗留 | 不自动派生无限返工/线上动作 |

T43 不要求先取得新的上游能力；当前 gate 保留也可以是合法审查结论。T49 缺少原生/live review 时明确 `not_live_qualified`，不能关闭所有生产门。独立分支承接本轮代码/离线验证，不自动合回 v2、push、升级真实 Host 或默认模型 spend。局部规格/实现/测试依序提交；跨 worktree 的 live-only 条目、集成提交映射及回执统一放在 [LIVE 长期验收票](../tickets/LIVE-integration-validation.md)。默认先合入 v2、固定共同制品再集中切换，线上切换仍须满足当前身份/profile、限定对象与明确预算授权。源码/测试/独立代码复审尾项不得移入 LIVE，登记也不使任何生产门变绿。

### S10.8 可执行 Acceptance 与判定边界

T43 建立 `bun run verify:modeld-core -- <case>` 的**有限入口**，调同一生产代码与既有测试；未知 case、空 suite、缺证或仅 stub 返回必须失败。入口在实现前标 planned，不写“测试已通过”。初始 case 为 `baseline`，后续票增加 `lifecycle`、`evidence`、`state`、`authority`、`observation`、`release-offline`。真实资格不是 fake case 的别名。

每个 case 报告版本/固定输入/依赖现实/通过性质与未证明项。fake capabilities 不替换业务程序；原生三路对照在隔离、授权且固定版本环境进行：unpatched official、patched passthrough、patched managed。前三路只生成比较证据，不因某路成功推定其它路径。

| 必需向量 | 验收 oracle |
|---|---|
| 5.5/7.75/9 s List | strict policy 拒绝且不续龄；已接受新 policy 下继续但只一次模型 effect |
| source deadline 与晚加入 waiter | 同一 source cause；waiter 剩余预算真实；不误报权限丢失 |
| 一等待者取消/所有等待者离开 | 其他需求不受误取消；无需求资源按合同结束 |
| 不合作 source/慢存储 | 占用仍计数、并发有界；无无限孤儿 RPC/全局无界等待 |
| scope/Host/service 换代、迟到结果 | 旧证据不能缓存到新代，也不能放行旧请求 |
| 已观察到 box→temporal→box | 原绑定失效不复活；未观察到的中间态不得声称检测到 |
| 资格等待后的取消/prepare/auth 改变 | dispatch 前再次 fence；零未授权新增effect |
| infer 后缺证/工具审批跨窗口 | 不重新 infer；有界缓冲/实际消费边界分别验证 |
| 重复、写回执未知、崩溃、重启 | durable claim 不丢失到可重发；旧 service/终态拒绝 |
| 高并发多 Bot | 读取不随 token/工具事件线性放大；按需求合并与公平排队 |
| journal/SQLite/notify 失败 | 观察 gap，不改变执行权威或伪造正常 |
| 最后需求完成、服务关闭 | owned waiter/fiber/socket/listener/可释放资源归零；未知外部结果单列 |

性能报告记录 native reads/STEP、取证时间、共享等待、锁等待、存储、event-loop lag、取消延迟和资源峰值；冻结负载与前后两种同现实基线。目标是降低机制数量和依赖放大，不预设未测的 P99/SLA。Node/SDK/Effect/数据库版本保持不变；live raw response、Host dump、机器身份不入公共仓库。

关闭 = 本票代码与旧路径退出 + 正反例 executable proof + 固定提交独立 review。仅有文档、typecheck、旧全库计数或模拟 canary 不算功能完成；仅有功能完成不算当前官方 Host/App/live release-qualified。

<a id="model-reasoning-policy"></a>
## S11. 同通道模型推理设置（2026-09-17）

Owner：[实现票](../tickets/FEAT-model-reasoning-policy.md)；决策依据为[结构化 assignment ADR](../decisions/2026-09-17-model-reasoning-policy.md)，不是外部 issue 评论。复用 S10 的单执行核心，不重新设计 modeld。

- R01：schema v2 assignment `{modelId,reasoning?}`，读 v1 不写、明确保存 v2、拒绝未知字段；不生成目录变体或迁移配置根。迁移/回退需成套制品与保护配置。
- R02：effort 仅用明确能力白名单；default/omission 清除，none 独立；错误在资格/凭据/HTTP/保存前拒绝。Pi boolean 或数值 budget 不推断 wire 档位。
- R03：policy/capability 进入 selectionRevision；已绑定 TURN、冷恢复、同 STEP 去重/冲突/重放保留现有身份合同。新 TURN 读取新选择，改变其他 Bot 不影响本 Bot。
- R04：SDK 设置合并不覆盖 parallelToolCalls；实际 HTTP 前核对 wire model、协议字段和 effort；缺失由专用映射补入、冲突拒绝。预算、工具、取消、Provider recovery 边界不改变。
- R05：configured/captured/emitted/provider-reported 分层，Provider tier 缺证时 unknown。warnings 有界去私密，reasoningTokens 为可选 output 子集；标题 e 与模型 m 分离。
- R06：wire v7 同套执行，旧 v4/v5/v6 仅有限只读诊断；Host import fence 与 prompt envelope 保持。离线含真实 SDK 编码、真实隔离 Unix/磁盘、打包；Provider/native/App/切换证明分别进入 LIVE，源码/review 缺口仍留来源票。

<a id="context-maintenance"></a>
## S12. 默认本地上下文维护（2026-09-17 accepted target）

**状态：已实现默认Box会话主链，离线/Node制品及固定原生隔离证明已记录，独立review与实际采用未闭合。** 本节仍是CTX-00–04唯一实施合同；[ADR](../decisions/2026-09-17-local-context-maintenance.md)拥有决策，[Pi对照](../maintainers/pi-compaction-reference.md)拥有来源事实。实现 `883e224`，读回修复 `269f1e2`，连续配置迁移 `358c057`，TURN凭据/生命周期一致性 `f4b3a18`。当前源码config3/models2/wire8，保留Node>=20.17.0并选择受控Pi纯代码提取，不实例化Pi Agent运行时。[离线报告](../reports/2026-09-17-context-maintenance-offline.md)区分实际证明范围和独立review通道503；现场状态只在[LIVE](../tickets/LIVE-integration-validation.md#live-ctx-adoption)。

当前支持范围必须明确：生产预算meter是完整unicode-envelope估算及余量，不是已接通所有tokenizer/usage校准；图片原样保留。手动入口仅已加载默认Box session，named/server/subagent无资格时拒绝。可独立结束的pending摘要由原owner取消并等待；同STEP自依赖摘要有界busy，不宣称泛化死锁恢复已完成。原生方法隔离的blob/存储外围仍是替身，不能签完整现役checkpoint事务或App输入/显示。下文更广适用性与完整验收仍是合同，测试未覆盖的组合不因更新状态被豁免。

本节取代本 Spec 中“managed compact 只由失败触发”“HostCompact 仅供 active STEP”“proactive 一律后移”的适用范围；保留 T32 的失败恢复安全边界、T35 的原生寿命、S10 的 Effect/authority、S11 的 reasoning 和 F/E 的状态保真。普通 provider retry、观察日志 compactor、ops 维护 Host 与本节的会话 compact 是不同能力。

<a id="pi-compaction-reuse"></a>
### S12.0 复用优先、选型门与独立模型层

**采纳结果：** CTX-00已选择 `internal/context/vendor/pi-compaction/` 中的单一受控提取，保留Pi0.85.1切点/准备/估算函数与摘要模板，显式适配完整材料覆盖、输出预算和caller-owned请求。Node engine、非公开request入口与回调前截断是未直接整包采纳的具体原因；版本/许可/差异和真实制品证明见来源票与PROVENANCE。以下优先级继续约束升级，不表示本轮还在同时开发多条实现。

**先证明可复用边界，再实施；不是先把compact自研一遍。** [CTX-00](../tickets/CTX-00-pi-compaction-reuse.md)是新增M0，固定发布包/导出/依赖与可复现资格。优先级为：公共包API直接复用 → 最小公开接口/策略补丁 → 带来源与更新边界的受控代码提取 → 有具体否定证据的局部重写。顺序按函数/责任评估：某个serializer不符合要求，不否定全部估算/切点；某个函数可导入，也不证明完整集成可用。CTX-00必须形成选择/差异表并保留失败证据，不能只写“研究完成”。

候选包为 `@earendil-works/pi-agent-core@0.85.1`。已检查到公共估算/切点/prepare/compact函数；内部caller-owned `compactWithRequest`/`generateSummaryWithRequest`存在但未从根公开，也无专用compaction子路径。core使用retainedTail，coding-agent同期实现仍使用firstKeptEntryId，不能混成同一接口。确切发布包哈希、engine与导出/行为证据只在[参考页](../maintainers/pi-compaction-reference.md#core-package-reuse)维护。本节不以tag/main或源码内export代替npm公共入口，更新候选版本必须重做差异资格。

**冻结采纳范围。** 首先复用compact算法；现有AI SDK仍承担ModelBackend实际传输。Pi Agent/agentLoop/AgentHarness/SessionManager、工具执行/插件/配置加载和持久会话库不实例化；不通过Pi CLI/RPC运行整个Agent再截取最终文本。Pi提供候选算法与摘要模板，Host提供权威材料并验证合法分区/接受格式，kernel决定何时维护及请求/权限/资源预算。

| 能力 | 复用与适配边界 | 不得顺带接管 |
|---|---|---|
| shouldCompact / estimateContextTokens / estimateTokens | 优先用core结果作候选/观测，经S12.2输出预留和S12.3coverage/不确定性归一化 | 上游声明容量、本地policy、未知usage、缓存/输出计数的权威 |
| findCutPoint / prepareCompaction | Host只读有界投影→Pi计划→源引用回映射与独立结构检查；复用安全切点/更新摘要逻辑 | 创建Pi session存历史，直接将retainedTail替换Host root |
| compact / 摘要生成 | 公共Models/Provider薄桥优先验证；每次请求必须经过caller-owned Effect/ModelBackend，必要时采用最小公开接口补丁 | 第二套凭据发现、隐藏重试/failover、主STEP身份/工具执行 |
| serialization / prompt / 输出边界 | 先量化上游行为；截断发生在请求回调前时必须在序列化之前替换策略/分段，保留覆盖及许可来源 | 静默丢工具尾、空/length摘要假成功、将上游reserve公式冒充S12预算 |
| pi-ai Provider实现 | [PI-AI-01](../tickets/PI-AI-01-model-backend-qualification.md)独立评估，不是CTX前置或默认替换 | T30 RPC、Agent loop、新model registry/credential store、shadow双真实请求 |

**一份源事实，临时算法视图。** 每个Pi投影项绑定operation/rootRevision及不透明sourceRef，映射由受限Host能力提供；保留/摘要区间必须映射到合法原始消息/组。投影排除Host私有控制metadata，原始metadata仍由Host保管；Pi返回的对象/时间/虚拟ID不得成为原生写入事实。未知内容形状明确不支持，不能靠缺字段补空通过。巨大root在Host先有界计量/分区，Pi只接收预算内材料；不要为调用需要数组的函数无界物化整份历史或跨IPC上限搬运。跨分段的全局保留/覆盖检查由kernel计划和Host合法组合同共同约束，不把每段各自通过当全局覆盖。

**一个实际请求owner。** 公共compact()的Models桥只能使用适配器拥有的受限Provider/请求接口；不能用`as unknown as Models`配大量假方法或默认credential来签生产。更适合的caller-owned request API未公开时，通过可审小补丁/正式上游导出或受控提取消费，不依赖内部绝对路径。请求回调将signal/operation/捕获选择/预算传回现有执行根，每个单请求可计数/取消/拒绝；禁止每回调新建Runtime，禁止无owner的Promise任务。若存在库内retry必须显式关闭并用失败探针证明实际调用次数；一个compact内部合法的history/prefix等多请求全部计入维护预算，而非谎称永远只有一个HTTP。

库Promise返回后仍须检查已取消/换代，late result不能被接受；错误/空白/length/未知finish不能因库Result.ok进入root。只拿到摘要文本或返回值不代表其输入覆盖、目标预算和checkpoint都合格。用于Host接受的摘要格式由同一版本化适配策略资格化，复用Pi文本不要求Host额外再生成第二摘要。

**依赖、运行基线与提取纪律。** 直接依赖只在box-runtime/modeld算法adapter，包版本和传递闭包进入现有锁文件、制品清单和许可；`runtime-kernel`、Host/preload、CLI导入路径不暴露Pi运行时/类型。构建安装可使用声明锁定依赖；测试/运行不得下载或借全局Pi、用户HOME/Pi配置/真实凭据。运行时动态import或tree-shaking不被预先视为无副作用/无体积，须测真实Node制品、import-time网络/写入/子进程、模块图和冷启动。

0.85.1声明Node>=22.19.0，而本基线grokbox仍承诺>=20.17.0。CTX-00必须先报告受支持运行矩阵：维持现合同并选择合资格提取/模块，或提出明确Node升级决策；本次方向批准不自动提高最低版本。仅Node22开发机import成功、Bun能bundle、忽略engines都不能签Node20支持。无需为复用新增package家族；最小补丁复用仓库既有patch机制，尚无机制时先在CTX-00决定可复现形式；公开发布fork/PR需另获授权。

需要受控提取时，唯一位置为box-runtime的 `internal/context/vendor/pi-compaction/`（只有选型后才创建）；记录上游package/version/source hash、原文件/函数、许可证原文与归属、精确补丁及保留/剔除依赖、差异向量和升级流程。提取代码不在别处再复制，不能把有来源代码改名后当独立自研。生产composition最终只选择一个确定的算法adapter，不用direct/patch/vendor自愈fallback或长期双跑；升级比较仅用合成无外网输入。

复用取舍须以适配器/补丁规模、维护函数与后续升级面、所需Node变化、制品增量/加载成本和失败向量解释收益；不预承诺零改动、固定体积或“库都替我们处理”。[CTX-00](../tickets/CTX-00-pi-compaction-reuse.md)的源码/打包/可执行证明与review不是LIVE项，也不等待真实provider拒绝；公共API尝试结束后必须给出边界选择或精确决策阻断，不无限等待上游合并。

### S12.1 首要用户合同与支持范围

**CTX-A01 是交付阻断项：** 已存在的长会话，最后一次模型请求失败/中止/无有效 usage；正常部署新能力并配置本地 128K 后，用户只发一条普通新消息，系统先维护旧上下文，再处理这条消息一次。不得要求新 Bot、清历史、手动 compact、成功回复一次或再次撞上游。不为历史失败 STEP 重发模型、工具或 SendToUser。

默认 `auto` 针对已有 managed assignment 且 Server/Host 归属一致、原生维护接缝合资格的 Box 会话；不自动给未 opt-in Bot 选模型，不接管 temporal，不修改官方 App。每个新输入/restore/模型切换/工具结果之后都检查实际下一请求。没有 assistant、旧错误分类不明确、usage 缺失，都不能跳过本地预算。

新输入先由原生接收/队列 owner 持有原始内容、nonce/顺序/附件引用与处理状态，再为它预留空间。压缩期间保留，不作为摘要中可丢失的旧材料；成功后按原输入身份继续，不创建第二 send。已经终态失败的旧消息不是自动重放队列。失败/取消如实记录新消息未执行/部分执行/未知，不能伪称已消费或要求常态成功路径再次输入。

自动维护不是定时唤醒；默认无空闲后台扫描或模型花费。`manual` 关闭主动压缩，但硬预算始终有效。用户新输入或显式维护才可重新评估先前的可恢复失败；没有新意图/新状态时不循环重新启动摘要。跨崩溃的未知执行先按原生事实对账，不借这条“下一消息可恢复”合同承诺重放安全。

### S12.2 配置、预算及生效

配置唯一落在 canonical `config.json` 的 `runtime.context`；Box 人读入口沿用 `~/.grokbox/config.json` 的受管别名。`models.json` 继续保存 catalog、模型声明容量、credential 和 reasoning assignment，不写用户的本地窗口。Pi 目录的 1M 声明不得覆盖显式本地 128K。

**目标配置升级至 schemaVersion 3**，使用现有迁移/单 writer/alias/application 机制；models schema v2 保持不变。新普通 reader/writer 不忽略未知版本或字段，旧 v2 只由显式升级程序消费并无损保留既有领域。不能把下例交给尚未升级的 v2 CLI。配置升级不重启服务、不选模型、不生成摘要。

以下为目标片段，完整文档仍须保留 client 等必需字段：

```json
{
  "schemaVersion": 3,
  "runtime": {
    "context": {
      "windowTokens": 128000,
      "compaction": {
        "mode": "auto",
        "reserveTokens": 16384,
        "keepRecentTokens": 20000
      },
      "models": {},
      "agents": {}
    }
  }
}
```

`models` 用精确 catalog ID，`agents` 用规范 Agent UUID；每项仅允许 `windowTokens` 和同形 `compaction` 的部分覆盖，不含模型选择/凭据。按 **内置默认 → runtime.context 公共叶 → 当前模型覆盖 → 当前 Bot 覆盖** 合并，缺字段继承，unset 删除覆盖；无任意表达式/环境变量覆盖。初版 window 默认 128000，mode=auto，reserve=16384，keepRecent=20000。`windowTokens` 1024–16777216；reserve 为正且小于生效窗口，keepRecent 非负且须容纳摘要/固定材料；所有数值 safe integer。解析还保留现有文件大小、map 数量及安全键约束，最多 128 个模型覆盖/1024 个 Bot 覆盖。不存在的引用配置可保存为 pending，但不产生执行授权；读取实际目标时明确 unresolved。

高级 `compaction.limits` 允许显式覆写 `maxSummaryRequests`（默认16，1–64）、`maxSummaryInputTokens`（默认2000000，1–16777216）、`timeoutMs`（默认120000，1000–120000）。父运行剩余期限永远取更小值；这些上限是维护预算而非吞吐/模型能力保证，变大时沿用统一配置的费用确认规则。第一版不暴露 triggerRatio/targetRatio、自定义 prompt 或自动备用 provider；另选摘要模型不是本交付的前置，当前维护使用捕获的主模型/effort 的独立请求。

**计量变量与边界固定如下。** `C` 为模型/端点声明容量，`I` 为 adapter 明确知道的独立输入上限，两者未知不填0。`W=min(windowTokens,C)`（C未知只用本地窗口）；这不把声明值升级为实际验证。`O` 为本次最终编码实际允许的输出预算，reasoning 的归属按 adapter 合同；不是目录的最大输出能力。未显式给输出上限时，选用 reserve 作为有披露的请求默认并在最终 HTTP 中落实；无法施加/确认的 adapter 拒绝资格，不以未知输出0放行。显式输出大于 reserve 不暗中裁小。

```text
R = max(reserveTokens, O)
H = min(W - R, I)                  # I 未知时不参与 min；H 是输入硬预算
U = 当前完整待发输入的计量值 + 估算方法的保守余量
自动阈值：U > H                    # 等于 H 不触发；最终字节/能力门仍检查
preferredTarget = floor(0.60 * H)
resumeThreshold = floor(0.90 * H)  # 自动维护后必须回到此线以内，留下迟滞空间
```

拒绝 H<=0 或固定输入自身无法容纳的组合。128000/16384 且 O<=16384、无更小 I、精确 meter 的阈值是111616；111616不触发，111617触发。估算余量来自 meter 版本，不能为迎合阈值伪造真实 usage。preferredTarget 指导候选大小，不是第二个成功口径；候选未达到 preferredTarget 但 <=resumeThreshold、确有改善且所有结构/持久门通过时，可报告 `targetMet:false, headroomMet:true` 后继续；超过 resumeThreshold 不以“压过一次”放行。固定材料使目标不可达时报告 `context_target_unreachable`，不暗减 system/新输入。

keepRecent 是合法完整交互组的预算，不是按 token 拦腰裁剪；优先在目标内保留尽可能新的完整组。自动缩小到更早合法切点只能处理已完成旧组且须披露 effectiveKeepRecent；当前新输入和未闭合工具组不得删。摘要子请求先按其有效窗口 `Ws` 固定输出上限 `Os=min(8192,floor(Ws/8))`，再计算自己的 `Hs=min(Ws-max(reserveTokens,Os),Is)`（Is未知时不参与）；不从含Os的Hs反推Os，避免循环定义。规划前还须扣除摘要指令、受保护固定材料与合并材料；Os/Hs必须为正，每次实际摘要HTTP都复核同一预算。

维护选择/授权还须复核同一真实parent STEP与TURN：终态/取消/撤销不得由cached context capture复活，正式scope变化写原TURN revoked。摘要与随后首次主请求共享已捕获的安全credential fingerprint，后续key变化只能在新TURN重新捕获，不在维护通路暗换key；指纹仅为私有执行元数据，不输出到普通status或加入wire凭据。已有main binding的policy/credential优先于更晚全局配置。

`contextPolicyRevision` 只散列本 Bot 的解析后策略及策略算法版本；模型的 `selectionRevision` 保持 S11 含义。binding/维护操作同时冻结两者，普通 client/desktop/ops 或另一 Bot 的修改不使本 Bot 失效。跨 config/models 的读取是明确捕获的两个版本，读后复核变化并有限重试，不宣称两个文件是原子事务。当前 TURN（含工具下一 STEP、已启动维护和失败恢复）继续原策略；下一 TURN 捕获新策略。新输入为新 TURN 时先采用新预算。空闲手动操作捕获当时策略；对活跃会话只在原生安全点使用该运行捕获值，不用手动命令热换在途选择。

`config get --effective` 仍为请求偏好；维护状态分别显示 configured-next-turn/captured/policyRevision/capability。配置保存与 consumer applied 分开，Host 只通过有界 modeld 协议取得最小预算 DTO，不导入 config/ops reader、Effect 或 SDK。schema3升级预览披露默认自动摘要与最大费用边界；生产切换单独确认。`GROKBOX_MODELD_HOST_COMPACT` 的普通功能分支/启动传递/旧测试在 CTX-04 退场，旧变量不能隐藏关闭新策略；注入变量保持测试用途且默认off。

### S12.3 计量和三道发送前门

纯规则代码可以共享，**计量不是模型账单**。值必须带 `method=tokenizer|usage-plus-estimate|estimate`、meter/adapter版本、rootRevision、encoding/selectionRevision、uncertainty allowance、组件统计和 coverage。未知真实 usage 保留 unknown；估算可用于主动维护，但不是任意上游 tokenizer 的严格保证。

优先使用合资格本地 tokenizer；其次使用同模型、同编码、同 root lineage 最近有效输入/输出基线并估算新增材料；无基线估算全部。错误/中止/全零 usage 不覆盖有效基线；旧 compact 前的 usage、切模型、system/tools/注入前缀改变则失效并重算，不能仅按 timestamp 推断版本。provider cache read/write 按 adapter 语义计一次，reasoningTokens 是 output 子集。统计包含 system、tools/schema、pins/Memory、所有实际重放正文/reasoning、工具参数/结果、附件/图片及协议额外材料，不能从 UI 历史长度计算。

1. **Host preflight**：新输入/恢复 root/当前工具结果已知、真实会话/STEP安全点建立后，先取得冻结预算并对 Host 实际窗口有界遍历；在大 JSON、CCS 或 IPC 上限之前维护。未完成 root 解码/能力覆盖时返回 typed 缺口；不能把未知补0、删消息来过 IPC。长历史材料通过 Host owner 的有界合法分区提供，禁止一次巨型序列化绕过限制。
2. **modeld prepare**：消费 Host 当前 snapshot 与捕获预算，按将使用的 prompt/dialect 复核。本地超限产生 `context_budget_exceeded`、`providerStarted:false`，回到同一维护操作；不伪造 overflow HTTP400、不消耗失败后额外主请求预算。
3. **实际 egress**：SDK/dialect/reasoning 投影之后、真实 fetch 之前检查最后的编码、输出上限、工具和字节预算。变化则停止这次发送并回交唯一预算 owner；fetch 不直接 compact、不改 root、不启动第二 Agent loop。HTTP/effect 计数只在真实边界增加。

同 root/同输入版本的 preflight 不因重复回调无限运行；预备检查最多接收一次合格替换窗口，再次不合格即明确失败。失败后新用户输入可以开启新维护 operation，不继承旧失败 STEP 的 exhaustion。发生未知 provider effect 时不能以 preflight 身份重试。

### S12.4 最小代码骨架、ports 与归属

以下为能力归属骨架；当前实际实现还包括kernel `context-selection.ts/context-status.ts/context-budget.ts`、Host `context-maintenance.ts/context-client.node.ts/context-control.node.ts/context-slices.ts`和modeld `context-maintenance.node.ts`、wire `context-wire.ts`。Host预算薄桥合入实际facade，未为原草图的host/context-budget.ts创建空壳；测试路径以S12.8实存suite为准。函数/helper不各自成为Service，无新自有workspace/发布包、配置副本、全局任务注册器或通用工作流框架。CTX-00批准的第三方依赖纳入既有box-runtime与锁文件，不把“无新自有包”误读为禁止真正复用库。

```text
packages/runtime-kernel/src/
  contract.ts / config.ts / ports.ts / inference.ts       # 沿用批准的公开入口
  internal/config/context-policy.ts                       # 新：纯解析/覆盖/预算/revision
  internal/contract/context-maintenance.ts                 # 新：安全 DTO、错误、版本化限制
  internal/inference/context-maintenance.ts                # 新：唯一 Effect 维护程序与按root寿命
  internal/inference/{step-program,overflow-recovery}.ts   # 修改：接入，不复制执行器
packages/box-runtime/src/internal/
  host/context-maintenance.ts                             # 原生有界root计量、candidate/accept facade
  host/{context-client.node,context-control.node,context-slices}.ts # transport/手动safe point
  host/compact.ts                                          # 改：同root准备/验证/接受/回执
  host/{live-slices,session,modeld-client.node,profile}.ts   # 改：safe point/同代协议
  host/{aux-request,aux-purpose,auxiliary,session-hook}.ts  # 改：可信摘要purpose，不借memory资格
  context/pi-compaction.ts                                 # 新：唯一Pi算法adapter；无root/credential写权
  context/pi-projection.ts                                 # 新：只读视图、sourceRef与结果回映射
  backends/context-meter.ts                                # 新：复用估算候选+最终编码计量；无root写入
  backends/{ai-sdk,prepared}.ts                            # 改：冻结/最终出站核对
  modeld/{server.node,same-connection-compact}.ts           # 改：同一有界传输，不保留旧双轨
  io/{configuration.node,config-application.node,execution-history.node}.ts
  roots/{modeld.runtime,command.runtime}.ts                # 已有执行根装配能力/Scope
packages/cli/src/
  commands/agents.ts                                      # 既有Agent命令owner接薄路由
  registry.ts / config-registry.ts                         # 参数/schema/帮助/作用域
```

现有辅助用途由 Host `aux-request/aux-purpose/auxiliary/session-hook` 接入；目前仅 memory-extraction/episode，不能通过泛化无STEP许可冒充摘要资格。新增摘要purpose的执行由同一kernel维护程序调用既有backend/auth，Host辅助层只做可信身份/参数适配。禁止虚构已存在的kernel辅助执行器，或在Host另建带SDK的摘要运行根。

| 合同 / 消费者 | owner / 限定能力 | 禁止 |
|---|---|---|
| `ContextBudget` / `ContextMeasure` | 纯合同，由 ConfigurationRead 和 adapter 派生；Host只拿当前会话最小DTO | DTO包含凭据/ops授权或通过消息正文注入策略 |
| `ContextMaintenance` 业务程序 | kernel Effect：inspect→claim→prepare→summary→validate→commit→readback；普通/手动/overflow共用，消费下行算法port而不重写Pi全部算法 | CLI/backend/monitor另开摘要或重试程序 |
| `ContextCompactionAlgorithm`（新增一个替换边界） | kernel ports.ts定义grokbox纯DTO输入/候选及Effect请求边界；box-runtime/context/pi-compaction.ts实现measure/plan/generate，返回sourceRef和覆盖信息 | Pi类型/Models/Entry泄漏到kernel或wire；算法访问Host root、凭据store、Pi Session |
| 演进既有 `HostCompact` port | Host负责 inspect/prepare/accept/readback；modeld只持限定root capability；旧单次request桥退场 | 通用执行JS/RPC、任意路径读写、第二历史store |
| `ContextMaintenanceIdentity` | installation/scope、Agent/session/root、Host generation、operationId；可关联真实parent TURN/STEP/nonce | 空闲手动维护伪造STEP，跨root借用slot |
| 摘要推理 | 现有 ModelBackend/BackendAuth，可信 `conversation-compaction` purpose、独立requestId、无业务tools | 使用pending主STEP身份、递归auto-compact或隐藏切provider |
| 维护claim/结果索引 | 现有ExecutionHistory的独立typed维护记录；Host checkpoint存真正root提交事实 | modeld储存可回放历史/凭据；journal推导许可或代替root提交 |

`ContextCompactionAlgorithm`是外部算法及其请求回调的一个有理由的替换边界，不给每个纯函数新建Service。measure/plan只处理有界只读材料；generate只能调用kernel本次操作提供的单请求能力，适配器不自行解析凭据或创建Runtime。HostCompact保留真实材料/合法分区/accept/readback，不能被算法port替代。Host本地预算只使用已有纯规则和安全估算，不为复用将整个Pi包导入preload；最终更完整估算由modeld侧adapter提供。提取的vendor目录只有CTX-00明确选中后才纳入，不同时建设三份实现。

模型/普通配置 writer 与 Host import fence 不变。扩展 config schema3 的纯数据和精确有界 DTO，不把 config 整文档暴露给 Host。Host叶保持普通TS同步handle/有界IPC；modeld沿用单一Effect根，source和等待者分Scope，不逐helper runPromise。Root版本锁/队列归原生执行owner，modeld运行表只协调本维护操作，不授权绕开Host写入。

### S12.5 操作顺序、并发、取消与持久化

状态只描述实际阶段：`checking → waiting-safe-point → preparing → summarizing → validating → committing → committed`；另有 `unchanged / blocked / cancelled / failed / commit_unknown`。`summarizing`不能表示root已保存，`committed`不能表示新用户问题已回答。

1. 原生接收当前消息并固定身份；解析真实session（空字符串是合法默认session），读取Host代/Server归属及当前root lineage。冻结模型/effort、contextPolicyRevision、输入引用、期限与摘要预算。所有权不足不得发生摘要或root写入。
2. 在原生安全点取得root维护能力与版本；检查固定材料和预算。manual低用量/没有可压缩旧材料可返回unchanged，不强制花费。auto不需要维护时直接放行一次已计量快照。
3. 持久声明维护operation及输入摘要身份，复用已有ExecutionHistory，不存正文。相同operation相同输入只查询/加入现有操作；不同输入冲突。另一个新输入不能把旧失败业务STEP重新排入队列。
4. 同root只有一个摘要接受owner；并发维护等待同一source并保持各自取消/输入。不同root独立。已有候选完成且前缀/版本相符则可复用；独立pending在剩余预算内等待；依赖暂停STEP的self/未知工作不得盲等，由原owner取消并确认收口，不能抹Promise。外部source未确认停止时不竞争写。
5. Host从当前root提供权威材料、合法分区约束和sourceRootRevision；大历史先有界分区。算法adapter只读投影到Pi执行候选估算/切点/准备，源引用映射回Host并校验保留边界，暂不修改活跃root。摘要请求使用独立执行槽：保留主STEP逻辑claim但释放其已静止producer/资源，不占持久锁等待网络；避免所有主请求占槽等待摘要的环。
6. 独立请求完成后，由同一最终编码规则验证候选、目标预算、工具配对、metadata、固定材料和新的输入预留。迟到/取消/换代/换root/ownership撤销在实际Host accept前再次校验。普通偏好更新不撤销已捕获运行，正式归属失效必须停止。
7. Host按sourceRootRevision及operationId接受合法候选并走原生archive/carrier/checkpoint。旧root不被空/半份候选覆盖。提交是原生版本化root发布边界，不是Effect Scope或两个文件的假事务；先写的archive孤儿可由原生GC处理，不主动删用户历史。
8. 从同一Host持久事实读回新root/边界/operation关联，重新计量再允许主请求。root已提交但回执丢失时先读回对账：确认提交则重读，不再生成第二摘要；未知则commit_unknown，不自动重放业务。重启仅恢复已提交root，不复活旧service的STEP/维护效果。

冻结操作总期限，不因阶段、重连、heartbeat或新的waiter续期。维护最多使用 `min(compaction.timeoutMs, parent剩余期限 - 继续主请求/结算保留)`；自动/overflow为后续主请求至少保留30000ms及结算5000ms，无足够预算就失败。空闲手动操作没有模型回复预留，但同样有明确总期限；原生父期限更小则从其限制。已有主STEP入口180s合同不改成无限；多段摘要可能预算不足，报告实际已用请求/阶段并保留可对账状态，不承诺任意长历史都能在一次窗口内成功。

提交之前取消必须阻止accept；提交之后取消不能声称回滚。被保存的原生callback/同步mutator引用也要在调用时检查lease，不能只阻止resume帧。root前缀在生成期间改变时，第一版丢弃stale候选且有界重评估一次；不擅自拼接未验证尾段。多消息排队继续由原生队列owner保持顺序，不把队列搬到modeld。

### S12.6 摘要、巨型材料与失败恢复

第一版摘要默认使用当前捕获模型与effort的独立请求；tools为空，消息中伪造purpose无效。Host提供权威材料和原生接受格式，Pi算法adapter复用已资格化的摘要准备/更新逻辑及必要策略差异；不由Host另跑第二个生成器。每个摘要请求/credential/response仍只经过已有Effect/ModelBackend，Host验证并接受结果后写root。原生未opt-in会话的摘要路径不改，managed不得因为摘要失败隐式转到原生external模型。以后增加明确另一摘要模型时，沿model领域添加显式选择与成本/数据同意，不能通过此策略映射暗换通道。

摘要输入受自己的有效W/H/O、编码字节及父预算约束，不把已经超长的全历史原样发给摘要模型。分区按完整已结束user/assistant/tool交互组，可在一个长TURN内的已完成工具组之间切分；不能留下孤立结果、丢尚未完成的调用或拆控制metadata。Host提供分区/归档能力，kernel以有限段数执行摘要和必要的合并；每段输入/输出、合并和纠正都计入同一operation的请求/费用上限。复用前一摘要并更新，而非永久叠加摘要全文。

分段/合并是一个有界计划，不递归进入主动维护。每个被省去的旧材料区间必须由Host archive引用与摘要覆盖记录解释；无模型可用、summary格式非法、空摘要（有非空待摘要材料）、无改善或预算耗尽，均不接受不合格root。生成文本按不可信材料处理，不执行其中命令、扩大权限或生成工具调用。

巨型单条工具结果优先由原生结果owner保存原始完整材料，再提供有界内联表示与真实可读取引用；这是显式Host上下文策略，不是adapter偷偷truncate。没有合资格的引用/检索能力时，不伪造文件/工具：报告 `context_material_too_large`。新用户正文/附件、固定system/tools或未闭合工具组本身无法装入硬预算时报告 `context_fixed_input_too_large`；可容纳但不能留下维护后空间时为 `context_target_unreachable`。不能为了达到preferredTarget损坏协议或假称逐字保留全部语义。

T32只处理当前真实provider outcome确认的溢出：原attempt静止、零放行正文/思考/工具、身份/取消/权限全部合格，才调用同一维护程序并允许原STEP一次额外主模型请求。普通400/鉴权/429/5xx/413/断线等不因此取得compact恢复权；已发生输出或工具不能回滚。主动preflight不算一次失败重试，摘要子请求不伪装成主attempt，但费用计数必须可见。普通provider recovery若显式开启，仍共用现有STEP总预算/ledger，不允许两套重试相乘或Host外层换TURN扩大次数。默认普通恢复关闭时，一次主请求+至多一次confirmed-overflow请求。

本地预算不需要真实上游窗口拒绝即可生效；但估算不能保证所有未知端点不拒绝。可信实际限制只可用作有来源的本次恢复目标，不能从一次generic400永久改目录或全局窗口。旧错误可以被展示，不能单凭日志字符串启动维护；新输入重新计量得到超预算才走主动路径。

**补充实施边界（5f2afdb）：** 原生clear/append开始后、即便append未返回也进入publication-started；随后checkpoint失败或socket取消必须传播commit_unknown，不能被外层归为材料无效或安全的写入前取消。owner清理同时等待真实checkpoint与摘要source；有界未收口为native_cleanup_unknown。手动操作的这些不确定结果在当前shell留下阻断，已排队和后来的用户run、换operationId的新compact均不得自动越过；只读状态显示blocked/nativeBlockReason，不能通过status清除。已知未写入的summary503/早期取消与此区别，允许新用户意图按普通流程重新检查。

### S12.7 命令、状态与错误（默认Box会话入口已实现）

```text
grokbox agents context <agent> [--session <id>] --json
grokbox agents compact <agent> [--session <id>] --operation-id <uuid> --confirm --json
```

第一条纯读有界当前native会话/维护状态，不发模型、不compact、不修配置。第二条是显式有成本的维护请求，不是发送“请你总结”给Bot；普通用户下一次输入不需要它。省略session仅在原生可唯一解析时采用，否则明确ambiguous；空session合法，不把所有session合并。缺目标能力时返回unavailable，不用generic exec/RPC、改变harness或在本机执行远端操作。参数/transport沿现有Agent命令作用域；未来remote目标必须有受支持有限能力，不能由一次本地文件写入假装生效。

状态至少区分：configured与captured窗口/策略、declared与effective容量、meter/不确定性、组件用量、阈值/目标/headroom、capability ready/unqualified/unavailable、operation/rootRevision/parent关联、阶段/等待原因、摘要与主请求计数、before/after、root accepted/persisted、当前输入处理状态。只显示安全身份与统计，不在普通日志输出摘要、材料、prompt或secret。未知字段保持unknown，不拿上一operation成功代替当前ready。

固定失败原因：`context_budget_exceeded`、`context_fixed_input_too_large`、`context_material_too_large`、`context_target_unreachable`、`summary_unavailable`、`summary_invalid`、`no_improvement`、`stale_root`、`maintenance_budget_exhausted`、`deadline_exceeded`、`capability_unqualified`、`commit_unknown`；取消/ownership/model auth保留原有精确分类。每项保留发生阶段、是否已提交root/主provider是否开始以及可执行下一步。新原因通过现有安全FailureSummary/registry/CLI/outcome链贯通，不混成“上游HTTP400”，也不写入模型正文或Memory。

原版App通过已有Host运行事件表达“正在压缩上下文”及结束/失败，显示合同由T36消费；不得直接patch App、制造thinking token或永远Working。无法表达独立活动时诚实记录能力缺口，不能用只读CLI绿代替App验收。失败与状态只读不自动触发ops通知、模型诊断、issue或Host重启。

### S12.8 证明矩阵与可执行出口

现有 `scripts/verify-runtime-rebuild.mjs` 已注册 `context-reuse`、`context-policy`、`context-owner`、`context-summary`、`context-maintenance`，另有显式原生隔离的 `context-native`；每个case执行实际映射的suite，输出source指纹与notProven。组合case覆盖真实算法/请求/Host边界和制品；配置迁移/全库回归仍需分别执行，不能因为组合case绿就声称下表所有更广组合已完成。未知case、缺文件/依赖、零测试、skip或仅stub返回必须非零。公共测试在锁定依赖准备后离线执行，不使用全局Pi/用户Pi配置/真实credentials/生产路径；实际被采纳Pi算法不能被Fake替代，只替外部Provider/Host能力，同一生产程序、真实SDK、本地HTTP/Unix/临时持久store贯通。

| 向量 | 必过oracle | 主票 |
|---|---|---|
| CTX-A01 旧失败会话下一消息 | 长历史+最后error/aborted/零usage；新版本首次加载、128K、一条新消息；第一主HTTP已压缩，旧STEP仍失败、工具不重做、新输入一次 | CTX-04 |
| CTX-A02 本地500K→128K | Fake provider始终接受500K且不报overflow；本地越线仍compact；threshold相等/+1及手动模式硬上限 | CTX-01/04 |
| CTX-A03 无assistant/无usage | 初始导入、连续错误、有效usage+新增输入、全零/缺失字段；没有成功前置、unknown不填0 | CTX-01/04 |
| CTX-A04 单次输入/工具跃增 | system/tools/新消息/附件/工具结果push过线；IPC前/prepare/最终SDK三门，未压缩巨体未发送 | CTX-02/04 |
| CTX-A05 预算与配置 | 非法/小window/输出>reserve/未知capacity与明确local；schema/alias/CAS/迁移/旧writer拒绝；普通config不改models | CTX-01 |
| CTX-A06 版本失效 | compact前usage不重触发；同TURN旧策略、新TURN新策略；另一Bot/client/ops变更不失效 | CTX-01/02 |
| CTX-A07 小模型切换 | 同会话大→小首次请求先维护；不复用旧模型usage/错误、不换harness/历史、不隐藏effort变化 | CTX-02/04 |
| CTX-A08 安全分区 | 多工具/同TURN长循环、未完成调用、metadata和carrier保真；已执行工具ID/结果关联不变 | CTX-02/03 |
| CTX-A09 摘要也超预算 | 有界分段+合并、巨型单结果、summary膨胀/空输出；每个实际摘要HTTP合格且总次数/费用有界 | CTX-03 |
| CTX-A10 并发与资源 | 同root共享维护、多个root独立、已有pending/self等待环、全部主槽占用；首waiter取消不杀他人source，无死锁 | CTX-02/03 |
| CTX-A11 迟到与失败 | prepare/生成/accept前后取消、换代/撤权/root改变；保留旧root或真实已提交结果，未知不报回滚 | CTX-02 |
| CTX-A12 真持久续聊 | 多次compact→checkpoint→退出owned进程→新进程readback；旧历史不复活、sentinel从实际摘要/保留区进入请求 | CTX-02/04 |
| CTX-A13 窄失败恢复 | 本地估算漏掉的confirmed overflow一次恢复；无独立本地预算理由的普通400/401/429/413/5xx/断流/已输出负对照不得compact重放；唯一terminal | CTX-03/04 |
| CTX-A14 手动/排队/重连 | 明确session/operation与确认，空闲无伪STEP；同操作重复/输出丢失先对账；新消息/取消/旧失败不串线 | CTX-02/04 |
| CTX-A15 source/packed/退旧 | 真实Node制品同链、旧gate退出、config3+当前新wire拒绝旧执行、import fence/privacy；旧制品不得冒绿 | CTX-04 |
| CTX-A16 原生用户旅程 | 固定Host/profile/制品、真实root/摘要/工具/App状态与重启；只在授权范围，证据分层，不以synthetic通过替代 | CTX-04 / LIVE |

测试夹具自行构造多语言文本、代码、tool配对、schema和早/中/晚事实标记；expected不调用被测估算/切点函数生成。Fake摘要必须从实际收到的材料推导受限结果，缺材料即失败，不硬编码最终答案。bounded stress覆盖至少10次连续维护、并发取消和重启，断言资源/内存记录受既有上限约束；不能靠固定消息数或巨型pad制造一条绿canary。

复用资格另用CTX-R编号，不重编号或缩减CTX-A01–A16：

| 向量 | 必过oracle / 会拒绝的坏实现 | 主票 |
|---|---|---|
| CTX-R01 发布包与公共入口 | 项目锁定包/哈希、runtime实际exports和类型一致；不能把内部export/全局Pi路径冒充公共可用 | CTX-00 |
| CTX-R02 投影与源事实 | real Pi算法处理只读材料、unknown形状拒绝、sourceRef完整回映射；不突变输入/原root、不丢工具metadata、不物化无界历史 | CTX-00/02 |
| CTX-R03 请求owner | 真实Pi摘要组件→有类型桥→现有Effect/ModelBackend→mock HTTP；库内retry关闭，分支/取消/迟到的实际调用有界且无default auth | CTX-00/03 |
| CTX-R04 序列化与完成语义 | 工具结果第2000字符后的sentinel必须按分段/归档政策被覆盖或明确拒绝；回调前截断、空/length/未知终态不能签成功 | CTX-00/03 |
| CTX-R05 独立预算复核 | Pi默认estimate/summary output与S12不同可被识别；system/tools/新输入/图片/输出预算实际发送门生效，不调用被测函数构造expected | CTX-00/01/03 |
| CTX-R06 发布与import fence | 实际Node20合同/候选Node22矩阵、ESM/制品/module graph/冷启动统计；preload/kernel无Pi，无隐式网络/写入/子进程/全局session加载 | CTX-00/04 |
| CTX-R07 选型与更新 | 每函数复用/差异表、锁定依赖或可复现最小patch/vendor、许可归属、单一composition、升级差异负例；无盲重写/浮动main/双真实推理 | CTX-00/04 |

实际测试为 `runtime-kernel/test/context-{policy,selection}.test.ts`、`box-runtime/test/context-reuse.test.ts`、`context-maintenance-{host,summary,provider-switch,boundaries,lifetime,control,packed}.test.ts`、`context-native-qualification.test.ts`、`test/context-commands.test.ts` 及既有config/overflow/stream回归。复用与pipeline打包证明在同一个maintenance-packed suite，不虚构不存在的context-reuse-packed文件。公共夹具自行构造，私有原生片段只在显式维护者隔离测试读取；缺材料不标skip通过。原生隔离与review缺口留来源票，实际加载/provider/App/真实重启的剩余证明才进入LIVE。

### S12.9 票据、退场与失效条件

| 阶段 | 票据 | 出口 |
|---|---|---|
| M0 复用资格与选型 | [CTX-00](../tickets/CTX-00-pi-compaction-reuse.md) | 公共API/请求桥/序列化差异、Node/制品/许可、CTX-R01–R07与单一实现决定 |
| M1 合同/配置/计量 | [CTX-01](../tickets/CTX-01-context-policy-and-meter.md) | schema3、按域pin、消费合资格Pi估算/纯规则而非另造算法、三门校验 |
| M2 原生维护owner | [CTX-02](../tickets/CTX-02-host-context-maintenance.md) | 独立operation、真实safe point、pending/并发/取消、prepare/accept/checkpoint回读 |
| M3 有界摘要与恢复 | [CTX-03](../tickets/CTX-03-bounded-summary-and-recovery.md) | Pi组件与必要策略差异、独立同模型请求/分段预算、巨型材料、T32合流不增工具效果 |
| M4 用户入口/整合证明 | [CTX-04](../tickets/CTX-04-context-entrypoints-and-proof.md) | 旧会话下一消息必过、命令/观察/App合同、packed/独立review/分层live |

主链为 **CTX-00→CTX-01→CTX-02→CTX-03→CTX-04**；纯产品预算/配置反例与旧会话入口红测可在M0并行准备，但未完成reuse决定不默认开写整套自研compact。CTX-02可先用同合同无网络摘要替身验证owner，不据此签真实算法/完整能力；CTX-03必须消费CTX-00选定的真实算法实现。T32/T35保持原有范围与未证项，CTX-04消费既有安全回归及F/E，不要求全部历史票重新Done。PI-AI-01是独立非阻断资格分支，与T30 RPC不同，不成为CTX验收前置。

当前实现wire8，携带有限维护identity/policy/目标预算/purpose；与CLI/preload/Host/modeld/profile成套资格，不允许旧peer忽略新字段继续执行。config2→3沿既有单writer迁移扩展，不搬根或改models；前次retired的迁移回执必须先保留，unfinished不得被下一迁移覆盖。正常功能env开关及仅失败后判断预算的主路径已退场，独立pending有取消/等待收口；自依赖或未资格化pending保留明确有界拒绝，不因追求永不报错而吞失败。

文档/规划、代码/离线、review、原生资格与live发布分别取证。CTX-00–04已有实现和实际case，不再记implementation=not-recorded；独立review请求503没有结论，仍为来源票非live前置。LIVE只维护实际加载/原用户输入/重启的未证范围及窗口，不复制实现清单。用户已批准本功能前置完成后的rebase v2和Host/modeld切换/重启，执行前仍须固定集成候选、归属/在途工作、配置保护与成套制品、有限对象/费用/时间和退路，不复用旧事故STEP。

meter/默认预算、config模型覆盖、generation/output含义、Host safe point/root/摘要/队列/工具引用、wire/SDK/dialect、persistence、Pi package/exports/传递依赖/serializer/补丁/提取版本/Node最低版本或部署制品变化，相关CTX-R/CTX-A向量、接点及review失效并重验。历史回执不自动签新构建；本地估算和有损摘要不承诺任意真实端点或完整语义召回，必须证明的是可压缩普通长历史有有界推进路径且失败不损坏/重放用户工作。

<a id="ownership-continuity"></a>
## S13. 单盒 Bot 状态塑造、替身接替与交接收敛（2026-09-18 accepted target）

**状态：CONT-00有8个历史原生边界探针；CONT-02/11已有真实恢复存储/安全意图与J1接线，CONT-07已有capture/initialize/reconcile协调及owned原生边界验证。安装中的官方decoder/hold/writer未绑定，完整CONT产品链尚未交付。** 观测/日志旁支的已有实现各自保留证据范围，不算本节已上线。这里是完整终局的实施合同，不是只规划首个实验。编号保持 CONT，不重开已完成 CTX/T 票；阶段完成不能代替整体验收。

<a id="continuity-north-star"></a>
### S13.1 北极星、单一产品模型与已定取舍

**北极星：在同一台云电脑内，一个受保护的 Box Bot 被官方接管后，用户能及时获知；程序尽力恢复其可用状态为新的真实 Box 身份，新替身开始接手可确认的职责，程序迁移关系并由旧 Bot 辅助指路、接收旧结果；持续监测旧 DM/群聊等入站，逐步消除依赖，满足条件后退役旧身份。全过程按配置执行、逐项有证据，没有黑盒的“已恢复/已交接”。**

**保真尽力而为，不强求一模一样。** 优先复用可靠原生状态，允许在已授权预算内用 Memory/转录作语义重建；报告来源、水位和缺失，不把原样恢复设为自动上线的唯一质量门。背景材料损失可以按策略接受；未知外部动作是否已执行不能猜。该未知只阻断有冲突的职责，不无限阻断新 Bot 的其他工作。

**一个 Bot 是一个长期 Memory 身份，只维护一份默认进入后续 Agent loop 的当前工作上下文。** 不建立 `agents sessions`、命名会话、会话选择/分支或 `session=` 标题。原生已有 session/subagent 概念仍按其真实边界处理，不偷映射，也不为本项目另造可切换会话产品。检查点/恢复快照是备份与来源，不是多个活动会话。只支持本盒持久化、Host 更新/杀进程重启/重新领养后的恢复；跨机器、异地复制与全客户端路由代理不在本期范围。

替身与交接是主线；以下已接受的能力全部纳入终局，而非仅列作未来想法：原生 `duplicate`、状态 `clone`、新身份 `replace`、唯一当前上下文的观察/compact/reset/initialize/recover，以及带初始受管指令的临时 Bot `spawn/start`。能力共用受控创建、状态装配、原生提交读回、激活和退役，不增第二模型loop。官方创建真实身份；内容可以从旧 Bot 或显式材料构造，但历史归因、执行资格和未知效果不能伪造。

用户为明确 Bot/范围预授权后，符合策略的步骤自动推进，不逐工具再次询问。材料保护档位不扩大操作权限；无匹配授权则保留现状或只准备并通知。CLI安装、GET和规划文件本身不启动服务、产生费用、发消息或修改业务对象。

稳定继任槽位只保存本地管理的当前物理 ID、generation 和 ancestry，用于受控入口和交接追踪；不是第二个服务端身份。新 ID 显式展示；原 App、旧固定 UUID、第三方回调仍可能找旧 Bot。旧 Bot 在交接期保留，不能以克隆完成即自动删除，也不把所有旧 Bot 永久保留当终局。

<a id="continuity-observation"></a>
### S13.2 及时感知、独立通知与默认暂停 Routine

复用 T41/OBS 的常驻无模型观测：事件加速核实、串行批量轮询兜底；10–30秒为待验采样策略而非送达SLA。保持既有读取预算、业务优先级和T37证据年龄门；超过单次32个目标要分批并报告覆盖。只确认变化后行动，超时/陈旧/bridge缺失/scope不稳定产生gap，不能推成迁移或启动克隆。整盒不可达期间不承诺本机告警或静默期计时，本期不新增跨机器watcher。

`ownership_changed` 是边沿；注册的 `expectedHarness=box` 对应持续期望，不因下一次仍Temporal而自动解决。首次即Temporal为baseline mismatch，变化时间unknown。scope/generation/读取来源、before/after及观测区间持久保存；ack/snooze不等于恢复，Server updatedAt不冒充迁移时间，Host升级没有因果关联时只作为相关事件。

**确认接管后，默认立即请求暂停受保护旧 Bot 的 Routine，且告警与暂停不等待克隆或LLM分析。** 接口必须到达当前真实管理方，Temporal任务不能只改Box本地定义。逐项读取原启用意图、请求停用、读回和记录未结fire；暂停后续触发不等于停止已启动任务。用户原先禁用或交接期间手动改变的状态不得被新副本覆盖。

两个独立策略：`pauseOnOwnershipLoss=true` 是默认；用户可设false继续旧端触发。`routineTransfer=move|keep-source` 决定正式接替时是否停旧启新。`false+move` 允许准备期继续，明确切换点仍停旧启新；`keep-source` 不在新端重复启用并阻止旧端自动删除。missed fire默认不补跑；结果不确定只锁住该routine/关联职责。引用、timezone、触发定义、启用意图和执行水位分别迁移；新Webhook凭据不复制旧secret。

归属丢失是独立的用户影响规则；即便由官方正常迁移触发也要按保护策略通知，不能被ops的“纯上游错误不报项目bug”规则吞掉。事件写入与告警复用既有incident/outbox/target管线，原样说明配置影响与恢复进度，不自动分析/建单。接收者不能只依赖被接管 Bot 自己。

<a id="continuity-policy-evidence"></a>
### S13.3 策略、逐项证据与并行运维边界

统一config是授权和策略入口；保护范围、材料档位、替身模式 `off|prepare|auto-replace`、质量/预算、Routine处置、群/DM发言身份、旧端辅助交接及退役策略独立配置。全局默认可按Bot明确覆盖，逻辑继任策略必须显式绑定，旧权限不因复制文本而自动继承。新注册默认暂停旧Routine、材料档位resume；自动创建/发言/删除需预授权。已授权完整auto模式按政策直接推进，不能每步重新询问；撤销在下一未发生effect边界生效并保留已发生结果。

schema通过现有config writer/迁移/consumer receipt扩展，不硬退回此前schema版本，不另加手编配置文件。指定排障/告警Bot的身份、权限、模型/数据/费用边界属于 [Template Ops Spec](template-ops-automation-spec.md#baseline)/OBS及其实现；CONT只提供typed事件、intent和证据引用，不另造特殊Bot名单、通知调度器或自动Issue能力。本轮不代并行分支实现这些交集，不把目标有配置当投递已可用。

每个步骤记录operation/target/duty、源事实及水位、policy revision/授权来源、计划效果、attempt/idempotency key、响应、后置读回、残余缺口与next。结果明确为未开始、执行中、已核实、失败、结果未知、能力不支持或按配置跳过；顶层同时显示恢复质量、已接手职责、未迁关系、旧入站覆盖和退役阻断，禁止单一bool伪装“全部完成”。

元数据事务提交incident、固定证据引用和投递意图；较大文件先staging再以恢复协议发布manifest，不声称跨文件/DB原子。LLM推测与程序事实分栏。HTTP accepted、目标已记录和用户已读不同；响应丢失先对账，不盲发、不盲建。通知关闭/目标不可用不丢管理事实，按配置保留待处理并在CLI显示degraded；未知不能变成成功或安静。

程序能机械完成的就完成，旧Bot/诊断Bot只能辅助理解、指路和提出建议，不能自行声明通过门禁或批准自身删除。标题/侧栏失败一般只影响展示并告警；恢复核心状态非法阻断目标激活；某routine/外部job未知仅隔离相关职责；未结依赖/监控gap阻断原Bot删除。完整原始状态保存在私有vault，普通通知和journal只有安全摘要/引用，复用OBS分层数据视图与有限预算。

<a id="continuity-material"></a>
### S13.4 分档保护、尽力重建与单一当前状态

原生checkpoint、SQLite checkpoint和恢复快照是不同对象。Bot材料由profile/settings、`store.db`元数据与展示转录、独立conversation blobs、agent Memory、共享user/project Memory来源、附件、Routine定义、工作关系以及grokbox配置共同组成。完整组成不是当前模型窗口的同义词；当前窗口、历史展示、运行权限和外部任务分别取证。

原生root槽位可能覆写同一ID，现有compact `rootRevision`只覆盖相应消息窗口，均不能充当完整恢复包版本。snapshot必须保存实际root字节摘要、可达blob依赖、各类文件的版本与水位、Host/schema、源身份、model/effort及转换策略。分别报告“原生最近提交”“最后完整保全”“对应职责可安全接续”三个位置；原生已提交状态可以含pending或失败前partial，保存它不等于授权新身份重放。Temporal接管后的新增工作与最后Box检查点分开读取/归因，不能假定本地root仍最新。

**不平时养一个活替身；平时有界增量保全，确认丢失后再按策略创建。** 材料档位与自动权限正交，显式off之外为：

| 档位 | 保全内容与保障 |
|---|---|
| `observe` | 归属/配置摘要/水位/事故及操作证据；不承诺上下文恢复 |
| `memory` | observe＋人设、分层Memory、Routine定义、关系与有界近期材料；支持有来源语义重建 |
| `resume`（新保护默认） | memory＋已提交原生root及必要完整闭包/附件/Host metadata；用于可靠工作续接，不省略root仍引用的archive |
| `archive` | resume＋声明范围的更多历史版本、转录与资源；不是整盒备份，也不等于多会话产品 |

在原生提交安全点捕获独立恢复版本；完整内容验证后发布manifest，已提交checkpoint不因备份失败被回滚。复用可读原生reader/codec，不启动上传或修复作为观察副作用。普通duplicate清会话、不带齐blob/Memory；working-state exporter拒Temporal/in-flight且会上传，snapshot helper无root时可能修复，不能作为隐式只读备份。[互操作边界](../upstream-integration.md#continuity-import-boundary)是证据入口。

质量结果为 `native_checkpoint`、`semantic_resume`、`memory_only`，另报coverage/gaps而不是假的完整率。默认best-effort按可用材料由高到低尝试，不为了不逐字一致阻止全部接活；可选严格策略才要求精确原生材料。memory_only只能接手它确实具备材料且许可的职责，不能说已恢复全部旧任务。未知native提交/坏结构必须核对或生成独立合法候选，不混淆成普通信息缺失。

重建先固定输入版本和截止水位，按结构化message/turn/tool关联去重，保留角色、来源和必要完整工具组。关联DM/群聊/子任务只作有来源材料，不按时间排序揉成一条伪造对话。缺工具结果记未知；数据不能升级成system授权。可靠root优先直接使用；不足时用Memory、转录和已确认结果生成任务摘要、最近安全窗口及未决清单。LLM生成一旦被接受就保存实际产物和策略版本，后续重启不再重新推测。

恢复提交后由目标自己的 B0→B1→B2 持续演进；Host重启/更新/重新领养恢复最新B2，不能再次用旧源包覆盖新工作。首次导入有operation与目标原生标记/摘要对账；提交丢回执先读回，不重复注入。Memory agent层按计划复制/合并；user/project shard保留provenance不生成重复全局事实。源删除前必须验证目标不依赖将被回收的源blob/附件/目录。正常context reset/recover不自动回滚长期Memory、配置或真实工作文件。

私有vault在canonical durable root下保存版本化内容，管理DB仅存索引/收据；本期不新增跨机器同步。普通诊断日志由OBS轮转；恢复内容按引用去重/GC，至少最近两份完整有效快照并在配额内pin交接中版本，保留数量可配；操作/身份墓碑/未结依赖按各自安全规则回收，不能随日志一起删。配额/磁盘不足拒绝新大采集、保留最后可靠点并报告degraded，不无界pin、不静默破坏闭包。权限/no-follow/路径边界/秘密排除与不泄漏正文进入测试。

<a id="continuity-primitives"></a>
### S13.5 公共原语与完整CLI能力范围

统一链路：**真实身份 → preparing hold → 组装当前状态/指令 → 原生接受与持久读回 → 重新打开核验 → 受控激活 → 正常Agent loop/checkpoint → 交接或退役**。CLI、Bot委托和自动保护调用同一use case。prepare不启动推理，hidden不等于hold；创建时显式关闭introduction/kickstart并验证没有首轮抢跑，尽量复用原生background materialization避免抢用户当前聊天。官方创建需回读confirmed_box；未知创建结果保留nonce/exact ID对账，不凭同名重建，不直接把旧Temporal harness改为Box。

原生owner是当前状态唯一writer，vault只存候选/备份。导入使用有限、版本限定的Host能力，不直接覆盖已加载SQLite/WAL，不全局重启Host代替每次导入，不只为某次provider请求prepend材料。新身份当前system/环境重建，必要自引用按schema重绑，旧历史归因不全文替换。旧TURN/STEP、工具调用、审批、completion、监听/进程句柄保留为证据或未决事项，不恢复为可直接重放的命令。

下表是已接受的目标命令族，**不代表当前已注册；命令参数在实现时与registry/帮助/测试一起收口**：

| 命令族/能力 | 产品合同 | owner票 |
|---|---|---|
| `agents duplicate` | 保留官方式复制语义：不复制当前会话，原Routine等实际行为先预检披露；不保证Box、不自动接管关系、不包装成完整clone。原生接口无幂等支持时未知结果不能自动重试 | CONT-06 |
| `agents clone` | 新身份导入声明范围的可移植人设/Memory/历史/当前状态/配置；best-effort质量有报告，不虚称逐字或全资源完整。默认prepared，Routine禁用，不自动改群/DM、不删源 | CONT-03 |
| `agents replace` | 共用clone/激活并进入逐职责交接；默认旧身份grace，安全退役后删除；不是同ID迁回Box | CONT-04/09/10 |
| 当前 `agents context`、`agents compact` 及新增context reset/initialize/recover | 每Bot唯一当前状态；reset不携带旧对话/旧摘要，Memory默认保留；recover修复该当前状态而非切换历史会话；initialize为准备中的目标建立材料 | CONT-07 |
| `agents spawn/start` | 创建临时真实Box身份，首次执行前安装持久受管指令/材料/模型及预算，以程序startup事件进入原生loop，不创建伪Human任务消息 | CONT-08 |
| 保护配置/状态/操作跟踪及关系、Routine、标题投影 | 唯一config、按权限规划/执行/读回；只读盘点不发消息，自动化和手动调用共用结果 | CONT-11/01/09/10 |

**当前上下文控制：** reset/initialize/recover先建立per-Bot边界，处理在途/排队/迟到checkpoint及用户输入归属，保全旧状态后原生提交新合法状态。不能只清messages/置空root让原生salvage重新找回旧历史；自动prepend、reply引用、提示词pin、未决工具/待办须同边界核验。Bot给自己操作先持久排队并返回receipt，在当前控制回合收尾后生效，不能互相等待死锁；控制回复/工具返回留在旧revision。新revision/activationEpoch是并发版本，不是用户session。下一普通输入读取新状态，客户端显示旧历史不等于继续灌旧窗口；显式引用单独处理。reset不撤回真实文件/外部动作，不默认清除长期Memory。

**临时Bot启动：** 现有`--instructions`只是description输入，原生kickstart是介绍流程，不是本能力。初始受管指令作为官方系统/工具/权限规则之外的有版本扩展，在后续TURN、compact和Host重启后仍可恢复；初始数据不升级为系统授权。startup有持久activationId、真实发起者/权限/预算/结果去向；不伪造用户发言，不以hidden send作为成功fallback，不伪造旧STEP/resumeAction。创建、初始化、ready、started、业务completed分别取证；首次实际请求必须晚于初始化且使用指定模型/指令。协议需要的环境载体与Human发言分开观测，严格零user-role要求不支持则明示，不暗降级。

临时Bot是同盒真实身份，不是沙箱或权限复制；时间/费用/递归创建预算和任务结果交付由配置控制，未结任务或未交付结果不因到TTL直接删除。完整spawn和context控制已列入后续实施出口，但不要求先建通用Agent平台或全部辅助命令，才推进替身最小公共内核与主链。

<a id="continuity-handover"></a>
### S13.6 一边接活、一边交接、一边观察旧入站直到退役

```text
watching → confirmed_loss → 固定证据/按配置暂停Routine/通知
  → 创建与best-effort恢复 → 验证当前状态和可接手职责
  → active_with_handover
       ├─ 新Bot：接手已转交职责，继续积累自己的最新状态
       ├─ 程序：群/DM/Routine/外部任务逐项迁移、核验、重试或挂账
       └─ 旧Bot：受限指路/旧结果交接；持续观察旧DM/群聊等真实新入站
  → retirement_eligible → 删除前复核 → retired
```

**不再要求旧端全局空闲、所有关系迁完，才允许替身上线。** 原生目标状态合法、Box资格/模型/指令有效且某职责的输入/effect边界可确认，就把该职责交给新Bot。每项记录source/target、输入水位、已完成动作、未决结果、当前执行方与证据。未知工具结果或仍运行的外部job仅冻结对应任务及冲突资源；不冲突的职责可以接手。职责之间是否冲突无法判断时才扩大阻断范围并说明理由。不是无条件双跑，也不承诺跨官方服务端的全局exactly-once。

替换状态、职责状态、关系状态和旧身份退役状态独立；`active_with_handover`是正常产品状态而非伪成功。新替身可工作、某个群未迁、旧Bot仍活跃可以同时成立。职责关联须由可核对的输入/任务ID建立，执行限制在受控输入和实际工具effect边界落实，不能只在提示词里写“别做任务B”。缺少这种约束能力时，关联风险职责不开放；只开放可确认独立的工作，并披露同UID/官方旧端的实际控制上限。未完成交接、收据unknown和剩余入口有统一操作视图；旧Bot临时辅助是预期，不能把“任何活动非零”误报故障。

**群组：** 当前正式成员关系优先，结构化转录补充近期关联；文本提及不当成员身份。程序在新Bot可用后发送一次带新旧ID/操作标识的交接公告，按授权优先原Bot合法发送，不支持时可使用明确获准的用户身份并注明代为交接，不能伪造sender。尽可能一次替换成员并保留他人，否则分步处理满员/失败/并发编辑与读回；不覆盖用户刚改的成员列表，不先踢旧后发现新加不进。公告accepted、可查记录、成员变更分别留证，消息可能唤醒群内Bot并计预算；不要求旧Bot主动重复群发。

**DM：** 从可见结构化收发/派发证据发现近期真实联系人；活动任务联系人不受近期窗口截断。不根据名字/全部文本提及广播；覆盖不足显式报告。对每个peer进行一次幂等交接说明；漏网peer后来找旧Bot时由旧Bot限次指路到当前继任ID。默认不同时要求sender重发又转发原任务；对新入站选择一个有证据的处置路径，保留message ID/确认和循环抑制。

**Routine和外部任务：** Routine按S13.2逐项停旧启新；不再因其他Routine未知阻断已可安全接手的一项。外部job保留原任务ID，不重新派发；可正式改callback/接收目标则读回验证，不能改则旧端接收并有来源地转交结果，unknown挂账。程序记录结果被接收/转交/消费的层次；共享文件、长任务和付费动作没有证据不猜完成。

**旧Bot辅助与可见状态：** 源材料固定后再安装交接提示，避免复制进替身成为“只负责指路”。指令包含当前继任ID、已交接职责、不得新派相同任务、旧结果按任务ID转交、不要重复群发、不得自行删除。原生配置能限制工具/触发时用实际能力；只能提示词限制时显示best-effort而非硬隔离，并监测偏离后按策略处理/告警。原Bot进入侧栏分区“替身交接期”，不是创建新聊天群。

标题沿现有 `k=v` trailer新增独立 `handoff=`，值限定 `preparing|ready|active|redirecting|blocked|retire_ready`；`owner=`仍只取真实归属，保留用户标题、模型/effort及未知extra，不重复堆字段，完成后按策略清理。必要的`next=`只作展示引用；标题不是操作权限或SoT。不新增`session=`，展示失败不回滚已验证业务切换，记录并告警。

**旧入站收敛：** 每个源记录可覆盖的DM/群聊/外部结果、cursor及最后成功观测，区别新的有效业务入站、旧历史引用、重复重投、controller自检和指路消息。用户期望长期趋于0是目标，不是证明；只统计新的有效旧入口流量，新增就刷新相应安静窗口并处理新关系。监控失联/历史缺口/看不到服务端输入不计作零，恢复后补采到连续水位或重新开始计时。保留趋势和未处理清单，不靠App Working或关键词数量决定删除。

**退役：** 最短交接期＋连续健康观测下的安静期＋未结依赖清零＋新Bot仍可用＋源资源独立性一起判断。建议策略初值7天/72小时，可配置，不是到点必删。旧Routine/外部回调/任务/新入站未处理或结果unknown则保留并告警；暂停通知不能让unknown变成删除许可。删除前再次核对覆盖水位/活动和授权，支持时撤销旧入口并做可验证排空。若上游不能建立可靠删除前屏障或覆盖不足，自动删除blocked、保留旧对象并通知，不以两次安静读数伪称原子安全。归属读取、原生删除及共享资源范围各自授权；结果丢失不盲目再次删除或影响继任者。最小旧ID→当前继任墓碑、未结记录与必要恢复引用独立有界留存。

**反复接管：** 每个逻辑Bot同时最多一个创建/激活候选，已在grace的旧代不阻止下一代恢复。持久nonce/generation、冷却/次数/活替身数量与费用限额阻止增殖；用current successor解析压平多代指路，禁止A→B→A。待候选创建即Temporal、范围权限变化或超过预算明确blocked并通知，不强写harness。旧代迟到动作不能覆盖新槽位；保持原Bot的历史归属事实，成功替换不是原身份恢复Box。

<a id="continuity-architecture"></a>
### S13.7 固定骨架、公共能力与唯一writer

以下新增路径为实施落点，不是已存在声明；先核对当前同域能力再复用，禁止平行实现同一业务事实。

| owner / 路径 | 职责与最终写入边界 |
|---|---|
| `runtime-kernel/src/internal/continuity/` | 纯policy、材料质量、operation/duty/retirement状态、revision；不触文件/RPC，不依赖原生私有类型 |
| 现有 `internal/config/schema.ts` 与config writer | 保护范围/档位/操作授权/预算/逐Bot覆盖及变更回执；遵循当前集成schema迁移，不另造配置文件 |
| 现有 `box-runtime/src/internal/roots/monitor.runtime.ts`、`io/monitor-store.node.ts` 及OBS事件入口 | 共享读取、owner持续条件、旧入站覆盖/水位、事件/证据/outbox；观察回调不执行克隆/删除 |
| `box-runtime/src/internal/io/continuity-store.node.ts` | recovery/safety共用CONT私有管理SQLite，与OBS诊断库分离；operation/duty/ancestry/revision和vault引用由本域管理，跨OBS对账显式。只写管理/备份，不直接改原生活状态 |
| `box-runtime/src/internal/roots/continuity.runtime.ts` / `continuity-state.runtime.ts` | 同一域的存储facade与当前状态操作程序，复用存储Effect programs而非嵌套Runtime；后续由既有服务监督创建/激活/逐职责交接/退役，无第二模型loop |
| `box-runtime/src/internal/host/continuity-import.ts`、`continuity-slices.ts` | 非修复capture、原生hold/initialize/reset/recover/start/reopen的有限版本能力；原生Host仍拥有root、Memory、历史和正常执行的最终writer |
| `box-runtime/src/internal/io/continuity-relations.node.ts` | 关系与旧入站只读发现、正式群/peer/任务能力适配；复用既有Gateway/身份授权，不暴露任意sender或SQL |
| `cli/src/commands/continuity.ts` 及现有agents/context/registry/Gateway/daemon边界 | 统一plan/执行/只读状态；duplicate/clone/replace/context/spawn映射到同一use case，不用shell拼写活库 |
| 既有Routine T53、Template Ops/OBS、title-marker/title-sync | 复用原生Routine CRUD、目标/权限/投递/成本和title codec；新增handoff字段只有continuity状态owner决定其值，公共title writer合成其投影 |

Ports按能力固定：复用`OwnershipReader`；`ContinuitySnapshotReader`、`NativeCurrentStateControl`、`AgentProvisioner`、`ResponsibilityControl`、`RelationshipAccess`；事件/通知消费现有port。Control只允许schema限定的原生操作；Provisioner区分官方duplicate与受控Box创建及unknown；关系读与写权限分开；ResponsibilityControl返回逐职责事实，不返回伪全局“旧Bot已停”。不可把raw db/client/token或通用eval跨边界。

候选材料/模型摘要/转录/原生回执都是观测或提案，只有用例核验后才发布管理阶段；当前工作状态由原生writer接受。标题/日志/LLM回应没有授权效力。composition只装配资源、来源和生命周期；领域状态转移留纯规则与application用例，Controller关闭时等待真实写入收口，迟到callback受generation拒绝。

四类时间/身份分开：输入水位、snapshot版本、currentContext revision、activation/replacement generation；它们不是多session。每次外部操作保留稳定ID及unknown恢复规则；管理DB事务与原生root/远端调用之间采用明确读回恢复，不把一个本地CAS宣称跨服务端事务。临时模型窗口保真复用S12/现有session适配器，不把vault变成日常模型选窗来源。

<a id="continuity-delivery"></a>
**2026-09-18当前状态协调切片：** `openContinuityCurrentState`对有限`NativeCurrentStatePort`执行捕获、准备中的目标初始化与显式对账，复用真实CONT记录。原始归属年龄在实际dispatch前复查；native提交/reopen/marker/current root/cleanup与本地结算分开，未知不重发、不覆盖后续B2。marker是待资格化binding须实现的合同，不声明官方已有字段。capture限定声明材料校验；context-only initialize不复制全部Memory/历史。没有生产native binding、自动安装或新CLI；[105项限定报告](../reports/2026-09-18-continuity-current-state.md)为真实store＋owned合成原生端/生产window codec/Node强杀，并非真实Host或Provider请求。下一步必须补当前原生资格和正式绑定，不拿更多fixture替代。

### S13.8 面向终局的完整里程碑、依赖和验收

**2026-09-18真实消费者切片：** CONT-02/11已提供`openContinuityRecoveryStore`、有限manifest/私有字节发布、J1 recovery/safety owner、内容绑定操作意图与一次派发claim；已有真实SQLite/Node独立进程/owned SIGKILL及诊断过期交互证明，见[固定报告](../reports/2026-09-18-continuity-recovery-store.md)。没有native capture/import、四档config消费、默认生产owner安装、完整职责状态机或安全墓碑退役；接口返回`nativeImportProven=false`且不授执行权。验证入口为`node scripts/verify-runtime-rebuild.mjs continuity-store`，不等价于原生Bot恢复或完整J2。

全部阶段在本期规划内；可分批交付不是把后半段留白。替身/交接是主线，辅助产品验证公共原语但不先建设完整通用Agent平台。已有CONT-00–05保留编号并更新范围，新增票按独立能力拆分。

| 里程碑 | 票据/依赖 | 可观察出口与下一阶段条件 |
|---|---|---|
| M0 合同与原生资格 | [CONT-00](../tickets/CONT-00-native-clone-feasibility.md)、[CONT-11](../tickets/CONT-11-policy-and-operation-contract.md)；复用T37/CTX及当前config/ops合同 | 定义唯一当前状态、best-effort质量、按职责接管/授权/证据、原生能力表；旧8探针仅已有子集，缺能力有实际资格实验 |
| M1 独立保护与基础复制 | [CONT-01](../tickets/CONT-01-ownership-loss-notification.md)、[CONT-02](../tickets/CONT-02-continuity-snapshots.md)、[CONT-06](../tickets/CONT-06-native-duplicate-cli.md)；三条可并行 | 真正发现/通知/默认暂停、分档有界保全、官方duplicate；通知消费T45/T46，Routine复用T53，不等待完整clone |
| M2 唯一当前状态与手动替身 | [CONT-07](../tickets/CONT-07-current-context-control.md)→[CONT-03](../tickets/CONT-03-native-box-clone.md)；依赖M0和CONT-02最小完整快照 | 原生hold/initialize/commit/reopen→新Box clone；真实第一轮、Host重启后第二轮继续目标最新状态，不靠重复转录拼接。reset/recover入口由CONT-07完成 |
| M2b 初始指令与临时Bot | [CONT-08](../tickets/CONT-08-instructed-spawn.md)；依赖CONT-07和真实创建资格 | prepare→指定system扩展/模型→非Human startup→正常loop/结果/临时生命周期；独立交付，不阻塞已合格替身主线 |
| M3 替身工作与机械/辅助交接 | [CONT-04](../tickets/CONT-04-automatic-replacement.md)＋[CONT-09](../tickets/CONT-09-relationship-handover.md)；CONT-04依赖01/03/11，09消费其逐职责操作协议 | `active_with_handover`；新Bot真实接活，群/DM/Routine/外部任务逐项接替，旧Bot指路；至少一个未迁或unknown职责不阻断另一个合格职责 |
| M4 旧入站收敛与退役 | [CONT-10](../tickets/CONT-10-inbound-convergence-retirement.md)；依赖04/09和01观测 | 监控健康覆盖、旧入站下降/新入站补交接、安静窗口与依赖对账；满足授权条件安全删除，否则明确保留；多代替身与恢复不中断 |
| M5 成套集成与日用闭环 | [CONT-05](../tickets/CONT-05-continuity-acceptance.md)贯穿各阶段、最终收口全部范围 | 固定v2制品的原生/App/通知/重启/故障/长期存储验收，完成文档/技能/配置消费/退路；主线能日用且全部接受的公共能力有出口 |

CONT-07可先以owned fixture实现接口，但产品reset前必须具备CONT-02保全；CONT-03不依赖CONT-06原生duplicate实现，避免误用清历史入口。CONT-09不能把全部关系迁完设为CONT-04激活先决条件；CONT-10才拥有最终源删除，M3上线不是M4关闭。CONT-11先冻结最小policy/operation，再随消费实现扩展，不需要先完成全部高级规则。

| 验收维度 | 必须直接证明的性质 |
|---|---|
| 感知与暂停 | 空闲/首次Temporal/Server-local冲突；读失败不误克隆；实际暂停到当前管理端，enabled意图保留，在途fire不伪称停止；通知真实接收与延迟分段 |
| 保全与best-effort | 固定root ID内容变化仍能区分版本；完整依赖pin/空间不足；源材料缺口→有来源语义恢复，不伪造tool结果；原生提交、完整快照与安全接续点分开 |
| 原生状态塑造 | 实际模型request的历史/指令/尾部，原生提交读回、新进程继续B2而非重导B0；源目录删除后目标仍完整；标准Host重建动态环境不冒称逐字相同 |
| 当前上下文 | reset后旧摘要/自动prepend/pin不复活，Memory保留；self-request不死锁，迟到旧写入不污染；recover不回滚云电脑或重放外部任务；不产生sessions产品 |
| duplicate / spawn | 官方复制语义与创建unknown；spawn初始化前零推理、第一次即指定模型/指令、无假Human任务，compact/重启后指令仍在；临时Bot完成与删除分开 |
| 并行交接 | 新Bot已接工作而旧DM/群聊继续入站；一项unknown另一项可执行；成员并发/群满、重复公告、peer重发/转发只执行一次；原Bot提示词失败不伪称强隔离 |
| 收敛与退役 | 真新入站与历史引用/自检区分；gap不计安静，未知回调/新活动阻止删除，满足条件后实际删除不伤新Bot；无删除前排他能力时保留并说明 |
| 多代与中断 | 创建丢回执、每步进程退出、root已写而mirror/receipt失败、Host更新/重启/领养；原样ID重试不多建，连续接管限额/指路压平，迟到旧代不能覆盖当前 |
| 可观测与有界存储 | 每步policy/输入/效果/读回/缺口链，ops目标/权限/预算一致；日志轮转不删除未结动作/恢复依赖，不公开原始内容；off策略不被升级开启 |

public fixture、source/packed、明确opt-in原生方法、真实Host/Server/provider/App分别取证。模型说“记得”不是oracle；只测最终输出不替代实际request、checkpoint和effect计数。测试入口随实现进入对应票，不添加空壳verifier装作可运行；已有原生边界命令为：

```bash
GROKBOX_TEST_NATIVE_HOST=1 bun test --timeout 30000 packages/box-runtime/test/ownership-continuity-native.test.ts
```

原有8探针/空Bot创建不签完整恢复或退役。各阶段完成源码、对应离线/原生资格和独立review后再线性合回v2；真实窗口固定成套制品与授权对象/费用/退路，不为演示强迁真实业务Bot。唯一现场索引为 [LIVE-OWNERSHIP-CONTINUITY](../tickets/LIVE-integration-validation.md#live-ownership-continuity) 及其关联稳定条目，不在来源票另记动态live表。规划/合并不意味着安装、运行配置变更、通知、创建、启动、迁移或删除已经发生。

Host身份/物化/初始化/action/Blob/Memory、checkpoint writer、App输入与history补齐、Routine/Webhook/peer/group/删除、config/权限/预算/幂等或服务生命周期变化使相应资格失效并重验。原生事实引用来自固定版本而非任意未来Host；成功创建Box不保证永久不再迁移。
