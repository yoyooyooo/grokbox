# OBS-04 — 诊断容量池、轮转与证据GC

**Status：Partial implementation / SQLite + process + journal rotation proof；M2，完整通知首发仍未关闭。** Contract：[Spec §8](../roadmap/template-ops-automation-spec.md#storage)。依OBS-00/02与T51配置合同；OBS-05独立处理执行/恢复安全状态，不能由本票代删。

## 当前切片与未完成范围

已实现每个SQLite writer连接的文件增长护栏（默认128MiB，不是全安装预算）、预留元数据余量、压力批次游标/gap提交、物理页/空闲页/辅助文件计量、最多3份可读修订及受保护修订拒绝、每revision一个有总量/累计期限限制的租约、通知与修订历史的增量回收。`runtime storage status`分开报告monitor、processLogs、journals；各自来源缺失不会遮盖其他分区，仍明确installationBudgetEnforced=false。

`observation-storage-pressure.test.ts`使用512KiB真实数据库验证持续高基数错误不越过文件上限、压力丢弃可见、重复批次不加倍、跨32个保留周期后无重启恢复新证据接纳；实际SQLite拒绝物理增长另有独立反例。`incident-evidence-store.test.ts`验证旧通知引用和leases不被修订数回收破坏。来源/结果见[增量回执](../reports/2026-09-18-observation-storage-followup.md)。

仍缺整安装统一配置/容量预留、其他producer与全部metadata/Jobs/备份/Trash治理、独立于ops开关的常驻服务组合、journal死writer锁/撕裂索引恢复、实际原生/live稳态和独立review。文件护栏只限制SQLite主文件，辅助文件目前仅测量，不能把128MiB当整安装上限或把32轮TTL前进当多年负载证明。执行状态仍由OBS-05处理。

## modeld 日志增量（2026-09-18）

modeld服务自身的结构化生命周期writer、真实fd关闭/新段、固定数量/字节容量、borrower隔离和诊断失败非致命已实现；replacement不再追加raw stdout/stderr，旧raw文件仅计量。真实Node替换/独立fd检查、25代轮转及只读存储facet的范围与缺口见[本片回执](../reports/2026-09-18-modeld-process-log-rotation.md)。年龄清理在写入或重开时执行，闲置无增长不宣称定时TTL删除已经交付。其他producer、跨owner容量、配置与常驻维护仍未关闭本票。

## 结构化 journal 增量（2026-09-18）

已接通原Host/modeld/control writer的共享锁字节轮转、8MiB段/128MiB每root数据预算、持久段ID/改名意图、关闭段退役与缺口、v1→v2消费游标、跨段离线incident读取。普通轮转过渡是deferred，不自动建故障；半行封存且不跨段拼接，GET不恢复/清理。旧watchdog不再改写受管活动inode。证据固定revision与源日志GC解耦。

`verify-runtime-rebuild.mjs journal-rotation`实际完成79项/0失败，类型/构建/边界/隐私及source稳定通过；全仓2317 pass/15 skip/0 fail。详见[分段回执](../reports/2026-09-18-structured-journal-rotation.md)。测试证明有序中断点恢复，不宣称任意掉电、半写索引/死锁自动恢复；本片新增Host叶，原生采用需重新资格。数据上限不包含已单独计量的有界索引，不等于整安装共享容量。

## Goal / Modules

自动观测不无限积累；普通日志滚动、结构化journal按消费窗口分段、SQLite/事故/通知按生命周期回收，并测真实磁盘回落。

kernel `internal/observation/retention-policy.ts`；box-runtime `io/observation-retention.node.ts`、`bounded-process-log.node.ts`、原journal/monitor-store、`roots/storage-maintenance.runtime.ts`；CLI `runtime storage status/plan/apply`复用同owner。既有Jobs/provenance保留逻辑由原owner接预算，不写通用rm。

## Work

诊断池目标256MiB/max512MiB，64MiB内部reserve；shared SQLite/索引/辅助文件、所有进程/Bot日志、事故blob、自动exports与维护临时量全计入，不能每Bot重新给512MiB。容量预留发生在新写/换段/压缩之前；当前超额进入只读诊断/降级与有界回收，不暴力删保护记录。数字按Spec单一policy定义，不复制到Skill。

普通process log单段4MiB/总32MiB/72h；结构化journal8MiB/总128MiB/72h。modeld使用取得listener后的受管结构化writer，不再捕获无限raw stdio；其他producer须由其真正长期owner处理fd，不能rename后仍写旧inode。关闭段才压缩，失败/中断不丢有效段；默认Host忽略raw stdio策略不扩大。journal manifest/cursor按segment identity跨重启接续；关键事故先固定，未消费超额允许loss但显式gap。

DB分批回收observations/events/evidence/incidents/management/cursors/source health/notifications/leases，逐表说明authority、可重建性和终止条件。ack/snooze/父子关系/open不永久pin全量payload；事件明细→核心→摘要，保留所需管理/去重最小标记。drop总结注明范围/原因，GET不清理。

显式证据租约默认30min/累计≤24h，校验任务/对象/revision，预留成功才承诺期限；读不会续期，取消/终态释放，孤儿按owner/lease过期回收。raw-sensitive短TTL与dataPolicy分开。旧通知过期/恢复摘要不能因GC丢去重而反复唤醒。

自动维护在服务Scope运行，与ops.notifications关闭独立。单tick扫描≤1000对象或50ms计划预算，实际IO需结算且记录超时；记录lastSuccess/backlog/reclaimed/pressure，不发每tick Bot通知。根/符号链接/inode/租约/并发读取/墙钟跳变均检查。

SQLite新建与迁移库真实auto_vacuum/回收模式分别验证；logical/live/free/file/auxiliary bytes可查。物理回收与DELETE行数分开，full VACUUM不是满盘兜底。数据库/日志异常不影响已允许推理，固定容量health槽/丢弃计数也有界。

## Executable acceptance

当前可运行的本地切片验证：`bun scripts/verify-runtime-rebuild.mjs observation-evidence`，其notProven明确保留全安装/轮转/执行退役/native/安装/review/live。

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
