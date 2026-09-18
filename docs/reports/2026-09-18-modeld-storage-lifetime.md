# modeld 生命周期内存储维护与诊断占用计量 · 2026-09-18

本报告保存 `af1195d` 之后的固定实施与离线证明。合同归 [Template Ops Spec §8](../roadmap/template-ops-automation-spec.md#storage)，实现归 [OBS-04](../tickets/OBS-04-bounded-observation-storage.md)/[T51](../tickets/T51-ops-capability-presets.md)。当前现场只看 [LIVE-OBS-STORAGE](../tickets/LIVE-integration-validation.md#live-obs-storage) 及配置切换、服务持久性条目；本报告不维护第二张现场状态表。

## 实际交付与 owner 边界

`modeld.runtime.ts` 在成功拥有 listener 并发布 ready 后，于嵌套 Effect Scope 启动 `storage-lifetime.runtime.ts` 子任务。它复用既有 SQLite、journal 与过程日志 writer 的回收程序，不启动第二个 collector、Gateway 采样、模型循环或 daemon。借用已有服务的 CLI 不进入该分支，也不创建、轮转或重置维护回执。

启动后执行一次有限维护，之后每次完成再等待30秒。单次工作不重叠、不追赶遗漏周期，不因错误无限立即重试。每轮重新读取 canonical storage 意图，独立于 `ops.enabled` 和通知开关；配置旧版/损坏时记录 configuration_unavailable，不启动默认GC。缺失观测库只报告 not_initialized，不自动建库或迁移。原生事件采集仍由原 collector 负责，维护执行成功不代表已经安装监控或向 Bot 投递。

回收先完成并释放 SQLite 事务，再处理两个显式 journal root；忙锁单次跳过。SQLite仍用原增量生命周期规则/128页回收，不引入 full VACUUM、任意路径删除、执行账本TTL或新授权。过程日志新增同writer的闲置维护，只回收到期关闭段，不创建、截断或切换正在持有的活动fd。捕获的过程日志策略与新请求revision不符时报告 policy_changed，不静默把旧writer当作全部热加载成功。

嵌套Scope先中断并等待维护工作结算，再记录服务退出和释放过程日志/listener。真实文件/数据库提交不能以 Promise 超时弃置；若无法在原服务关闭预算内结算，沿用 cleanup_gap，不释放成假成功。维护/回执错误不改变已允许的模型执行或关闭服务。单次超过50毫秒计划预算会被记录，不宣称底层I/O硬实时。

## 维护本身的有界证据

每个runRoot仅写 `log/storage-maintenance.json` 和固定暂存槽 `storage-maintenance.next.json`，各最多16KiB。它是观察记录，不是执行锁、配置applied回执或自启安装凭据；损坏或不明归属的暂存文件保留并使回执降级，不不断创建随机临时文件。

回执记录服务epoch、内部进程启动身份、有限周期序号、最新实际结果、最近完整成功时间及各来源状态/回收量。公开的本地状态投影不返回PID/start或任意原始错误。查询对照带boot信息的进程身份，区分 running/stopped/interrupted/stale/unavailable；存活PID或历史成功不构成全安装容量/当前Host采用证明。GET不执行GC、初始化、恢复或续租。

## 诊断占用计量

`runtime storage status`新增 maintenance、footprint 和 budgetComparison，仍保留原来的monitor/processLogs/journals/storageIntent。

footprint只扫描明确的durable observability、durable log和run log命名空间的文件元数据。全调用最多2048条目录项、最大深度4；不会打开文件正文或输出文件名/路径。实际备份、暂存和SQLite辅助文件即使不能被数据库解析也计量。按device/inode去重，同一根或硬链接不重复累计。逻辑文件长度与实际allocated块数分开；符号链接、特殊文件、权限/身份问题、扫描期间变化和预算截断均显示partial/gap，不跟随陌生目标。

budgetComparison以已计量命名空间对照请求目标/max，超过门槛时明确提示；未超过只表示counted_namespaces_below_target，不签整个安装健康。Jobs、执行/恢复状态、制品及命名空间外导出仍列为未覆盖owner。计量不授予删除权限，不等于writer预留；`installationBudgetEnforced=false`保持。其他owner和辅助文件的跨进程物理预留仍需后续实施。

## 可重复证明

固定Bun1.3.14、原依赖/Node基线，组合入口：

```bash
bun scripts/verify-runtime-rebuild.mjs storage-lifetime
```

完整组合 **63 pass / 0 fail**，10文件、2977断言；类型、构建、运行时边界、含未跟踪文件的隐私检查通过。验证前后源码摘要一致：`e755a430a6cba2472df98ce68a38ee66f620c3f105bf630178796c4b1a09108e`。preload实际SHA-256为 `ef59a84f64897b401a430ccc6f93834edc9923875396de0827cbef889dae363d`，拒旧制品pin依据实际构建并通过。

全仓不重叠目录：CLI **676 pass / 0 fail**（66文件、5404断言）；packages **1705 pass / 15 skip / 0 fail**（246文件、16950断言）。总计 **2381 pass / 15 skip / 0 fail**，原生资格跳过不计通过。

新增13项具体证明包括：真实modeld无collector/通知关闭时回收已有SQLite过期快照；borrower不重置回执；正常退出后无晚写；坏配置不动证据；闲置日志不改变活动inode；不安全回执路径不触碰用户文件；延迟中的维护结算先于停止；失败周期和失败输出不终止后续工作或形成快速重试；30次回执写入仍仅一个固定文件；真实打包Node owner启动并被SIGKILL后只读报告interrupted；实际备份/暂存/硬链接计量；深树/符号链接缺口；2080小文件的扫描上限和无删除。

源模型/Gateway请求没有用于这些验证；文件、SQLite和Node进程均为测试专属临时资源。注入的短调度间隔与延迟barrier用于生命周期验证，正式代码仍使用30秒固定间隔。作者检查、隔离Node证明和绿色全仓不替代独立review、真实安装或原生Bot交付。

## 未签范围

没有切换现役Host/modeld、迁移生产配置、更新全局shim、创建Bot/Routine、发送Webhook或模型请求、公开Issue或发布模板。schema4候选仍需与现役schema3成套切换；模型schema和wire未改号。

本片让必要回收不再仅依赖手工启动collector，但不证明modeld在Box重启后自启，不把服务owner和boot安装混为一谈。独立review、全安装物理预算、其他owner、安全状态退役和原生通知仍按来源票推进。并行新增CONT单盒/逐职责交接规划保留；恢复vault、当前上下文和未结职责不在本片GC范围内。
