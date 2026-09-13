# 持续观测与本地 incident

本页拥有当前命令、存储和排障语义；产品合同在 [Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation)，剩余实现/完整验收归 [T41](../tickets/T41-continuous-observation-and-alerting.md)，候选及实际部署仅记 [readiness](t32-live-enable-readiness.md)。2026-09-13 已实现第一条本地纵切，**未安装常驻服务、未对现役 Bot 启动采集、未关闭 T41/V28–V30**。

## 当前命令

命令绑定本机 runtime root，拒绝远程 Profile；目标为明确的公开 Bot UUID，不用名字猜身份。

```sh
grokbox runtime monitor init --confirm --json
grokbox runtime monitor run --agents <uuid1,uuid2> --confirm --once --json
grokbox runtime monitor run --agents <uuid1,uuid2> --confirm --interval-ms 30000 --json
grokbox runtime monitor snapshot --json
grokbox runtime monitor events --limit 100 --json
grokbox runtime monitor events --after <cursor> --limit 100 --json
grokbox runtime monitor incidents --limit 100 --json
grokbox runtime monitor incidents --after <cursor> --limit 100 --json
grokbox runtime monitor ack <incident-id> --request-id <uuid> --expected-revision <n> --json
grokbox runtime monitor snooze <incident-id> --request-id <uuid> --expected-revision <n> --until-ms <epoch-ms> --json
```

`init` 显式建库，已有数据库只验证，不覆盖；`run` 显式启动前台 collector，`--once` 只提交一轮后退出。未加 `--once` 时，命令持续串行查询，网页不存在也可以运行；正常 SIGINT/SIGTERM 结束本次 collector，**不是自启安装、不是新的 supervisor**。不能把 Shell 后台运行或 tmux 存在当作 T40 持久部署已完成。

`run` 使用现有 Host 官方认证读取桥，批量查询1–32个 UUID；普通 snapshot/events/incidents 只读本地库，不查询 Server、不建库、不启动 collector。`alerts list` 仍是原 Host tray 入口，两类告警不混用。

## 事实、变化、显示和管理

输出始终保留 `admissionAuthority:false` / `productionAccepted:false`。Server 登记、执行准入、配置写入、Host 原生会话都没有改由本库负责。

采样复用 `inspectOwnership`，保留四类状态；必须有原生读取桥提供的稳定 scope 与有效来源时间。旧 schema1 没有 scoped 证据时返回 `scope_unavailable`，不从本地配置或 UUID 造一个权威 scope。读取失败保存最后已知事实但标不可用；字段缺失不解释成 Bot 被删除或迁移。

同 scope 的两次成功观察才能生成 `ownership_changed`，记录“上次来源观察时间 → 本次发现时间”的区间，而不是把返回时间当后台迁移发生时间。`lastSuccessMs` 取上游读取桥的 `serverObservedAt`，不把慢回复抵达时刻算作刚查询成功。账号/team/backend/machine scope 变化单独记录；新 scope 不继承旧 Bot 的确认/静音状态。最近成功的 Gateway 运行代只作来源证据，不授予任何控制权。

首次就冲突可生成 baseline `ownership_conflict`，不能编造先前迁移。读取失败另开 `observation_unavailable`，不会解决既有冲突。`ownership_changed` 表示检测到一次变化；同 scope 下一次新鲜成功观察确认其稳定后可恢复此事件周期，是否仍冲突另由冲突 incident 表达。

同一持续条件只保留一个 open incident，轮询更新 lastSeen；恢复后再发生生成新 ID，不继承原周期的 ack。Ack/snooze 与 open/resolved 独立；确认不等于修复，静音不改变准入。管理请求绑定 requestId+expectedRevision：同请求同意图可对账，改意图/旧 revision 明确冲突；已 resolved 周期不被复活。

## 本地事件出口

每轮 `run` 的 NDJSON 包含提交后的 `changes`：稳定 eventId、incidentId、对象及 scope、观察时间和变化区间。只能在对应 SQLite 镜像原子提交完成后发布；写库失败不提前广播“成功”。`events` 支持游标补拉，`incidents` 支持有界 keyset 分页，`hasMore` 不隐藏截断。游标绑定 databaseId 与 collector epoch，旧 epoch/未来事件位置或错误格式明确拒绝。

当前 `notificationMode:local_only`：本地事件和 incident 可查，并没有把事件打印成功解释为远端通知已确认。尚无外部渠道/投递重试与 receipt，也没有动态提醒升级；ack/snooze 只是持久管理状态。输出错误使 collector 退出，不重发模型或修复身份；已经提交的观察仍可由 events 查询。

