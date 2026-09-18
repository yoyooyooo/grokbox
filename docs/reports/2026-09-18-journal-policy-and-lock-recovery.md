# journal 配置采用、受管维护与死 writer 恢复 · 2026-09-18

本报告固定 `8c5c94d`（schema4候选）之后的实施与离线证明，不维护另一份当前上线状态。合同归 [T51](../tickets/T51-ops-capability-presets.md)、[OBS-04](../tickets/OBS-04-bounded-observation-storage.md)、[专项 Spec](../roadmap/template-ops-automation-spec.md#storage)；现场只归 [LIVE-OBS-STORAGE](../tickets/LIVE-integration-validation.md#live-obs-storage) 及 [CONFIG-CUTOVER](../tickets/LIVE-integration-validation.md#live-config-cutover)。配置仍为4，models仍为2，wire仍为8。

## 配置真正到达 journal 写入端

preload的原生告警/任务/活动观察器、Host session hook、modeld终态/恢复/准入观察器和控制面append明确传递canonical配置根。新的 `host/journal-policy.node.ts`只读取当前storage依赖切片与迁移状态，不调用Gateway、模型、配置writer，不从HOME/事件/日志目录父路径猜来源。配置版本常量提取为纯leaf；Host仍不导入Effect/SQLite/CLI。

读取使用有限的descriptor窗口和严格文件身份/权限/UTF-8检查；旧版本、损坏、超大文件、符号链接或未完成迁移拒绝新的诊断写入。历史查询仍可用。缺配置只在从未绑定已存在配置时表示默认来源，不能把已绑定配置的删除解释为恢复更大默认额度。

已知canonical来源在首次写入时登记source binding（不是执行授权）；无绑定的小型旧日志仍可保持单文件形状。段索引中的 `writerPolicy`只在事件append及fsync完成后记录。保存配置、GET和GC都不制造成功写入见证。状态分开提供请求策略、最后成功写入的revision/时间/策略、是否匹配请求及currentWriterLiveness=not_checked；过去写过不代表当前所有writer或整安装已采用。

每次受管写入读取当前journal策略；monitor的SQLite策略和modeld过程日志仍按先前合同在启动时捕获。全体owner的热加载、聚合applied和512MiB物理预留并未由局部回执替代。

## 配置缩额与本地维护

修复了缩额后的实际死角：旧活动文件已经大于新分配时，不能因前置容量判断永远拒绝轮转。现在先按已登记协议封存，再在新事件被接纳前回收关闭段，使数据回到新额度。已有超额到恢复期间仅允许一个固定大小新段头作为有界过渡开销，不截断活动inode，不删除未登记文件；退役范围仍通过segment coverage可见。

`journal-maintenance.node.ts`只处理durable/control与显式run/host两个root，在原collector维护子Scope内接线；源RPC和SQLite写许可都不包住文件维护。维护对忙锁只尝试一次并跳过，不抢占活writer；结算当前文件步骤后响应取消。单次回执区分maintained/not_segmented/busy/unavailable及本次退役量/实际耗时。原30秒维护循环调用此路径，通知关闭不改变它；这里没有新daemon、模型循环或Bot唤醒。已验证once入口调用相同维护程序，长期服务安装、自启和真实30秒周期运行仍按LIVE验收。

维护不初始化陌生日志、不把legacy文件全部重写、也不把当前请求策略写成writer已采用。更换配置后，GET显示revision不匹配，直到一次真正的新写入更新回执。

## journal 锁协议 v2

旧PID-only文件锁在持有者硬崩后缺少安全的并发退役方式；直接按年龄/超时unlink可能删除竞争者刚获得的新锁。新协议在同一个events.lock名字上原子发布一个非空目录，其中只有本次获取独有的owner token文件，带PID、UID和启动身份（Linux boot/start摘要）。恢复只在旧进程缺失或身份已变化时退役确切token，再用非递归rmdir清理；新owner进入后目录非空，旧回收者不能删除新锁。并发恢复不重试业务callback，callback的EEXIST也不变成第二次执行。

准备目录为64个固定槽，owner文件≤512字节；检查owner目录最多读两个目录项，不全量遍历未知目录。进程在有效准备记录之后死亡可回收该槽；没有完整身份的空/撕裂槽保留并占用有限槽位，耗尽时拒绝新写，不猜测所有者或无限产生随机孤儿文件。旧PID-only文件、未知目录/符号链接和活进程锁均保留。非Linux平台没有相同的进程身份恢复资格，不按PID年龄降级。

`runtime storage status`附加有限的锁元数据计量、准备槽占用、是否为未资格旧锁、owner缺失/live/身份变化/不可用状态；不输出PID/start/token，不执行恢复。文件逻辑字节与元数据allocated bytes分开，这仍不是全安装物理配额承诺。

旧writer仍以O_EXCL尊重events.lock的占用；旧进程正常释放PID锁后新writer可获取。遗留死PID-only锁、任意断电、撕裂索引/owner文件及外部恶意同UID写者不在本次自动恢复保证内。执行安全LevelDB的LOCK/SST、模型任务、原生转录/Memory及业务副作用没有被此协议管理或删除。

## 实际验证

使用固定Bun1.3.14、原依赖锁及Node基线。新增可重复入口：

```bash
bun scripts/verify-runtime-rebuild.mjs journal-maintenance
```

整组 **90 pass / 0 fail**，10文件、747断言；类型检查、构建、Host import边界、含未跟踪文件的隐私扫描通过，验证前后source摘要一致：`d8579ff950048a5af78e4d339c356ff2e330f0abb018a1ece74aa462f5e1ce0c`（727个source/test/lock文件）。实际preload为 `584a3db193bd4b6d97442ca96f07ae9a1dd682dda5a93e8b181ab997b10ad9de`，拒旧制品pin已由真实构建更新并通过验证。本次改变了Host文件行为，不是仅改build摘要。

| 回归范围 | 实际结果 |
|---|---|
| 全CLI目录 | 676 pass / 0 fail，66文件、5404断言 |
| 全packages目录 | 1692 pass / 15 skip / 0 fail，244文件、16880断言 |
| 不重叠合计 | **2368 pass / 15 skip / 0 fail** |

新 `journal-policy-adoption.test.ts` 11项：canonical投影一致、实际小额度、GET不造采用、配置缩额、异源/无绑定拒绝、小日志配置删除拒绝、GC不造writer回执、忙锁不抢占、ops off下collector维护、control writer、实际打包Node Host hook以及符号链接保护按各测试合并分组。固定padding只在byte-writer容量夹具中使用，不作为生产projector接受任意字段的证据。

新 `journal-lock-recovery.test.ts` 13项，包括真实独立子进程SIGKILL、intent/renamed/created/committed四个落盘边界硬崩、24个并发恢复者临界区峰值为1、死等待者准备槽回收、活owner与旧/未知锁保留、callback不重放、槽数有界，以及实际打包Node Host在死锁遗留后首次新hook写入。测试只终止自身创建的临时目录子进程；没有向生产PID发signal。Linux身份相关测试在其他平台不冒充已验证。

## 只读现场探针

使用候选打包Node执行`runtime storage status --json`，未切全局shim、未迁移配置或启动服务。返回：monitor_not_initialized；control journal为legacy且可读，数据80221字节；这次调用未配置runRoot，因此processLogs为not_configured而不是“没有Host/modeld日志”；storageIntent为unavailable且installationBudgetEnforced=false。随后用现役CLI只读核对schemaVersion仍为3。这个窗口只证明新取证入口能在旧配置上保留独立事实并表达缺口，不证明collector已安装、Host新叶已采用或存储达成全局额度。

## 已知边界与后续

全安装预留/辅助文件和其他owner治理、OBS-05执行身份安全退役、统一storage applied及持久安装尚未完成。原生Routine/Webhook、配对和真实Bot投递仍未实现，默认只提醒/无自动Issue的合同不变。没有新增独立review回执；实现者反例检查与测试不替代独立审核。

本轮未修改现役config/models、全局shim、Host/profile/preload/modeld，未创建Bot/Routine、发业务模型请求、Webhook、Issue或模板。schema4及新Host叶必须从固定已集成候选成套采用；Git提交、fixture进程恢复和last-write回执都不构成live采用资格。当前未验项继续在唯一LIVE索引维护。
