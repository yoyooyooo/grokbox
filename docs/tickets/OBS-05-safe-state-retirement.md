# OBS-05 — 执行安全状态与恢复引用的安全退役

**Status：Planned / Spec-only；M2。** Contract：[Spec §8.5](../roadmap/template-ops-automation-spec.md#storage)；执行语义仍归[主Spec S10/S12/S13](../roadmap/box-runtime-impl-spec.md#modeld-effect-core)。依OBS-00与既有execution/context/controller owners，可与OBS-04并行；通知和Bot能力不是前置。

## Goal / Modules

长时间运行不靠重启删账本，也不因GC让旧STEP/未知提交重新执行。kernel原`internal/inference/execution-history.ts`、step/turn/context程序；box-runtime `io/execution-history.node.ts`及controller/provenance/contracts/config-migration owners。CONT恢复manifest/blob由CONT-02/04自己的store实现，本票只提供共同计量/保护接口和退役证明要求。

## Work

先做持久对象清单：STEP/TURN/context selection、maintenance c!/c-latest!、controller operations、grant、迁移回执与备份、provenance/profile引用、CONT snapshots。逐类记录唯一writer、重放入口、目前保留、可缩减字段、最后引用和退役条件；不能把热内存sweep当冷库GC。

定义retirement certificate并由实际准入/恢复入口消费：已关闭TURN可压缩STEP明细；所有旧身份必须被关闭标记/更高层epoch或session代拒绝，覆盖重启、延迟包和备份恢复。若当前协议无法有界安全遗忘，先改变代际/请求有效期合同并完成迁移/成套资格，不先TTL删历史。

context commit_unknown/未结算副作用保留最小禁止重放标记或真实对账记录；超时不是未执行，重启/换operationId也不能绕过。详情可回收，阻断语义不可随意丢；只保留必要字段而非无限积累原证据。

制品/自动备份按running/current/fallback/未完migration/manifest roots标记可达；未引用且超过数量/字节预算才由原owner回收。Trash只处理grokbox拥有对象并计bytes，用户手工export不在范围。恢复快照保留当前/上一完整版本与有界增量，不能删除manifest可达blob；没有容量时停止新增保护并报告，而非损坏原Botcheckpoint。

物理LevelDB compaction只整理已被安全删除的记录，不作为业务GC。安全池与诊断池分开计量，支持storage status报告reclaimable/protected/blockedBy。真实存储不可用仍拒绝无法安全记录的新副作用，不新增累计STEP寿命门或隐式定期重启。

## Executable acceptance

待新增：

```bash
bun test packages/box-runtime/test/execution-retirement.test.ts packages/box-runtime/test/recovery-reference-gc.test.ts packages/runtime-kernel/test/retired-identity-admission.test.ts
bun test packages/box-runtime/test/execution-history-storage-review.test.ts packages/box-runtime/test/execution-history-node.test.ts
bun run typecheck
```

实际kernel＋真实LevelDB＋新进程：大量不同STEP/turn结算后压缩，旧STEP/旧turn/旧operation在GC后、重启后、备份恢复后均零新增模型/工具副作用；新合法请求继续成功。维护commit_unknown在压缩后仍阻断，读成功不掩盖写失败。

对原controller不确定动作、配置未完迁移、当前/回退制品和CONT被引用blob插入保护fixture，GC不能删除；引用解除和证据满足后真实磁盘可回收。并发claim/GC需原owner锁/事务，不基于最后访问mtime。

## Forbidden / Non-goals

禁止TTL直删安全记录、删DB/LOCK/SST、热cache淘汰冒充持久退役、定期重启、重放历史任务取证、改原生用户数据。公共fixture只测管理合同，不声称能恢复真正进程/网络状态。需要改wire/schema时由对应owner成套升级，不能偷偷宽松旧reader。

## Exit evidence / LIVE

逐对象retirement表、准入路径覆盖、故障注入和新进程证据；没有安全退役条件的对象明确blocked并保留最小记录，不宣称已全库有界。[LIVE-OBS-SAFE-RETIREMENT](LIVE-integration-validation.md#live-obs-safe-retirement)维护原生/长期现场，CONT在原LIVE行核验恢复不被破坏。
