# OBS-05 — 执行安全状态与恢复引用的安全退役

**Status：当前E2E所用owner的安全收缩与写前容量门已实现，原生/整机恢复资格仍Open。** Contract：[Spec §8.5](../roadmap/template-ops-automation-spec.md#storage)；执行语义仍归[主Spec S10/S12/S13](../roadmap/box-runtime-impl-spec.md#modeld-effect-core)。依OBS-00与既有execution/context/controller owners，可与OBS-04并行；通知和Bot能力不是前置。

## Goal / Modules

长时间运行不靠重启删账本，也不因GC让旧STEP/未知提交重新执行。kernel原`internal/inference/execution-history.ts`、step/turn/context程序；box-runtime `io/execution-history.node.ts`及controller/provenance/contracts/config-migration owners。CONT恢复manifest/blob由CONT-02/04自己的store实现，本票只提供共同计量/保护接口和退役证明要求。

## OBS/CONT J0/J1 公共出口

边界核对A/B/C无冲突，精确合同归[原专项Spec J1](../roadmap/template-ops-automation-spec.md#obs-continuity-interface)。`ProtectedStorageRef/ContinuityStorageOwner/ContinuityStorageOwners`从kernel observation导出；runtime facade提供`runContinuityReferenceChange`、`measureContinuityStorage`，既有status/maintenance接受显式owner注入。未接真实恢复/安全owner保持unmeasured/null；不扫描原生Memory、不按诊断TTL解除保护、不重复维护调度。

保护、精确claim解除和GC共用**本域**持久事务/锁，公共层不存第二套pin。14项`obs-continuity-contract.test.ts`以真实临时文件、SQLite和owned恢复owner验证诊断过期/轮转、引用并发、容量下降保留最后可靠点、安全记录不足拒绝新effect、未知操作不随TTL终结、共享物理计量与Scope结算。该fixture不是CONT恢复发布器或执行ledger；生产owner和完整安全退役仍由本票/CONT-02/11完成，不签J2。

## T53 scoped provision 记录（2026-09-18）

新增`state/routine-provision/operations.sqlite`由T53单独持有创建/更新的重放保护，不纳入诊断GC。该owner已在storage status独立计量：主文件2MiB、最多256条完整操作，已被取代的结算历史可缩为精确tombstone，不存prompt；容量不足只拒绝新的provision，不影响模型执行。attempting/unknown不能被TTL清除，损坏/缺失既有账本不能初始化成新许可。真实文件、并发、SIGKILL和诊断维护隔离已验证，详见[T53回执](../reports/2026-09-18-disabled-routine-provisioning.md)。

operation的安全收缩现已实现，见下方owner边界；首次初始化中断、损坏存储等仍保守拒绝，不当作空数据库重新授予创建权。这种明确拒绝不是允许通用GC删库；J1恢复/安全owner合同不因此改变。

## 自动通知恢复防护（2026-09-19）

`notice-replay-fence.ts`由实际daemon sender持有，不是另一份持久outbox。新worker只自动处理授权之后、且本次worker启动之后发生并入库的故障；恢复旧库中的既有work仍可查询，但必须显式对账，不自动补投。活worker在真正HTTP发送前记住稳定occurrence身份，恢复掉数据库attempt、甚至重建新work ID也不能在该生命周期重复发。守卫最多4096项，只有故障自动通知窗口和原work期限都过去才回收；保留时间高水位，回拨不重开已经退休的时间段。

`notification-restore-fence.test.ts`使用真实SQLite备份/还原和loopback HTTP，覆盖已接受、unknown、worker重启、新故障继续、同故障换work ID、容量与时钟。该防护仅覆盖自动通知的副作用；不称为执行/维护/provision全域恢复fence，不保证任意整机快照恢复后的全局费用计数不会回退，也不授予显式重发权限。其他owner仍需各自的安全退役协议。

## 诊断payload与安全标记的退役分界（2026-09-19）

已验证：材料/通知/lease期限全部结束后，可回收原diagnostic snapshot而保留精确work/attempt与revision水位。reserved/attempting/unknown在清理后仍不能再次reserve/begin；旧证据返回expired，不因incident行退役被说成从未存在。实现及三个状态反例见[固定回执](../reports/2026-09-19-diagnostic-admission.md)。这不是安全标记的最终删除或对整个恢复盘回滚的保证，本票原准入/退役义务不由该局部成功消除。

## 已实现的owner收缩边界

- execution：原LevelDB writer串行提交STEP/TURN索引；只有closed/revoked TURN下非active STEP可按128项有限批次删除，原TURN拒绝标记保留并由真实kernel准入消费。旧epoch由既有服务代际拒绝，晚到结算不重建已退役STEP；新claim预留LevelDB重写/compaction空间，压力不清空安全数据。modeld同一维护Scope调用原owner并等待结算，不引入第二GC或累计STEP次数门；TURN队列与子项游标有限推进，未结前缀不会饿死后续已结明细。
- context：已被后续操作取代且settled的详细receipt可收缩为同键`detailsRetired`标记；旧请求返回`operation_retired`，不再调用摘要/原生checkpoint。unknown/committing、最新receipt与明确保护对象不删。该标记跨服务epoch保留，不能换成not-found。
- routine provision：原SQLite事务把不再被当前binding引用的observed操作收缩为精确operation/fingerprint tombstone；旧操作读出retired，改内容冲突，均不重新接触原生创建。unknown/attempting和当前binding不变；私有schema2使旧writer不能忽略新标记。300次更新/重入反例已实现，不再将256条完整历史记录当作永久运行寿命。
- notification和CONT：沿用已实现的固定work/attempt、时间/代际恢复边界和CONT本域引用闭包；不借此次维护删除恢复点、未结职责或任意原生状态。

所有安全标记依然受物理容量门约束，必要时拒绝新effect。没有“常量空间永久记住任意旧ID”或“无外部单调锚点识别任意整机快照回滚”的承诺；更强保证要先改变系统边界，不是本轮用TTL删除unknown。固定验证及剩余现场范围见[收口回执](../reports/2026-09-19-pre-e2e-closeout.md)。

## Work / 后续更强范围

先做持久对象清单：STEP/TURN/context selection、maintenance c!/c-latest!、controller operations、grant、迁移回执与备份、provenance/profile引用、CONT snapshots。逐类记录唯一writer、重放入口、目前保留、可缩减字段、最后引用和退役条件；不能把热内存sweep当冷库GC。

定义retirement certificate并由实际准入/恢复入口消费：已关闭TURN可压缩STEP明细；所有旧身份必须被关闭标记/更高层epoch或session代拒绝，覆盖重启、延迟包和备份恢复。若当前协议无法有界安全遗忘，先改变代际/请求有效期合同并完成迁移/成套资格，不先TTL删历史。

context commit_unknown/未结算副作用保留最小禁止重放标记或真实对账记录；超时不是未执行，重启/换operationId也不能绕过。详情可回收，阻断语义不可随意丢；只保留必要字段而非无限积累原证据。

制品/自动备份按running/current/fallback/未完migration/manifest roots标记可达；未引用且超过数量/字节预算才由原owner回收。Trash只处理grokbox拥有对象并计bytes，用户手工export不在范围。恢复快照保留当前/上一完整版本与有界增量，不能删除manifest可达blob；没有容量时停止新增保护并报告，而非损坏原Botcheckpoint。

物理LevelDB compaction只整理已被安全删除的记录，不作为业务GC。安全池与诊断池分开计量，支持storage status报告reclaimable/protected/blockedBy。真实存储不可用仍拒绝无法安全记录的新副作用，不新增累计STEP寿命门或隐式定期重启。

## Executable acceptance

已实现、纳入同一前置组合的实际入口：

```bash
bun scripts/verify-runtime-rebuild.mjs pre-e2e-observation
bun test packages/box-runtime/test/execution-retirement.test.ts packages/box-runtime/test/execution-history-storage-review.test.ts packages/box-runtime/test/execution-history-node.test.ts
bun test packages/box-runtime/test/context-maintenance-lifetime.test.ts packages/box-runtime/test/routine-provision.test.ts packages/box-runtime/test/notification-restore-fence.test.ts packages/box-runtime/test/obs-continuity-contract.test.ts
```

准入反例直接位于execution-retirement测试中，恢复引用保护位于既有J1测试，不为旧计划名再建空的同义文件。精确结果、制品与源码身份见[本轮回执](../reports/2026-09-19-pre-e2e-closeout.md)。

实际kernel＋真实LevelDB＋新进程：大量不同STEP/turn结算后压缩，旧STEP/旧turn/旧operation在GC后、重启后、备份恢复后均零新增模型/工具副作用；新合法请求继续成功。维护commit_unknown在压缩后仍阻断，读成功不掩盖写失败。

对原controller不确定动作、配置未完迁移、当前/回退制品和CONT被引用blob插入保护fixture，GC不能删除；引用解除和证据满足后真实磁盘可回收。并发claim/GC需原owner锁/事务，不基于最后访问mtime。

## Forbidden / Non-goals

禁止TTL直删安全记录、删DB/LOCK/SST、热cache淘汰冒充持久退役、定期重启、重放历史任务取证、改原生用户数据。公共fixture只测管理合同，不声称能恢复真正进程/网络状态。需要改wire/schema时由对应owner成套升级，不能偷偷宽松旧reader。

## Exit evidence / LIVE

逐对象retirement表、准入路径覆盖、故障注入和新进程证据；没有安全退役条件的对象明确blocked并保留最小记录，不宣称已全库有界。[LIVE-OBS-SAFE-RETIREMENT](LIVE-integration-validation.md#live-obs-safe-retirement)维护原生/长期现场，CONT在原LIVE行核验恢复不被破坏。
