# 故障证据首个实施切片 · 2026-09-18

本报告保存 `b9b7277` 规划之后的固定源码范围与离线回执，不维护当前现场状态。专项合同归 [Template Ops Spec](../roadmap/template-ops-automation-spec.md)，实现范围归 [OBS-00–06](../tickets/README.md#incident-evidence)，当前 live 仍以 [LIVE 索引](../tickets/LIVE-integration-validation.md)为唯一入口。

## 实际交付范围

本切片实现最低证据结构、原生未知告警/无 STEP 队列失败入口、同库不可变证据修订、安全公共投影以及真实可调用的取证命令。它不是全部 OBS 或 Template Ops 已完成的声明。

| 入口/模块 | 本切片证明 | 仍不证明 |
|---|---|---|
| kernel observation | E01–E08 覆盖项、来源引用、缺口枚举、显式身份闭包、保守分类、无正文公共视图 | 所有原生边界已接线；缺观测仍为 not_instrumented/not_checked/partial |
| monitor 原有 SQLite | 未知 tray、无 STEP 的任务 failed 进入 incident；schema v3；直接 failure link 复用先到的告警 | 全部告警或所有卡住任务已被后台主动检测 |
| incident_snapshots / snapshot_links | 固定 revision、事实共享、digest 校验；事后补取不改旧修订，读取不发 RPC/模型或续租 | 全安装容量已强制执行，执行安全账本可以按 TTL 删除 |
| public-summary | 错误类别、规范化位置、报告内别名；无正文/真实 ID/私有摘要；修订别名稳定 | 自动诊断的数据许可或公开发布授权 |
| notification_work | 本地待通知记录；notice 包含实际取证命令，notify_then_end、automaticIssue=false | Webhook 已发送、Bot 已醒、App 已显示或用户已读 |
| 明细保留 | ack 不永久 pin 明细；期限、短租约、时钟异常保护与回收水位 | 全盘稳态、所有 metadata/制品/执行状态已安全 GC |

代码落点为 kernel `internal/observation/`、`internal/commands/incident-evidence.ts`，以及 box-runtime 的 `incident-evidence.node.ts`、`monitor-incident-intake.node.ts`、`observation-retention.node.ts`、`incident-evidence.runtime.ts`。CLI 不直接导入 Effect，共用 kernel command 与 box-runtime composition root。

原 `runtime incident` 的 journal 分支修复 coverage/lookup/retention/readFailure/health 接线遗漏。monitor STEP 取证可展开已索引 TURN/dispatch/failure/Tray 关联；旧格式与不同窗口的全部闭包资格仍需 OBS-02 反例，不以正常路径等价宣称全范围完成。

## 已实现的源码/制品命令

```text
grokbox runtime monitor incident <incident-id> --evidence-revision <n> --json
grokbox runtime monitor incident <incident-id> --view public-summary --json
grokbox runtime monitor capture --incident <incident-id> --confirm --json
grokbox runtime monitor capture --step <step-id> --agent <agent-id> --confirm --json
grokbox runtime monitor capture --tray <tray-id> --confirm --json
grokbox runtime monitor evidence lease <incident-id> --revision <n> --duration-ms <n> --confirm --json
```

incident ID 与 STEP ID 不混用。capture 只固定已索引的本地证据；按 STEP/tray 解析不唯一时拒绝。GET 不采集、不变更数据库、不准备快照；旧事故没有快照时返回 snapshot_not_captured，明细回收后返回 expired/summary 和缺口。

bot-diagnostic 当前只是本地显式读取视图，不代表已有目标配对、native caller 或数据同意检查的远端入口。自动接收能力需后续有资格的投递/claim 程序。

## 迁移与保留

monitor v1/v2 只经显式 init --confirm 迁移至 v3，保全备份、incident、ack 与管理身份；活跃或无法安全判断的 v2 collector 阻止迁移。迁移不为历史事故自动生成快照或待通知任务。通用配置版本未改变，T51 的下一配置 schema 尚未实现。

单份证据限制事实数和总量，优先错误核心，截断可见。明细与确认/静音解耦；普通读取不续租，累计租期从首次 lease 起算。SQLite health 分开分配页/空闲页/增量回收能力，旧模式需要显式重建时如实返回，不把删行当作已释放磁盘。

全安装诊断池、进程日志轮转、快照修订/metadata 总量、持久 GC 与 execution-state 协议退役仍由 OBS-04/05 完成；不得因本切片测试通过就长期启用未验收的自动采集/通知。

## 离线与打包回执

固定 Bun 1.3.14、frozen lock；依赖版本与 Node 下限未改变。完整回归分为两个不重叠的目录运行：

| 命令 | 结果 |
|---|---|
| bun test ./test --reporter=dots | 667 pass / 0 fail，65 文件，5297 断言 |
| bun test ./packages --reporter=dots | 1618 pass / 15 skip / 0 fail，236 文件，13543 断言 |

合计 **2285 pass / 15 skip / 0 fail**。跳过的原生资格不算通过。首次完整运行曾有两项失败：新 kernel 导出未登记、preload 指纹已变化。修正后结构/旧制品拒绝/CLI 的 35 项集中复验通过，再完成上述全量复验。

新增证明文件：

- `packages/runtime-kernel/test/observation-evidence-contract.test.ts`：最低证据缺失/截断/冲突、跨代关联、释放不等于执行、上游故障不能掩盖独立本地错误。
- `packages/runtime-kernel/test/observation-evidence-privacy.test.ts`：替换业务正文与真实 ID 后公共结构不变、修订别名稳定、getter/coercion 不执行、空 diagnostic 不报完整；仅有错误描述而缺实际请求见证时 E03 仍为 partial。
- `packages/box-runtime/test/incident-evidence-store.test.ts`：observer→journal→真实 SQLite→incident→notice；无 STEP 失败、固定修订、lease/expiry/ack、v2 迁移与活跃 owner 拒绝、未知 schema 的安全缺口。
- `test/monitor-incident-cli.test.ts`：执行 notice 命令、真实打包 Node 子进程、同源证据、GET 字节不变/无 sidecar、公共摘要不泄露身份、本地远端拒绝混用。

preload 与 v2 既有制品逐行对比只有内嵌源码摘要变化，没有 Host 执行代码差异。固定源码摘要 `b1f380c3abb52d19253fb2962ead895861192eb94424b2d9d7349f5700689461`，preload SHA-256 `22c202ecb737144eb3964523e63c0fa30f3158d22abd99b781a9eee043d6ca2b`；E09 pin 在真实重建和比较后更新，旧制品拒绝断言保留。

## 未闭合范围

E02/E04/E05/E08 完整原生观察点、OBS-01 的实际 source-liveness/周期未收束检测、OBS-02 全部跨来源闭包、OBS-03 目标权限、OBS-04/05 容量稳态/安全退役均未 Done。detectUnsettled 仅在提供真实 source-liveness 证据时产生 suspected，未伪造心跳接生产循环。

T43/T53 Routine/Webhook 未完成资格化；私有 Host 源直接读取被工作区路径边界拒绝，没有换入口搬运源或根据方法名猜写接口。T45/T46 未投递真实 Bot，T51 未切配置，T47 受托自主和 T48/T49 维护未在此切片交付；T52/T56 仍延期。

没有创建 Bot/Routine/Issue、发模型请求、改现役配置或重启 Host/modeld。独立 reviewer 无已完成回执；Herdr 执行入口不可用，作者自查和全仓测试不替代独立 review。

架构主 Spec 的同步与 LIVE 索引读取/同步流程遭工具安全检查拦截，未换路径或工具重试受拒操作。文档同步仍待；本报告不建立另一份当前 live 状态表，不把缺实现/review 改称只差现场。实际采用前仍须在唯一 LIVE 索引固定 v2 候选、来源前置、范围和结果。
