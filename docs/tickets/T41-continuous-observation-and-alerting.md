# T41 — 单盒持续观测、SQLite与告警

## Status / responsibility

**Open · 2026-09-16候选扩展了原生提醒决策/Tray 生命周期、显式来源关联、共享 trace/诊断、磁盘增量 SQLite、cursor 原子采集、自动维护与进程身份约束的崩溃恢复；未因此安装现役 collector，未关闭完整 V28–V30。** 合同唯一入口为[Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation)，关闭V28–V30。本票拥有collector的长期生命周期、观测存储、incident和通知，不接管T37准入、T24配置、T27/J13执行事实或T28部署控制。浏览器与更远期能力归[future](../roadmap/future/README.md)。

用户结果：没有打开网页时，也能发现归属冲突/变化或失去观察能力；重启后仍可查已有事件、告警处理记录；多个CLI/页面不成倍访问Server。告警不替代准入，不暗中修身份或重放任务。

## 2026-09-16 Template Bot 出口扩展（未实现）

[T43–T56](README.md#template-ops-automation)在 [Template Ops Spec](../roadmap/template-ops-automation-spec.md) 下扩展本票的 bot-webhook 出口：默认一个命名目标，也允许用户指定官方/custom Bot 和有限路由，由独立回合按 intent 做简短报告或已授权诊断。目标/规则归 T54，故障/额度/交接归 T55；仍消费同库 outbox，不按 Bot 新建数据库。它有原生推理成本，不能沿用“所有通知绝不触发模型”的无条件表述；collector 仍不直接调用 provider/sendPrompt，重试仍仅投递同一通知，不借此重做诊断工具或维护。

本票仍唯一拥有观察/incident/交付管理与原 SQLite。后续 binding/grant 归 ConfigurationWrite，plan/实际变更归唯一 controller；通知 outbox 或 Bot 结论不授予任何执行权限。一般第三方外发保持默认禁止；新出口只对显式绑定目标开放。现有 `local_only` 与未完成 native/持久安装资格在实现前不改写。

**2026-09-17 补充（未实现）：** T51 为正常服务启用的新安装提供 user 默认轻量观察与配对后的 brief-notice，maintainer 更多观察单独开启；默认不发动模型深诊断。T52 在现有 SQL 的 support 域管理草稿/受信 consent/submission，普通 collector 不能签同意，issue 不是自动通知副作用。T53 通用 Routine CLI 不依赖此数据库；模板/测试复用它。旧 off/预算保留，预设不授予维护/公开发布权；细节只在专项 Spec §5.1/6.1/6.2/10.1 维护。

T52/T56 的支持草稿/consent/submission 仍为原库独立管理域，有限 issue grant 本体归 ConfigurationWrite，GitHub 写入由独立 support/publisher 程序；collector 不发 token、不签许可。单目标预算不因多 Bot/备用/升级而变大，unknown 不广播。

## 当前实现与证据范围

当前使用方式、错误与存储合同的维护入口是[持续观测](../maintainers/continuous-observation.md)，不从下面的完整目标推断所有能力已落地。

- Kernel `monitor.ts` 复用既有四类归属规则，提供单一有界policy、稳定scope/来源时间过滤、freshness；不会把schema1/旧/未知scope重新包装成准入证据。
- `monitor-store.node.ts` 在原 observability 路径采用 schema v2、固定 sqlite3 磁盘增量事务和 rollback journal；不再读写整库 JS 镜像。原始安全事件、cursor、incident 及本地通知决策同事务提交。v1 显式迁移保留备份与管理意图；GET 不迁移/恢复。
- `monitor.runtime.ts` 属于自己的Effect Scope，批量最多32目标、串行poll、错误退避与正常退出；新的scope不借旧scope确认状态。提交后输出有稳定ID的changes，不调用sendPrompt/provider/reconcile/控制信号。多个只读客户端不追加上游查询。
- CLI 保留 `runtime monitor init/run/snapshot/events/incidents/ack/snooze`，增加 `alerts trace --from journal|monitor`；init/run 要求显式 confirm，查询不初始化或采集。SQLite native addon 是发行依赖并按需加载，Host/CLI 普通路径不加载数据库引擎。安装制品须重新资格化，不能沿用旧空 dependencies 声明。
- 原协议隔离、source CLI/mock Gateway/真实SQLite与打包Node冷读/ack已验证；原生Server live scoped桥、全量调度/恢复/通知还不能据此签署。Node20与Node22以及安装后tarball的实际检查见readiness。

**剩余资格：** admission 与背景刷新更广义的共享调度；未知旧锁/任意备份恢复；外部通知渠道与客户端接收/渲染回执；T40 服务安装、自启与现役长驻验收。已实现的本地 journal 追赶不会提高 ownership RPC 频率，v2 正常/硬崩溃恢复与 v1 事务迁移有独立测试。取消 16MiB/50000 条累计拒绝门槛，期限/软目标驱动自动维护并披露缺口，保留管理语义。local-only 出口成功不等于远端或 App 到达。

## 实施边界与复用

复用T37原生List读取/纯归属规则、T27/T33安全DTO及现有事件、配置回执。kernel保持纯合同与Effect观察/incident程序；box-runtime增加owner-private Node IO和长期root装配，CLI仅命令投影。不新建npm包、执行ledger、通用事件总线、身份数据库、App补丁或第二supervisor。

未来Web UI不是collector owner；页面只读快照/订阅和调用共用命令。独立`getHostStatus`/`agents ownership`的一次性查询仍保持它们已定义的无持久写语义。不能在GET或普通读取时偷偷启动collector、迁移DB、投递告警或开启远程连接。

## 1. 采集与共享证据

Box机器身份与Bot harness分层。key覆盖可信Box身份、隔离的账号/team/backend scope、公开Bot UUID/Server行ID；Host/Gateway/service epoch为另一维。IP、PID、显示名不作永久身份。scope改变不延续旧缓存/incident的已确认语义，秘密原值不输出。

事件触发与周期Server查证组合：同scope批处理/single-flight/总时限/并发上限；准入请求优先于背景刷新但不能无限饿死背景。一个页面关掉只退订；取消一个等待者不取消仍有等待者需要的共享查询。旧callback在scope/epoch失效后不能安装结果。

保留lastKnown/lastSuccess与当前availability/freshness。首次观测作为baseline；box→temporal用前后成功观察给出发现区间；超时/401/缺行/分页不全分别记录，不制造迁移或删除。来源无revision时明确缺失，自身collector序号不冒充官方版本。采集崩溃期间可能漏中间变化，重启报告gap并重新确认，不能补造“整段无变化”。

监控interval、最大staleness、刷新等待、退避/jitter、容量和关机drain预算在实施前作为单一policy明确值与范围并测试；T37 admission最大年龄独立但复用事实，后台间隔不自动成为安全窗口。先有可信实时失效再异步写观测，DB/通知失效不阻挡T37的原生fence。

## 2. SQLite边界与数据生命期

目标`${durableRoot}/observability/observations.sqlite`，后台单写入角色、读端受控；不放Host store，不让浏览器或多盒通过网络文件系统共享DB。Node-portable驱动和目标Node支持矩阵在实现时资格化，不能为方便引入Host Bun依赖或悄悄升运行时。

| 逻辑内容（不锁表名） | 权威/恢复策略 |
|---|---|
| 当前观测和既有日志索引 | 派生，可从仍可读来源重建；重建前不称current |
| observed transitions、源引用与gap | 只证明本监控看过什么；上游无历史回放时不可重新生成；保留期/删除有明确界限 |
| incident生命周期、用户ack/snooze及revision | 本域事实，需持久/备份；不是全部可丢缓存 |
| 通知deliveryId、尝试/回执/unknown | 仅通知管理的发送记录，不是provider、工具或控制命令outbox |

采样/变更/incident更新在同一本地事务提交后才发布UI事件；不把上游查询放进写事务。按源revision/采样身份防重，崩溃重放不能重复开incident。数据库锁/磁盘满/损坏产生monitor degraded；保全原文件，不能自动drop/new空库报健康。查询不触发journal mode修改、schema migration/retention等隐式写。显式维护负责事务迁移、schema兼容、备份恢复和保留；测试包含中断迁移和旧备份恢复后的新collector epoch/cursor失效。

不保存prompt、Memory/私有App源码、credential、raw auth headers、任意通知URL；只保存允许字段和证据引用。密钥仍通过既有secret refs。配置事实仍由ConfigurationWrite管理；SQLite不能经后台“同步回去”改models/desired/harness。J13/provenance原writer及保留规则不迁移，DB索引缺来源时标gap。

## 3. Incident与通知

首批规则：已确认归属改变、Server/local冲突、证据过期/采集不可用、来源已支持的关键运行代/期望配置不一致。不逐token写库；运行时明确的终态才关联对应run，不凭时间猜任务失败。

同scope+对象+规则+发生周期去重；重复采样更新lastSeen。resolved需要新鲜正证据；读失败既不能解决旧冲突也不能冒充新harness。已存在冲突的test2首次可开baseline incident，不编造迁移过程。ack、snooze与open/resolved分别存，ack不修问题、不影响准入；新发生周期不继承无期限的旧ack。

T41提供本地CLI读/处理和一个有限、显式配置的通知出口（优先安全NDJSON/受控消费者交接，或另获批准的一个固定渠道；不需Web UI）。消息包含安全Box/Bot身份、规则/影响、实际已采取保护、发现时间和证据定位；没证据不声称任务已暂停。通知最多按预算重试，稳定deliveryId贯穿尝试；渠道无幂等则如实可能重复。发送成功但未收到确认保留unknown，不能把告警ACK解释为投递ACK。

通知是单独外部副作用，默认不对第三方外发；固定允许目标、凭据/重定向/网络边界及撤销需验证，不允许任意URL转发/远程exec。重试仅发送通知，永不调用sendPrompt、模型、reconcile、清circuit、迁移、adopt或工具。整体Box断网/关机由未来外部观察者发现，本机不承诺报告自身死亡。

## 4. CLI/API合同（已实现子集与目标）

现有`runtime monitor`已有显式init/run、snapshot、events、incidents和ack/snooze，具体参数以registry/[命令维护页](../maintainers/continuous-observation.md)为准。高级refresh/服务安装/订阅不由这些命令自动提供。`alerts list`仍是Host tray，不被新incident替换；UI可并列呈现但来源不同。模型/能力配置仍用原commands；通知策略走其唯一配置writer。

查询返回scope/collectorEpoch、snapshotCursor、freshness、lastKnown和gap；分页游标绑定scope/epoch/retention。慢读者有界队列，断线/游标过期明确gap；先快照后续流不能漏掉快照交界事件，重连允许按cursor补拉或重新快照，不用客户端时间戳恢复。

ack/snooze是有requestId与expected incident revision的管理写：重复同意图可对账，冲突保持草稿，不复活resolved周期。CLI与未来API调用同一程序。GET写DB次数0，显式refresh是有预算的观察操作/调度触发，不偷偷修复产品状态。

## 5. 依赖与并行

T37共享事实先建立；T41不阻塞T37 gate、T38 writer修复、T24选择或T39普通旅程。T41可复用T25/T40的服务安装基础并行实施，不等T40整票完成。T40的持续生产签署包含T41单盒最低监控、持久incident和范围披露；远端渠道未配时明示local-only，不以缺高级渠道阻塞普通推理。

T27负责执行事实、T33负责深层诊断与J13 cursor；T41只收集安全投影/索引。T29前端后消费，不改变监控生命期；多盒、外部离线监测、多渠道升级与长周期统计在future，不能拖进本票。

## 6. 验收与首个动作

现有`verify-runtime-rebuild.mjs observation-monitor`已实现本地子集，实际执行typecheck/build及kernel、SQLite事务、source CLI、打包Node冷进程用例；报告保留live scoped读取、共享调度、crash恢复、维护、通知和部署未证项。下表仍为整票完整验收，不把当前子集绿称作V28–V30全部完成：

| 反例/场景 | 必需oracle |
|---|---|
| 多读者/多窗口/背景与准入并发 | 上游查询有界合并；关一个订阅不杀其他请求或collector；不二次执行模型 |
| 过期/401/缺页/账号或Host换代 | lastKnown保留但不授权；无假迁移/删除/恢复；旧结果不污染新scope |
| 轮询间真实变更/无source revision | 只记录发现区间及缺口，不发明后台操作者/完整历史 |
| 事务任一点崩溃、重复来源事件 | 快照/transition/incident一致；恢复不重复incident，未提交不得已广播 |
| ack/snooze后重启/并发写/新周期 | 管理状态持久、幂等与revision冲突正确；不影响执行资格 |
| DB满/锁/损坏/迁移中断/备份恢复 | gap可观察，不删库冒成功，不恢复旧授权，不阻塞独立推理/Host writer |
| 通知发出后ack丢失/取消/渠道禁用 | 有界attempt/unknown，同一deliveryId；无模型、配置、Host信号或任务重发 |
| cursor旧/retention/慢消费者/分页 | 明确gap和重取快照；没有无界内存或假完整时间线 |
| GET/普通ownership/Host tray查询 | 不启动服务、不写DB或控制产品；secret sentinel不泄漏 |
| 无网页、CLI退出、整机离线 | 服务owner与资源回收正确；本机无法报告自身断网的边界明确 |

下一动作：固定本轮候选及 Node 制品，复验受支持原生 Alert 接缝与 collector 的完整命令链，再按 T40 明确服务安装/运行范围。不要重新建立永久 Alert 库、清未知锁/坏库、把 native emitter 返回当 App 已读，或借通知恢复业务任务。现役 scoped bridge、原生分支覆盖、客户端与外部渠道证据分别记录，不能由本地测试替代。
