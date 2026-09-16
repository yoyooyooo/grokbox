# Box-runtime 单轨重建实施规格

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**Current Implementation Spec · accepted target · 2026-09-12 Server归属/Host-only与持续观测路线已治理至T41/V30；当前实施子集以Ticket和readiness为准。实现核对基线 `pre-publication-revision` 上的工作树（不是当前部署版本）。** 本文拥有目标包/模块树、内部端口、执行合同、退场边界和实施证明。[plan](box-runtime-plan.md) 拥有策略、Phases 0–4 与产品出口；[ADR D1–D12](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md) 保留产品/信任边界；[新票据](../tickets/README.md) 承载切片与证据。源码/可执行测试拥有当前实现真相；本文不是已实现或已部署声明。

本批次采用 owner 指定的**破坏式、单轨重建**。POC 是研究素材，不是 grokbox 内部兼容面。保留 Host 产品行为，放弃 POC 的内部 API、目录、response-only 路径与旧 wire 兼容承诺。本文取代 plan 中旧内核、旧 wire 或旧 status DTO 的过渡保留口径；不削弱 ADR D1–D12 的安全要求。

<a id="stable-delivery"></a>
## S0. 当前交付：真实 Grok Bot 的限定范围稳定换模

2026-09-12 owner 确认继续实施，并要求**先治理本 Spec/Ticket，核对回收旁支，再继续源码**。R2 草案已经合入本节；ME-01–ME-08 仅是输入映射，不创建第二套 Spec、票号或进度账。旧 owner brief / path / handoff 只保留历史诊断，不再阻塞于 A/B/C 战略选择。

### S0.1 用户结果与范围

**2026-09-12 owner 最新裁决：生产模型锁定 Pi `ccs-sub2api-xai/grok-4.6`。** 复用已经成功的凭据/Responses 协议资格，不再把模型选择、luna 额度或更多 provider 调研作为主线。目标是补齐并验收真正生产会经过的全部链路；遇到运行时障碍应定位首个失败 owner 并修复，不用可绕过的 mock/短会话或简单 pong 降低发布门。允许必要的 Host/modeld 切换与已命名测试 Bot 的有界 CLI e2e；不绕过工具安全拒绝，不以授权代替结果证据。当前施工先执行T37归属准入和T38身份写入收口，再接T24可逆选模、T39原生往返与T40持久发布；T32/T35已实现机制复用，其真实恢复/后台摘要差额仍是长会话门，不用新治理掩盖旧缺证。

尽快让用户在真实 Grok Bot 中按 Bot 独立选择并持续使用自定义模型。权限、上下文安全和不重复副作用不可退让；架构泛化、更多 provider、完整自有 Harness、WebUI 美化不是先决条件。首版限定当前机器、一个已资格化 Host profile/固定制品、已核验模型/endpoint 及批准 Bot；支持模型清单与运行版本由 [readiness](../maintainers/t32-live-enable-readiness.md) 保存，不从模型名字猜容量。

- **体验检查点**：已有安全普通窗口、续聊和基础工具可先验证；未合格恢复保持关闭，不称长会话稳定。
- **稳定日用检查点**：两个 managed Bot 的不同选择、未配置 Bot 负对照、普通/工具多 TURN、首请求 overflow 恢复、恢复后续聊、实际会经过的 Memory/episode、checkpoint 后新进程恢复，以及正常配置持续生效/安装/停用退路。日常链路不能静默关闭以缩小验收。
- **后续扩展**：更多 provider/Host ABI、非当前旅程必需的 proactive 泛化、完整工具/存储 writer 接管。任何晋升关键路径的工作必须指出当前用户场景和首个失败状态。

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

**当前第一片（2026-09-13）**：`runtime monitor`通过显式确认init/run与纯GET，组合稳定scope的单次批量读取、SQLite观察事务、持久incident/ack/snooze和提交后的本地changes；只读查询不打Server。policy唯一位置为kernel `monitor.ts`：默认30s/10–300s，单读10s，失败退避+正抖动上限300s，观察90s变stale；最多32目标、200项页、16MiB镜像/50000事件、snooze24h。SQL引擎固定sql.js 1.13.0 asm，短独占writer锁、export+fsync+rename+目录fsync，并非原生WAL；不升级Node20运行下限。`dist/observation-sqlite.cjs`按需加载，不进入Host preload。限定小规模镜像存储而非无限审计；未知提交按稳定管理requestId对账。当前没有硬崩溃锁回收、自动retention/schema迁移、跨准入优先调度或外部通知投递；`local_only`和`productionAccepted:false`不能删。具体操作/故障入口归[观测维护页](../maintainers/continuous-observation.md)，正常启动/停止不是安装自启证明。

