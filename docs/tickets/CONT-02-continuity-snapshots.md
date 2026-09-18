# CONT-02 — 连续性恢复快照

**状态：planned；S12原生context capture/checkpoint可复用，本票恢复快照尚未实现。**

合同：[S13.4](../roadmap/box-runtime-impl-spec.md#ownership-continuity)。依赖 [CONT-00](CONT-00-native-clone-feasibility.md) 与CTX-02，可与CONT-01并行。现场只看 [LIVE-OWNERSHIP-CONTINUITY](LIVE-integration-validation.md#live-ownership-continuity)。

## 目标与模块

在Bot仍归Box时，从原生已提交checkpoint保存有来源的恢复材料。接管后冻结最近完整快照及已知增量，报告截止水位。恢复材料不是第二个在线会话；正常模型请求仍使用Host选择的窗口。

kernel continuity定义manifest、质量与完整性规则。Host continuity reader复用context codec和原生安全点；原生Host继续写活会话。`io/continuity-store.node.ts` 在canonical durable root下保管私有快照，管理DB仅保存引用和状态。

## 材料与发布

与[OBS存储合同](../roadmap/template-ops-automation-spec.md#storage)分域：本票保存私有原生恢复manifest/blob，不是普通诊断JSON，也不发送到默认通知Bot。OBS-04只计量诊断引用，不直接回收本票可达blob；[OBS-05](OBS-05-safe-state-retirement.md)通过本票owner取得当前/上一完整manifest与未完恢复操作的保护根。容量不足停止新增保护并报告降级，不能损害已有闭包或原Bot checkpoint。

完整快照包括source身份/scope/Host版本、root revision、可达blob闭包、summary carrier和Host metadata、合法工具配对窗口、转录来源及水位、Memory分层manifest、model/effort/config revision。capture时间、checkpoint完成时间及完整发布时刻分开记录。

先验证所有引用可读，再发布manifest。不能在一次读取中追逐不断变化的最新root；并发变化须重新捕获或报告未完成。保留当前及上一完整版本和有界增量，GC保留被manifest引用的blob。存储满或读失败使保护降级，但不得损害原Bot的正常checkpoint。

Memory区分agent、user、project：私有材料随恢复计划选择；共享shard保留provenance，避免新ID造成重复事实。共享工作目录只记录关联。普通journal和通知不包含原始会话内容，快照访问有私有目录权限、路径边界、大小与保留期限检查。

原生export与内部snapshot helper的副作用边界以CONT-00为准。采用明确不修复原状态的reader，缺root时报告缺口，不把上传接口当本地只读备份。不能根据展示转录或脱敏日志声称获得精确原生root。

## 验收出口

实现时新增public owned-fixture及显式native资格测试，覆盖root并发变更、缺blob、未知schema、summary metadata、工具配对、越界路径、磁盘不足和崩溃。manifest发布前崩溃不得出现有效半份快照；发布后重启可完整读回；GC不能破坏已有有效闭包。

独立进程逐项验证hash及早中末sentinel，区分 `native_checkpoint`、`semantic_resume`、`memory_only` 和blocked。已有context维护测试只作回归；真实Host安全点和保全水位另入LIVE，不用新建空Bot替代。

## 禁止与非目标

不改原Bot归属或数据库，不恢复在途进程/网络状态，不复制旧待执行动作，不用普通日志补造缺失数据。本票只保全材料，不创建替身、启用routine或自动执行恢复工作。
