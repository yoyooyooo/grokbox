# OBS-01 — 通用故障入口与主动未收束检测

**Status：Partial implementation / local intake and scheduling proof；M1未关闭。** Contract：[Spec §3–4](../roadmap/template-ops-automation-spec.md#chain)。依[OBS-00](OBS-00-evidence-contracts.md)；复用T41索引和共享读取，T44负责HSO接线，CONT-01负责归属规则，不建立并行collector。

## 当前切片

未知原生error tray、无STEP原生run failed与unsupported source gap已进入同一incident/固定证据/本地待通知流程。历史失败可索引，但超过通知新鲜窗口不生成新的Bot唤醒工作；压力丢弃只推进有gap的消费水位，不伪造故障现场。journal drain与远端采样已在同一Effect宿主分离，挂起RPC不会挡住本地失败。

实际证明在`observation-evidence-contract.test.ts`、`incident-evidence-store.test.ts`、`observation-storage-pressure.test.ts`和`monitor-scheduling-review.test.ts`。主动停滞检测现已接入同一次原生ownership响应中的run-observer窗口：只对相同Agent/dispatch/Host代、5秒内且未丢任务的started任务判断suspected；队列等待、工具/审批、缺task、旧代或不完整窗口均不猜死锁。并行工具全部结算前保持等待阶段，实际模型流消费更新进度。健康读本身不刷新任务进度，缺terminal不推断完成。全部来源/动态目标、原生现场资格、prepare异步化和独立review仍未闭合。限定结果见[首片](../reports/2026-09-18-observation-evidence-first-slice.md)及[增量](../reports/2026-09-18-observation-storage-followup.md)。

E2E前组合已验证生产observer任务失败→实际journal→双源collector→SQLite固定revision→持久授权sender→loopback HTTP；真实原生Provider/App未运行。授权前发生而后入库的旧故障必须同时被工作选择和自动发送入口拦住，不能因work创建较晚补发。详见[回执](../reports/2026-09-19-pre-e2e-observation.md)。

## Goal / Modules

避免“evidence入库但没有incident/通知”。kernel `internal/observation/incident-rules.ts`；box-runtime `monitor-occurrence.node.ts`、`monitor-store.node.ts`、`roots/monitor.runtime.ts`及各source adapter。显式来源和分类范围，不声称覆盖全部上游类型。

## Work

统一接受执行失败、独立未知error tray、run failed、无STEP拒绝、组件健康变化及观察器gap。没有STEP按真实dispatch/failure/tray/source事件建立occurrence；补到STEP后只关联不复制故障。未知schema只保存允许的形状/计数/来源与coverage，不保存原文。

分类维度分开fact origin、mechanism、attribution、impact、certainty、recovery。纯上游需要足够正证据；503加本地未收束/错误重试仍是本地问题。已恢复的项目bug保留。用户取消/正常权限拒绝不得变成项目error；缺用户影响也不丢真实未知异常。

同事务提交evidence、incident/assessment版本、消费游标和通知准备意图。事件/分类/通知去重独立：重放不新建，重分类不重发，重要证据/影响变化可更新同occurrence。ACK/snooze不等于resolved；恢复仅靠同对象当前正证据。

open-execution索引记录实际开始/等待原因/最后进度/期限/终结，定时检查支持的未收束规则；正常审批、长任务、source失联、suspected-stall与已证契约违例分开。不能因缺terminal直接推断deadlock；缺source coverage先产生观察gap。

本地journal drain、上游采样、过期检查各自有界调度，共用单事务writer；慢RPC不阻塞本地错误入库，不提高Server取证频率。管理目标集合可更新，遗漏和不支持对象在coverage中可见。所有权撤销执行保护仍不依赖SQLite/通知。

## Executable acceptance

待新增：

```bash
bun test packages/runtime-kernel/test/incident-intake.test.ts packages/box-runtime/test/incident-detection-pipeline.test.ts packages/box-runtime/test/incident-liveness.test.ts
bun test packages/box-runtime/test/monitor-correlation-review.test.ts packages/box-runtime/test/monitor-scheduling-review.test.ts packages/box-runtime/test/provider-route-monitor.test.ts
```

关键反例：未知tray和queue failed均只有源事实而无STEP，必须生成可查询incident及一次通知准备；只做事件入库不通过。无tray失败、pre-STEP、重启后源重放、同scope/新代乱序、共享服务父子归并、纯503/503叠加本地bug、recovered错误均有断言。

FakeClock验证无进度但正常审批不误报、缺observer不能判任务失败、迟到terminal不复活任务。故障注入覆盖commit前/后崩溃，cursor不越过未落证据。测健康本地append→ready延迟与慢上游源隔离；就绪快照接OBS-02后再验完整时间。

## Forbidden / Non-goals

不向Gateway sendPrompt、不调用模型判断分类、不修复/清tray/取消任务、不以时间或名字拼执行身份、不从SQL恢复准入。源异常不因日志写失败被改写。外部整盒离线观察不在本票。

## Exit evidence / LIVE

列出规则集合、unsupported来源、E01–08覆盖及实际故障→incident→准备工作证明。[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)与[MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence)分别拥有原生/持续现场；本票不以离线证明当前已安装。
