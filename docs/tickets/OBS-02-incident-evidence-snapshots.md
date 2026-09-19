# OBS-02 — 固定现场、同源查询与可用取证命令

**Status：Partial implementation / source and packed-read proof；M1未整票关闭。** Contract：[Spec §5/§10](../roadmap/template-ops-automation-spec.md#evidence)。依OBS-00/01，与OBS-03投影、OBS-04保留合同联合接线。现有STEP incident只读性质保持。

## 当前实现

已有同库不可变revision/manifest、共享fact引用与digest校验、离线incident/capture/lease命令、旧STEP入口coverage补接及公共安全摘要。增量实现每incident最多3份可读revision，通知与有效租约保护的revision不可淘汰；无可回收项则拒绝新capture。持久history watermark保证回收后不复用revision，缺失的已采集修订返回snapshot_revision_retired而非snapshot_not_captured，查询不借用新现场。

实际新增测试名为`packages/box-runtime/test/incident-evidence-store.test.ts`和`test/monitor-incident-cli.test.ts`；原计划中的同义文件名不再额外创建。本轮补充Host/modeld事发制品、原生tool handler与executor接受、checkpoint和collector/native health的严格身份关联；组合source failure→固定revision→sender及打包Node读回已接线。全部跨来源、异步prepare worker、所有崩溃矩阵与独立review仍未关闭，不以局部补齐宣称全量原生覆盖。限定证据见[首片](../reports/2026-09-18-observation-evidence-first-slice.md)及[存储增量](../reports/2026-09-18-observation-storage-followup.md)。

## Goal / Modules

一次告警对应可稍后读取的固定证据，不依赖用户先运行导出命令。kernel `internal/commands/incident-evidence.ts`、`evidence-contract.ts`；box-runtime `io/incident-evidence.node.ts`和原monitor-store；CLI `commands/monitor.ts`、`commands/outcome.ts`、registry。

## Work

建立IncidentEvidence v1的immutable revision/manifest：关联身份、fact/assessment、事发制品、后补当前状态、E01–08覆盖/缺口、数据视图、digest、保留tier/期限。默认一份有界JSON，分页sections共享原证据引用，不复制events/trace/presentation三份正文。

collector提交通知准备任务后，独立worker固定最小现场；manifest未完整发布前不能宣称full/ready。部分来源失败也保存partial/summary与原因，不能等昂贵诊断或Gateway恢复后才提醒。跨DB/blob恢复采用staging、closed reference set和提交回执，孤儿归OBS-04。

统一journal/monitor的显式身份闭包、source冲突和legacy关系；接回coverage/lookup/retention/readFailure/writer health。缺在保留窗口、截断、redacted、unsupported与未instrumented分开，不因已知失败的其他证据缺失将其抹掉。

已注册命令：`runtime monitor incident <id> --evidence-revision <n> --json`为稳定主查询；`runtime monitor capture`是明确本地写入；`runtime monitor evidence lease`是单独限时预留。现有`runtime incident <step-id> --agent`不改接收身份，不能把monitor UUID放到STEP位置。

通知command descriptor从实际registry/capabilities生成：一主一补充、validated argv、readOnly、box-local requirement；自由文字不能拼shell。无能力或目标无Box执行权限时说明限制，不伪造命令。查询过期revision返回保留的summary/expiry，不改查“最新Bot错误”。

## Executable acceptance

当前命令（完整验收矩阵仍需在这些文件中补齐）：

```bash
bun test packages/box-runtime/test/incident-evidence-store.test.ts test/monitor-incident-cli.test.ts
bun test test/runtime-incident.test.ts test/alert-trace-review.test.ts test/incident-observability.test.ts
bun run typecheck
```

临时真实SQLite/journal和新进程验证：无Gateway可读、monitor/journal同身份闭包、跨代冲突、unknown来源、后续回合/升级不改变旧revision；capture前后crash、blob缺失、quota不足、并发新增revision不出现半份full快照。

字节/mtime检查所有GET不建库、不capture、不GC、不续租、不产生网络/模型/重试。实际CLI解析每种notification descriptor，按可用制品能力拒绝不存在命令。独立进程在源journal轮转后取得固定核心，明细过期则summary-only和gap。Lease预留/读者并发由OBS-04集成验。

## Forbidden / Non-goals

不把history outcome含正文结果直接对外，不按ctime/最近活动猜关系，不在read中重建事实，不通过diagnostic manifest声称能恢复原生上下文。CONT-02自己的私有恢复blob与此物理/权限域分开。

## Exit evidence / LIVE

提交schema例子只能用合成数据，留source/packed CLI、crash/retention证明；原生边界与通知后取证在[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)。