## 一份有界 policy

数值在 `packages/runtime-kernel/src/monitor.ts`，不由网页另定：默认间隔30秒，范围10–300秒；每次读取最多10秒，串行完成后再等待，不补跑错过的轮询。失败指数退避到最多300秒，0–10%正抖动，成功后复位。源观察90秒以上为 stale；观测新鲜度不是 T37 准入的5秒合同。

最多32个目标；事件/incident每页最多200；数据库16MiB、事件50000条的硬上限，触顶明确要求维护，当前不自动删除管理事实。Snooze最多24小时。各查询读取当时完整本地镜像，不因四个视图打开而发四次 Server 请求。

第一片尚未实现 admission/background 的跨调用统一优先调度、事件触发刷新或完整过期定时器；当前 collector 自身串行批处理，现有原生读取缓存和 T37 准入保持各自合同。

## SQLite 与发行包

路径为 `${durableRoot}/observability/observations.sqlite`。使用固定 `sql.js@1.13.0` asm 版作为 Node20 可运行的 SQLite 引擎，**不是 node:sqlite，也不是原生 WAL/VFS**。每次管理/采样写在短 exclusive writer lock 下读取最新完整镜像，执行 SQLite 事务，再 export 到独占0600临时文件、fsync、rename 和目录 fsync；成功后才返回。读者打开旧镜像或新镜像，不安装一半事务；不跨事务保留可回写的缓存实例。

这项选择用于目前低频、小规模本地观察，代价是每次写出完整数据库。16MiB上限和显式维护是当前支持范围；更大负载需另行资格化磁盘VFS，不把本实现宣传成适合无限审计日志。

引擎打包成 `dist/observation-sqlite.cjs`，只在实际读取/初始化监控库时加载；普通 CLI 与 Host preload 不加载这份引擎。Node20契约、根包 `dependencies:{}` 不变，MIT notice 随包分发。真实 Node20.19.0 / Node22.22.0 冷进程以及安装后的 tarball 已有独立检查，具体计数绑定 readiness 候选，不由本页永久背书。

## 故障与未完成事项

| 结果 | 正确处理 / 当前限制 |
|---|---|
| `monitor_not_initialized` | GET不建库；明确确认后 init |
| `monitor_store_invalid`、schema/root mismatch、unsafe、损坏 | 保留原文件，不删库“修复”，不推断原生执行失败 |
| `monitor_writer_busy` | 当前事务未获得写锁；复用请求标识有界重试，不能覆盖锁 |
| `monitor_already_running_or_recovery_required` | 当前 collector 或残留锁存在；不多启第二个 collector、不猜 PID 杀进程 |
| `monitor_commit_failed` | 发布前失败，旧镜像保留，未广播本次成功 |
| `monitor_commit_unknown` | rename后目录确认失败，可能已提交；同 requestId/同意图查询或重试，不造新业务操作 |
| `monitor_cursor_invalid` | epoch/库或位置不匹配，重取快照并承认观察缺口 |
| `monitor_revision_conflict` / `monitor_request_conflict` | 重新读取；同ID不能偷改意图，ack不是修复 |
| capacity/retention required | 停止新增观察并报告；当前没有自动清理或无证据空库重建 |

**硬崩溃锁回收、备份/旧库迁移/保留维护目前未实现。** 普通退出和重启保留管理状态；崩溃留下 lock 时保守拒绝，不能声称已具备无人值守 crash recovery。恢复后的 epoch 必须更新；`collectorRecordedRunning` 只是一项持久记录，不证明此刻进程活着。snapshot计算freshness，已停止collector的lastKnown不冒充live。整盒失联仍需未来盒外观察者。

剩余 production 路线：T41补安全恢复/维护、共享刷新与通知receipt；T40装配现有服务owner与自启；现役 scoped bridge/T37资格、T38保全及T39真实模型/原生checkpoint仍独立。没有因本模块引入而部署新Host、校准test2或创建真实Bot任务。

## 可重复入口与失效条件

```sh
bun scripts/verify-runtime-rebuild.mjs observation-monitor
```

该入口使用合成Server/Clock/Gateway、真实SQLite文件、源collector/CLI和真实打包Node读写；没有调用真实Server或provider。安装回归另验tarball的companion与只读行为。SQL adapter、依赖、schema、policy、native scope/timestamp、打包布局或命令变化后，需要重新资格化；已保存观察不是源版本永久有效的证明。
