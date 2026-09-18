# OBS-04 — 诊断容量池、轮转与证据GC

**Status：Planned / Spec-only；M2，完整通知首发必需。** Contract：[Spec §8](../roadmap/template-ops-automation-spec.md#storage)。依OBS-00/02与T51配置合同；OBS-05独立处理执行/恢复安全状态，不能由本票代删。

## Goal / Modules

自动观测不无限积累；普通日志滚动、结构化journal按消费窗口分段、SQLite/事故/通知按生命周期回收，并测真实磁盘回落。

kernel `internal/observation/retention-policy.ts`；box-runtime `io/observation-retention.node.ts`、`bounded-process-log.node.ts`、原journal/monitor-store、`roots/storage-maintenance.runtime.ts`；CLI `runtime storage status/plan/apply`复用同owner。既有Jobs/provenance保留逻辑由原owner接预算，不写通用rm。

## Work

诊断池目标256MiB/max512MiB，64MiB内部reserve；shared SQLite/索引/辅助文件、所有进程/Bot日志、事故blob、自动exports与维护临时量全计入，不能每Bot重新给512MiB。容量预留发生在新写/换段/压缩之前；当前超额进入只读诊断/降级与有界回收，不暴力删保护记录。数字按Spec单一policy定义，不复制到Skill。

普通process log单段4MiB/总32MiB/72h；结构化journal8MiB/总128MiB/72h。实现受管有界stdio sink处理子进程长期fd，不能rename后仍写旧inode。关闭段才压缩，失败/中断不丢有效段；默认Host忽略raw stdio策略不扩大。journal manifest/cursor按segment identity跨重启接续；关键事故先固定，未消费超额允许loss但显式gap。

DB分批回收observations/events/evidence/incidents/management/cursors/source health/notifications/leases，逐表说明authority、可重建性和终止条件。ack/snooze/父子关系/open不永久pin全量payload；事件明细→核心→摘要，保留所需管理/去重最小标记。drop总结注明范围/原因，GET不清理。

显式证据租约默认30min/累计≤24h，校验任务/对象/revision，预留成功才承诺期限；读不会续期，取消/终态释放，孤儿按owner/lease过期回收。raw-sensitive短TTL与dataPolicy分开。旧通知过期/恢复摘要不能因GC丢去重而反复唤醒。

自动维护在服务Scope运行，与ops.notifications关闭独立。单tick扫描≤1000对象或50ms计划预算，实际IO需结算且记录超时；记录lastSuccess/backlog/reclaimed/pressure，不发每tick Bot通知。根/符号链接/inode/租约/并发读取/墙钟跳变均检查。

SQLite新建与迁移库真实auto_vacuum/回收模式分别验证；logical/live/free/file/auxiliary bytes可查。物理回收与DELETE行数分开，full VACUUM不是满盘兜底。数据库/日志异常不影响已允许推理，固定容量health槽/丢弃计数也有界。

## Executable acceptance

待新增：

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