**依赖**：T37先完成共享事实与真实门；T41可与T38/T24/T39并行，复用T25/T40长期服务安装能力。T40签持续生产时验证T41单盒最低监控闭环，T37开发和普通推理不依赖DB，T41不等待T40整票放行。T29仅在前端排期后消费；共用ConfigurationWrite的revision/冲突合同现在明确，真正第二写入入口落地时实现，不造UI-only writer。没有T41或没有外部通知渠道的运行应如实说明监控范围，不把future能力列入已完成。

### S0.2 最小完整控制边界与用途

复用现有 `runtime-kernel` 的 STEP program/ledger、binding、auth 和 v4 同连接，不增加第二 orchestrator、Context Store、Memory writer 或 provider loop。Host 侧的 **Managed STEP Scope** 是 T35 的生命周期边界，不强制新类、包或服务：在 provider 开始前取得真实有效 root/ctx/身份、协调本 root 的摘要入口，退出时释放并使旧能力失效。Host 保留摘要策略、root/归档/checkpoint、工具、Memory、SendToUser 的实际 writer。

| 用途 | 本阶段模型/owner |
|---|---|
| main attempt0 / attempt1 | 当前 Bot 的同一受理 TURN/STEP/binding/selection/ServiceEpoch；至多两次 managed attempt |
| dedicated compact summary | Host 专用 external；不回到等待中的 managed STEP；不是主模型 fallback |
| memory-extraction / episode | 已接受 F5 purpose、独立 aux id/生命周期、来源 TURN 捕获选择；Host 写 Memory |
| tools / native subagent | 原 Host 工具与子代理选择语义；不声称所有子代理已换模 |
| 未 opt-in Bot | 原生官方路径；不消费 managed recovery 能力 |

**续聊投影**：Host state 保留实际 plain reasoning、tool-call/result 及其顺序。当前 CCS 协议将已知纯文本 reasoning 按与工具历史相同的带 type JSON 文本投影，流式/非流式共用同一转换函数；不得因为 OpenAI SDK 缺原生 itemId 就静默丢弃，也不得伪造 itemId/签名/加密内容或把未知 part 变空文本。该 provider 投影不反写为 Host state；opaque/native-only reasoning 仍需独立资格。

期望模型修改在**下一 TURN**生效；当前已准入 TURN 及其恢复沿用捕获选择。权限撤销与下一 TURN 配置变更分开，撤销必须 fence；当前实现若仍将普通配置变更当旧 TURN 失效，这是 T24 的差额，不偷偷改产品目标。容量、vision/tools 和 usage 走 canonical model/adapter 合同；未知不能变成估算的“已资格化”预算。

### S0.3 T35/T32 的恢复完整性

1. **先就绪后启动**：STEP 身份、root、ctx、disposer 均已初始化，slot 真实可用才启动 provider；late-register 或占位 slot 不能合格。
2. **同 root 摘要协调**：managed 执行/恢复期间不允许 approaching-limit、responseSummaryLaunch 等旧自动入口并发接受同 root。已有独立可完成的 external summary 可在启动前有界收口并重取窗；self/未知依赖不盲等、不删除 Promise。官方分支原行为不变。常见路径永远 blocked 不是完成。
3. **唯一预算 owner**：kernel 只在已确认 structured overflow、attempt0 静止且未放行正文/思考/工具时借 Host compact 一次；Host 外层不得增发推理 retry，不换 STEP 绕 ledger。
4. **统一期限**：当前 grok-4.6 生产候选的单 STEP 硬上限为 180 秒，Host/client/modeld 使用同一 canonical 常量，不由各层再续一个完整周期；admission/partial socket 的短期限不变。父执行剩余预算覆盖摘要、snapshot 校验、attempt1 与结算预留。传递剩余预算后接收侧建立本地期限，发送方仍判最终到期；不能比较跨进程 monotonic 原点，不能靠进度无限续租。固定 5 秒或单纯调大等待不构成修复。
5. **root 接受 fence**：摘要开始前取消可证零 invocation；开始后不得假称零 effect。root 接受前检查其 owner/身份/期限；旧授权不能提交到新活 root。root 已改就如实记录，断连不叫回滚；未能确认的 native 工作隔离到受影响 root，不能全局堵住其它 Bot。`Promise.race`/禁发 resume 不是 commit fence。
6. **合法新窗口**：从同一 active root 回读、保留 carrier/metadata/system/tail/tool 关联，验证 snapshot 与目标预算。字符串返回、消息数下降或 digest 变化不单独证明改善。只允许原 binding 的一次 attempt1 与一个逻辑 terminal。

