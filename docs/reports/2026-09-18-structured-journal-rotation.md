# 结构化 journal 分段、游标接续与固定证据 · 2026-09-18

本报告记录 `98b62ea` 之后的结构化日志增量及固定离线证明；当前现场仅归 [LIVE-OBS-STORAGE](../tickets/LIVE-integration-validation.md#live-obs-storage) 和 [LIVE-OBS-EVIDENCE](../tickets/LIVE-integration-validation.md#live-obs-evidence)。合同归 [专项 Spec §8](../roadmap/template-ops-automation-spec.md#storage)，施工归 [OBS-04](../tickets/OBS-04-bounded-observation-storage.md)；它不宣称整套 Bot 通知已交付。

## 实现范围

新增 Host leaf `journal-segments.node.ts`，在原 `appendNdjsonLine` 和同一 `events.lock` 内进行字节轮转。Host、modeld、控制面仍由原 writer 输出原本允许的安全事件，没有迁移 writer、增加 RPC、收集正文或把观察数据库变成执行权威。所有重试仅恢复文件协议，不重放上一次失败的 append，更不会重做业务任务。

活动文件保持 `log/events.ndjson`。小型正常 journal 不强制迁移；达到默认8MiB段容量或发现末尾半行时，才登记分段索引。索引保存稳定段ID、递增序号、inode、已关闭段大小、轮转意图和回收水位。归档名从经过校验的ID派生，不从事件或任意路径取值。默认每个journal root的受管数据总量128MiB；索引和暂存索引另有32KiB单文件界限，物理计量单列，不宣称整个安装只有128MiB或已落实512MiB共享预算。

轮转先持久保存意图，再改名、创建带身份头的新活动文件、读回并提交索引。回收先登记退役及待删除集合，再校验原inode/大小并删除本协议拥有的已关闭段。下一次合法writer可继续已登记的未完成步骤；普通GET不恢复、删除、建目录或续租。对损坏索引、无法证明归属的暂存文件、身份不符或预存超额无法安全处理的情况，保留现场并拒绝新增诊断写入，不清空目录假恢复。

关闭段按容量/数量/段年龄治理；默认72h年龄在写入或既有维护调用时检查，legacy首次登记的年龄是登记时刻，不伪造历史创建时刻。没有新写时容量不增长，但本片不签长期服务调度或精确到点的TTL删除SLA。已有writer锁硬崩残留和任意撕裂索引的自动恢复仍需后续资格，不从有序故障注入宣称任意掉电安全。

## 读取与证据语义

`journal-cursor.node.ts`增加v2段游标，内部仍保存原v1的inode、字节位置、前缀及边界hash。旧v1游标可以按inode找到已改名的关闭段，继续原位置，不从最新文件头猜位置。已退役游标只向更大序号前进，明确返回retired_segment；不会因回收重播此前读过的段。

正常轮转的短暂过渡返回deferred=rotation_in_progress，保留消费游标且不创建source_gap故障。collector单列该状态，不说成已观察健康；随后正常tick再查。不把每次轮转本身变成一次Bot告警。真正丢失、损坏或被容量淘汰的区间保持明确gap。封闭段的半行标记sealed_partial_line，不与下一段首条JSON拼接。

`journal-segment-window.node.ts`为既有离线incident/trace读取有界后缀，跨段共享字节与记录预算，返回每段descriptor身份、已退役计数及读取一致性范围。它不是跨文件原子快照；改名/缺段/变化均降低覆盖证明。普通watchdog compact遇到受管索引时只走同协议的段维护，不重写已登记活动inode；legacy语义压缩仍沿用原程序。

固定incident revision保存在既有SQLite，不与源段GC绑定。已捕获的失败在源段淘汰后仍可按同revision取证；源查询查不到旧STEP时有截断/退役覆盖信息，不能返回“没有发生故障”的结论。`runtime storage status`增加独立journals分区，分开数据与元数据字节、部分/缺失来源、待恢复状态与writerAdoption=not_checked；仍明确installationBudgetEnforced=false。

## 可执行证明

固定Bun1.3.14、原frozen lock和Node基线。可重复入口：

```bash
bun scripts/verify-runtime-rebuild.mjs journal-rotation
```

本次完整运行：**79 pass / 0 fail**，8个测试文件、552断言；类型检查、构建、Host import边界与含untracked的隐私扫描均通过。验证前后source摘要一致：`72b6fc5ab6a424a39b7d5ecdb8b230c1ec28c662b8f7d8fe4282100d35e64137`。实际preload为`84637f7bb4b60effb3f3a0d1ae2829afc4a356b2b65579ddc502b373f4ccf2e9`；本次确实增加Host日志leaf代码，不再沿用“仅build摘要变化”的上一片说明。

新文件 `journal-segment-rotation.test.ts` 有12项：旧游标续读、并发append、连续高基数写入/两次游标落后、四个轮转中断点、封闭半行、固定SQLite证据存续、删除意图中断、真实打包Node命令读取归档、符号链接/用户文件保护。容量测试使用8KiB受管数据预算持续写入200条不同失败，按真实文件大小断言，不是只检查数据库行数。

另外17/18文件集中回归中的后一次为155 pass / 0 fail。全CLI测试目录复验为670 pass / 0 fail、65文件、5327断言。随后packages全目录实际完成1647 pass / 15 skip / 0 fail，240文件、16599断言；与CLI目录合计2317 pass / 15 skip / 0 fail。跳过的原生资格不计通过，未沿用前片数字。

开发中发现并修复：提前校验日志目录时不能把用户设置的只读目录chmod回可写；失败仍应非致命且可观测。新测试中对嵌套coverage路径和不存在的optional字段作过断言修正，未削弱数据可读、无写入或pending不告警的判据。

## 资格与剩余范围

上一份modeld日志切片98b62ea已取得完整类型/构建/52项回归并线性合入v2。此次指定独立复核调用被工具安全检查拦截，未取得报告、未换模型或入口绕过；实现者检查不替代独立review。

本片不签全安装预算及新配置、所有storage owner退役、原生观察点完整性、断电与撕裂文件/死writer锁恢复、原生Webhook/Routine配对、Bot报告、持久自启或live采用。没有创建Bot/Routine、发Webhook/业务模型请求、提Issue、发布模板、修改现役配置或重启现役Host/modeld。新Host leaf必须随已合入v2的固定制品重新资格/采用，不能从离线Node读命令成功推导实际Host已加载。
