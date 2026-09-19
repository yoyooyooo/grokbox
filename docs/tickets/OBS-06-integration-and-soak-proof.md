# OBS-06 — 观测、脱敏、保留与通知的成套证明

**Status：Partial / E2E前观测组合已实现；全安装稳态与安全退役未签，M4未关闭。** Contract：[Spec §11](../roadmap/template-ops-automation-spec.md#tickets)。依OBS-00–05、T44/T45/T46的最小纵切与T51/T54；T50拥有服务安装/原生发布验收，本票拥有证据/存储成套回归，不重复维护LIVE状态。

## Goal / Modules

验证真实写入边界到可用告警的完整链，避免“JSON好看”“一张issue创建”“一次GC成功”取代产品结果。默认不需要Issue、gh认证、高级分流、自动维护或CONT完整恢复。

已建立生产observer→真实journal/SQLite→固定现场→持久授权sender→loopback HTTP组合，实际Node CLI/daemon安装、强杀、重开及读取接续也有独立用例。稳定组合为`pre-e2e-observation`，不为了原计划名再注册同义空组。当前真原生账号/Provider/App与24小时稳态仍未运行。

## Acceptance matrix

| ID | 最低证明 |
|---|---|
| O01 | 真实源事件→journal→SQLite→incident→固定revision→outbox；未知tray、queue failed、无STEP各通过 |
| O02 | 告警一主一补充命令可在发布Node CLI执行；无Gateway仍读本地证据，空/丢/冲突不伪装健康 |
| O03 | E01–08最低证据与gap保留；前序工具副作用、context未知、事后版本改变不误归因 |
| O04 | 实际通知网络bytes与所有导出/错误日志通过隐私非干扰及秘密哨兵；Bot不先读raw |
| O05 | 预算、去重、ACK丢失、bind改动、断网、崩溃后不广播/无限唤醒；默认零诊断/维护/GitHub |
| O06 | journal轮转、DB/索引/临时物理bytes长期稳态；高基数错误/ack/open/过期pin也有界 |
| O07 | GC后查询summary-only有原因；通知引用/在读租约不无声失效，ops off仍有必要GC |
| O08 | 旧ID在GC/新进程/恢复后不重新执行；commit_unknown和恢复manifest闭包保持 |
| O09 | 慢上游读取不拖住本地错误检测；积压和drop可见，不增加准入RPC频率 |
| O10 | 用户随后委托同incident，原生Bot能继续任务；提醒模板不成为永久能力禁令 |

## Executable exits

当前已实现并可运行：

```bash
bun test test/incident-evidence-integration.test.ts test/monitor-service-packed.test.ts packages/box-runtime/test/observation-producer-boundaries.test.ts
bun scripts/verify-runtime-rebuild.mjs pre-e2e-observation
bun run typecheck
bun run check:publication
```

默认public owned-fixture＋临时真实SQLite/LevelDB/HTTP＋受控进程，不调用真实账号/模型。soak缩小预算、至少20轮填充回收并另测默认参数，不把小样本百分比推为生产SLA。逐项记录source/packed/physical-storage/原生隔离/独立review，测试跳过保留notProven。

## 当前证明边界

O01/O02/O03/O04/O05/O07/O09已补实际源producer和组合路径，不能仅用最终JSON断言代替：原生handler和checkpoint挂点有固定源函数探针；公开默认测试使用owned原生边界，文件/数据库/Node/HTTP为真实依赖。尤其新增反例发现并修复授权前故障在授权后才入库导致误补发，工作选择与直接自动入口均检查incident first_seen和work created_at。

O06新增已安装诊断writer共享接纳、事务临时空间预留和24轮真实文件/SQLite填充回收；O07验证材料到期退役但未知attempt的禁止重放标记仍保留。O08已有自动worker启动边界和同进程数据库恢复反例，不签全部执行/恢复台账安全退役。O10真实Bot行为必须在原生窗口观察；没有因此实现完整受托诊断policy。当前完整离线组合、全仓结果和精确源码身份见[联合接纳回执](../reports/2026-09-19-diagnostic-admission.md)，独立review仍单独记录。

## Native / LIVE gates

[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)：原生writer到提醒后相同revision可查；[STORAGE](LIVE-integration-validation.md#live-obs-storage)：真实安装常驻/容量/回收/关闭；[SAFE-RETIREMENT](LIVE-integration-validation.md#live-obs-safe-retirement)：原生未决状态、延迟请求与恢复。T50继续复用ROUTINES/RECEIVERS/OBSERVER-LIFETIME，CONT保留其恢复窗口。没有费用/对象授权就不跑native，不能用mock HTTP冒充。

## Forbidden / Exit evidence

不重启生产来清空历史制造稳态，不删业务数据，不以全仓绿覆盖单项缺证，不另建当前live账。独立固定候选review应核对隐私、语义退役和未知副作用；未完成就明确pending，不能以实现者自审冒充独立review。