现有小补丁足够就复用；无法控制摘要接受/外层 retry 时取得必要接点或接管完整相关 runStep 段，而不是堆 timer。具体 release profile 的 exact SHA/唯一 anchors/生命周期/旧入口退出由 [T32 seam qualification](../tickets/T32-host-compact-seam.md) 证明，未知路径仍不部署。

### S0.4 验收矩阵（定义要求，不声明全部已通过）

| id | 必须验证的场景/反例 | 执行 owner |
|---|---|---|
| V01 | A/B 不同模型、C official；实际请求隔离 | T24 / readiness |
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
| V12 | 能力启用范围与故障注入范围分别约束；多 Bot 并发无等待环 | T32 / readiness |
| V13 | source 与实际 packed 相符，旧 SHA/profile/缺 case 不绿 | 连续性 F6 / readiness |
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
| V27 | 固定候选、独立review、实际支持矩阵与限定Bot放行/停止条件；必需缺证不签生产 | T40 / readiness |
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

ME-01 → 本节/票据索引的基线与旁支核对；ME-02 → T24 与连续性 F3；ME-03 → 连续性 F1/F2/F4；ME-04 → T35 与 T32 seam；ME-05 → T32；ME-06/07 → T32 [readiness](../maintainers/t32-live-enable-readiness.md) 的制品/真实放行检查点；ME-08 → 连续性 F3/F5/E04–E11 的日用子集。交接只链接这些 homes，不另记完成态。

