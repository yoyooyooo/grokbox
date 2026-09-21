# OBS-04 — 诊断容量池、轮转与证据GC

**Status：Partial implementation / SQLite + process + journal rotation proof；M2，完整通知首发仍未关闭。** Contract：[Spec §8](../roadmap/template-ops-automation-spec.md#storage)。依OBS-00/02与T51配置合同；OBS-05独立处理执行/恢复安全状态，不能由本票代删。

## 当前切片与未完成范围

**现行账本合同收束（2026-09-21）：** OBS 普通读取、初始化、维护和通知共享[当前 schema](../../packages/box-runtime/src/internal/io/monitor-schema.node.ts)，同时核对 meta 与物理 header；显式发送现以 schema 5 在原库关联 request/work/attempt，见[通知管理](../reports/2026-09-21-notification-send-management.md)。旧版本迁移、备份和 PID-only 升级锁恢复已退出。旧资料/锁保留，不投影为空记录或升级成功。既有 owner 目录丢失库时拒绝重建，防止通知 attempt 与管理历史被重置；只有新目录创建者可发布首次库，失败清理仅限自己的暂存文件及空目录。API/Web 不再提供 migrationRequired 占位。具体反例、当前初始化的只读行为及证据范围见[当前安全账本收束](../reports/2026-09-21-current-safety-store-contracts.md)，下述历史窗口不构成保留旧实时合同的要求。

已实现每个SQLite writer连接的文件增长护栏（默认128MiB，不是全安装预算）、预留元数据余量、压力批次游标/gap提交、物理页/空闲页/辅助文件计量、最多3份可读修订及受保护修订拒绝、每revision一个有总量/累计期限限制的租约、通知与修订历史的增量回收。`runtime storage status`分开报告monitor、processLogs、journals；各自来源缺失不会遮盖其他分区，仍明确installationBudgetEnforced=false。

`observation-storage-pressure.test.ts`使用512KiB真实数据库验证持续高基数错误不越过文件上限、压力丢弃可见、重复批次不加倍、跨32个保留周期后无重启恢复新证据接纳；实际SQLite拒绝物理增长另有独立反例。`incident-evidence-store.test.ts`验证旧通知引用和leases不被修订数回收破坏。来源/结果见[增量回执](../reports/2026-09-18-observation-storage-followup.md)。

T51配置和原writer接线已有实现。2026-09-19新增安装范围内monitor/journal/process的共享写前接纳、rollback/备份空间预留、24轮真实存储soak及过期payload/未知attempt解耦；代码与限定测试见[联合接纳回执](../reports/2026-09-19-diagnostic-admission.md)。这推进了诊断池，不覆盖所有producer/Jobs/执行/恢复/制品，也不证明旧现役writer采用。服务自启、完整安全退役、未知旧锁/撕裂状态恢复、全部owner配额和独立review仍有差额；不能将本票改成全安装已强制有界。

## modeld 日志增量（2026-09-18）

modeld服务自身的结构化生命周期writer、真实fd关闭/新段、固定数量/字节容量、borrower隔离和诊断失败非致命已实现；replacement不再追加raw stdout/stderr，旧raw文件仅计量。真实Node替换/独立fd检查、25代轮转及只读存储facet的范围与缺口见[本片回执](../reports/2026-09-18-modeld-process-log-rotation.md)。年龄清理在写入或重开时执行，闲置无增长不宣称定时TTL删除已经交付。其他producer、跨owner容量、配置与常驻维护仍未关闭本票。

## 结构化 journal 增量（2026-09-18）

已接通原Host/modeld/control writer的共享锁字节轮转、8MiB段/128MiB每root数据预算、持久段ID/改名意图、关闭段退役与缺口、v1→v2消费游标、跨段离线incident读取。普通轮转过渡是deferred，不自动建故障；半行封存且不跨段拼接，GET不恢复/清理。旧watchdog不再改写受管活动inode。证据固定revision与源日志GC解耦。

`verify-runtime-rebuild.mjs journal-rotation`实际完成79项/0失败，类型/构建/边界/隐私及source稳定通过；全仓2317 pass/15 skip/0 fail。详见[分段回执](../reports/2026-09-18-structured-journal-rotation.md)。测试证明有序中断点恢复，不宣称任意掉电、半写索引/死锁自动恢复；本片新增Host叶，原生采用需重新资格。数据上限不包含已单独计量的有界索引，不等于整安装共享容量。

## 共享配置候选（2026-09-18）

[T51](T51-ops-capability-presets.md)已在09e6405基线上实现schema4、严格2/3迁移与support退役。monitor初始化/collector/显式capture和modeld过程日志消费canonical存储意图；storage有独立revision，关闭通知不删除保留策略。当前只支持既有writer硬上限内的缩减。真实collector按1日明细/3日摘要、modeld连续12代按8KiB测试预算运行已证明，GET不伪造统一applied。

整安装物理预留、全体owner热加载/自启仍未完成；journal写入端采用与collector内维护在下述增量完成，分配416MiB、内部reserve64MiB及未分配32MiB的算术校验不构成磁盘强制上限。实际执行证据和schema4切换边界见[回执](../reports/2026-09-18-storage-config-v4.md)，现役采用仅归LIVE。

## journal采用、维护与锁恢复增量（2026-09-18）

Host原生观察器/session hook、modeld终态/恢复/准入和control append均显式传递canonical配置根；成功写入后记录storage revision，不由配置GET/GC伪造采用。已绑定配置被删除时拒绝新写，不能回到更大默认；旧活动文件超出新额度时先封存并回收关闭段，允许的短暂新段头开销有界，历史缺口不被隐藏。

collector现有维护子Scope每轮调用两个显式root的分段维护；不持SQLite writer等待文件锁，锁忙单次跳过，通知off不改变维护。已验证once的相同维护路径；安装、自启、真实长期周期仍归LIVE。状态分开显示请求策略、最后成功写入、当前liveness未检查与锁metadata逻辑/allocated字节。

目录锁v2以不可复用的owner token、PID/UID/start确认进程丢失/换代，真实SIGKILL的四个轮转边界与并发恢复已验证；不按超时删除锁，不重放append/业务callback。64个准备槽有界，未知/空/撕裂slot保留；旧PID-only文件锁仍无自动退役资格，LevelDB LOCK/SST与执行账本完全独立。

可重复入口`bun scripts/verify-runtime-rebuild.mjs journal-maintenance`：90 pass/0 fail，类型/构建/边界/隐私和source稳定通过；全仓2368 pass/15 skip/0 fail。详见[回执](../reports/2026-09-18-journal-policy-and-lock-recovery.md)。本票仍Partial，不能将上述slice签成全安装预算或原生通知首发。

## modeld 必要维护与诊断计量（2026-09-18）

`storage-lifetime.runtime.ts`已接在实际modeld listener的嵌套Scope：首轮有限工作，完成后等30秒，不依赖collector/UI/通知开关；borrower不启动。复用原数据库/journal/过程writer，缺库不初始化，坏配置不启动默认GC，忙锁不循环等待，退出结算后才关闭日志/listener。过程writer增加闲置关闭段回收，活动fd保持。没有另建daemon、collector或执行权威。

新增两个固定16KiB回执槽和只读维护状态；真实进程身份失效后为interrupted，旧回执/活PID不当全域applied。footprint只扫描三个明确诊断命名空间，2048项/深度4上限，元数据计量备份/暂存/辅助文件并inode去重；缺口和未覆盖owner可见，不输出路径/正文、不删除计量对象。物理计量不是跨writer预留，全安装配额仍未签。

`verify-runtime-rebuild.mjs storage-lifetime`63 pass/0 fail；全仓2381 pass/15 skip/0 fail。源码modeld/实际打包Node、SQLite、闲置fd、延迟结算、强杀、坏配置、符号链接和小文件洪峰的准确范围见[回执](../reports/2026-09-18-modeld-storage-lifetime.md)。Box重启自启、全安装预留、执行/CONT安全退役、原生投递与独立review仍是各自前置。

## OBS/CONT J1公共owner接线

只增加`ContinuityStorageOwners={recovery?,safety?}`固定消费点，不注册插件、不增加配置根或周期任务。`observeRuntimeStorage`显示`continuityStorage`独立计量；没有真实owner时measurement/bytes为null且unmeasured，共享allocation ID去重，不加入已计量diagnostic footprint来重复算盘。`maintainObservationStorage`只在原周期中调用被显式接入owner的64项有限维护；完整发布、引用保护/解除与GC并发边界归CONT本域，不传诊断TTL或任意路径。

接口与J0裁决见[Spec J1](../roadmap/template-ops-automation-spec.md#obs-continuity-interface)。组合`obs-continuity`使用owned adapter/真实临时文件与SQLite；未连接原生恢复材料、安全台账或新业务controller，仍不签全安装配额、native恢复或LIVE资格。

## Host 健康回执（2026-09-20）

HOST-01复用原provenance目录保存单个有界私有receipt文档：最多64条、1MiB，已索引旧项可退役，尚未索引项不可为腾容量而丢弃；达到上限明确暴露存储/采集缺口。文件发布与OBS提交不是跨存储原子事务，重启按原sequence/eventId补入，OBS仍拥有incident/outbox。此有限上限不代表全安装物理预算或任意备份回滚已经合格。Rust进程内存/CPU/管道与缓存另有有限预算，不与原生当前状态和业务安全记录混为诊断垃圾。

## Goal / Modules

自动观测不无限积累；普通日志滚动、结构化journal按消费窗口分段、SQLite/事故/通知按生命周期回收，并测真实磁盘回落。

kernel `internal/observation/retention-policy.ts`；box-runtime `io/observation-retention.node.ts`、`bounded-process-log.node.ts`、原journal/monitor-store、`roots/storage-maintenance.runtime.ts`只读计量、`roots/storage-lifetime.runtime.ts`所属modeld周期维护；CLI `runtime storage status/plan/apply`复用同owner。既有Jobs/provenance保留逻辑由原owner接预算，不写通用rm。

## Work

诊断池目标256MiB/max512MiB，64MiB内部reserve；shared SQLite/索引/辅助文件、所有进程/Bot日志、事故blob、自动exports与维护临时量全计入，不能每Bot重新给512MiB。容量预留发生在新写/换段/压缩之前；当前超额进入只读诊断/降级与有界回收，不暴力删保护记录。数字按Spec单一policy定义，不复制到Skill。

普通process log单段4MiB/总32MiB/72h；结构化journal8MiB/总128MiB/72h。modeld使用取得listener后的受管结构化writer，不再捕获无限raw stdio；其他producer须由其真正长期owner处理fd，不能rename后仍写旧inode。关闭段才压缩，失败/中断不丢有效段；默认Host忽略raw stdio策略不扩大。journal manifest/cursor按segment identity跨重启接续；关键事故先固定，未消费超额允许loss但显式gap。

DB分批回收observations/events/evidence/incidents/management/cursors/source health/notifications/leases，逐表说明authority、可重建性和终止条件。ack/snooze/父子关系/open不永久pin全量payload；事件明细→核心→摘要，保留所需管理/去重最小标记。drop总结注明范围/原因，GET不清理。

显式证据租约默认30min/累计≤24h，校验任务/对象/revision，预留成功才承诺期限；读不会续期，取消/终态释放，孤儿按owner/lease过期回收。raw-sensitive短TTL与dataPolicy分开。旧通知过期/恢复摘要不能因GC丢去重而反复唤醒。

自动维护在服务Scope运行，与ops.notifications关闭独立。单tick扫描≤1000对象或50ms计划预算，实际IO需结算且记录超时；记录lastSuccess/backlog/reclaimed/pressure，不发每tick Bot通知。根/符号链接/inode/租约/并发读取/墙钟跳变均检查。

SQLite现行新建及重开的真实auto_vacuum/回收模式分别验证；旧库不实时升级或重建。logical/live/free/file/auxiliary bytes可查。物理回收与DELETE行数分开，full VACUUM不是满盘兜底。数据库/日志异常不影响已允许推理，固定容量health槽/丢弃计数也有界。

## Executable acceptance

当前组合入口：`bun scripts/verify-runtime-rebuild.mjs pre-e2e-observation`；精确执行结果和源码身份归[固定回执](../reports/2026-09-19-diagnostic-admission.md)。已完成的局部轮转/维护不再作为缺实现重复施工；全安装所有owner、最终安全退役、自启、native/review/live仍分别保留差额。

完整范围仍待新增：

```bash
bun test packages/box-runtime/test/observation-retention.test.ts packages/box-runtime/test/process-log-rotation.test.ts packages/box-runtime/test/evidence-lease-gc.test.ts test/runtime-storage-cli.test.ts
bun test test/incident-observability.test.ts packages/box-runtime/test/alert-observability-store.test.ts packages/box-runtime/test/journal-observation-boundaries.test.ts
```

临时真实SQLite/文件/子进程，缩小预算后注入正常/重复/高基数错误，至少20轮填充回收；实际allocated/file bytes及索引/临时文件进入平台期，不只看row count。锁住reader/持有旧fd/GC中断/重启/迁移模式不符/时钟前后跳/满盘/只读/符号链接不能破坏有效manifest或阻塞执行。

在同incident上ack/snooze、长期开启、重复读和Bot崩溃pin，明细仍按合同有界；源日志滚动后通知引用可读到保留核心或明确expired，不能空成功。证明ops off后必要GC继续，陌生文件/用户export/CONT恢复blob未修改。

## Forbidden / Non-goals

不轮换整个活动SQLite/LevelDB文件、不删LOCK/SST、不全盘扫描、不copytruncate冒充无损、不把Trash当已释放空间、不依赖Bot记得运行清理，不自动删除原生对话/项目。执行安全状态只由OBS-05/原owner退役。

## Exit / LIVE

给出容量类别清单、物理计量误差边界、稳态曲线/测试摘要、保护对象及未实现retirement。首发不能以GC函数存在替代常驻调度；[LIVE-OBS-STORAGE](LIVE-integration-validation.md#live-obs-storage)持有真实安装/平台文件系统的长期验收，OBS-06聚合离线证明。