当前施工与交接以[S0.1.2](#server-authority-rollout)和[Ticket索引](../tickets/README.md)为准：**T37 → T38 → T24选择差额 → T39（合取T26/T32/T35/T36）→ T40生产放行**；T40隔离服务实现可并行，不制造环。新增T37–T40承接不同职责，不是改名重做旧票。此前E09与恢复代码证据复用，不重做已有功能。export已有port则复验不重做；旁支commit不等价于代码差额。固定单一候选与验证输入后再阶段收口，清理前保全dirty/untracked与活跃引用；主仓库Git数据和v2工作树保留。

owner 允许实施、阶段提交、必要旁支回收和安全清理；不是无限live/费用授权。test0可用于确认box的正向候选；**test2当前仅保留冲突诊断/负例，不再作为正向managed/heavy模型探针**，其未来修复影响另行确认；test1不opt-in。新正向测试Bot须明确创建并经Server确认box，不能默认扩展到业务Bot。每个live窗口固定候选、问题、成本/停止条件并先满足离线/独立review门。不得手清 circuit、重放未知 operation、无目的 unload 或扩大到业务 Bot。临时试验结束复原并关闭注入；持续正常 rollout 须有明确 Bot 范围，不能拿历史 GATE 解锁当永久全局启用。

<a id="scope"></a>
## S1. 实施模式与硬边界

1. **只有一棵目标树、一套业务程序、一份当前 wire 合同。** 禁止 `legacy/`、`vNext/`、平行 kernel、旧路径转导新路径的 re-export shim、`old || new`、`effectMode` 和长寿命 migration flag。
2. T20 先做实体切割：转移仍成立的纯规则/控制机制，移除旧推理执行链及调用入口。旧测试先提取 expected vectors/oracles 到新 owner 的合成 fixtures 并指定后续激活票据，不继续 import 退场 API；未激活向量不可计作通过。尚未接好的推理/控制能力在 composition boundary 显式 `runtime_not_ready`，不能借 POC 兜底或返回 fake success。T26 必须消除推理占位，T28 必须消除控制占位；占位不是可发布功能，也不是保留旧内核的 feature flag。
3. 中间提交可以是**可编译、能力未齐**的单轨版本；不得部署到现役 Host。每票只声明实际证明的能力。删除测试或跳过断言不算恢复能力。逐票从相同目标路径装配，不创建一个完成后再搬家的新实现目录。
4. **Grok Bot Host** 指上游进程，继续拥有 root/上下文选择、compact 策略、session/store、Agent loop、工具、Memory/Transcript、SendToUser、官方 renewal 与 Gateway publication 的实际 writer；managed STEP 的准入、attempt/recovery 预算归 kernel，Host 摘要调度/接受按 S0.2–S0.3 受控委托。**grokbox root** 指自己的 CLI/modeld/console 执行根，两者不得混称。
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

`box-runtime` package exports 只有 `./runtime`；移除原 `.` mega barrel。preload 由 pack 脚本直接构建，Host 私有模块不是其它 package 的 API。kernel 只开放上述八个显式 subpath；不导出根 barrel，不开放 `internal/*`。

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
| `HostCompact`（T32） | `ports.ts` 定义请求新 Host snapshot 的 Effect capability；v4 server 的**当前 STEP/连接** adapter 发 compact-request/等 resume-step，Host 侧由 `host/compact.ts` 调用批准 delegate | 仅 overflow-recovery 消费；不在进程全局、CLI/API 或 backend 暴露，不成为第二 compact executor |

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

**Phase 1 只接受 v3**；请求包含 version，有限类型为 health、run-step、cancel-step。T32 将同一当前 wire 一次性升级至 v4，以支持当前 STEP-scoped HostCompact 能力的同连接 recovery 往返；不维护 v3/v4 并行 server。旧版本明确拒绝，无 feature negotiation 降级、旧 complete codec 或兼容 server。健康探测不读取模型凭据、不验证 activation，也不因旧协议不响应就删除其 socket。

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
| admission wait / partial socket / request wall deadline | 当前Server-backed准入为10.5 s（ownership读10 s + 原local预算0.5 s，作为一次复合上限）；partial socket仍1 s；STEP总期限仍180 s，modeld流只用扣除准入后的余量，不再另开完整180 s；证据5 s年龄与2 s缓存独立判定，慢RPC不更新证据起点 |
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

当前`command.runtime.ts`用Effect Scope把route配置预检、root-qualified acquire、唯一配置保存、未确认reconcile、status/output和前台lifetime合成一个命令程序；CLI仅组装signal/root/输出。开始写出的canonical desired不因后续失败自动回滚，取消不能遗留脱离Scope的写入；cleanup_gap不得吞成正常退出。`configRevision`与reconciliation/status分别说明保存和观测，`productionAccepted:false`、不安装自启、不触发adopt仍明确。source CLI/Unix和实际Node制品的start/borrow/orderly-restart现已有有界证明；不把它升级为安装自启、真实凭据推理或当前Host/App上线资格，最新结果归T40/readiness。

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
### S6.3 T32/T33 recovery / diagnostics

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

当前`ownership-admission`、`identity-alignment`已增加source case；另有T24的`model-selection`覆盖owned官方对象/Chat/Responses往返。前两者与选择case均在报告保留原生迁移、writer退场、真实官方/checkpoint/App等未证边界；case通过不自动关闭整票。下面`model-roundtrip`与`service-release`仍是待实现的完整证明面，不以选择fixture改名替代。T39的固定原生消费者/packed状态适配器跨进程研究保留在私有资格资料，不把owned JSON标作原生checkpoint；T40已增加独立`service-lifecycle`子集，启动/退出取消与资源释放通过也不代表完整持久服务已实现。另有`runtime-start`源码CLI/Unix+命令Scope和实际Node制品start→borrow→orderly restart入口；早先真实CLI复验被拦已由后续正常验证推进，准确证据归T40/readiness。此case仍不关闭持久服务owner/安装自启/现场凭据或整机恢复门。

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

**统一关闭记录**复用owning ticket和readiness，不开第二进度账：记录测试命令/退出码/实际运行case数/关键assert、source与制品身份及前后稳定性、原生Host/App适配版本、实际Bot与TURN/nonce/generation、所用凭据引用而非值、支持范围、未证项、独立review、下一责任。数据缺失、只见accepted、跳过case、界面不可读、工具拦截或版本漂移不能标passed；缺一项必需证据不以别项高通过数抵消。

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
