# CONT-05 — 北极星全链验收与分阶段发布

**状态：planned；贯穿M0–M5，不只验第一条clone实验。**

合同：[S13完整里程碑与矩阵](../roadmap/box-runtime-impl-spec.md#continuity-delivery)。依赖CONT-00–04及CONT-06–11各自实现/离线/原生资格/复审出口。动态现场状态只在[LIVE唯一索引](LIVE-integration-validation.md#live-ownership-continuity)。

## 北极星验收旅程

受保护Box Bot正常工作并有分档快照；确认接管后通知、按配置暂停Routine；新真实Box身份获得尽力保真的人设/Memory/历史/当前状态，第一轮和Host重启后第二轮均正确接续。新Bot开始接已明确职责，旧Bot同时继续收到DM/群聊及外部结果；程序机械迁移、旧Bot辅助指路，所有失败/unknown逐项挂账。持续健康观察旧入站收敛，满足依赖与删除条件后退役；多代替换不中断、不重复业务、不无界积累存储。

整个旅程不以逐字复刻为目标，但来源/缺口、角色和工具配对、native读回与未结副作用必须诚实。partial不是假成功，一个unknown职责不阻塞其他独立职责；无法安全删除则报告保留，不把功能缺失说成已完成。

## 分层出口

| 阶段 | 收据要求 |
|---|---|
| M0 | CONT-00新增所需原生资格＋CONT-11策略/逐职责规则；旧8探针仅原生边界子集 |
| M1 | CONT-01真实发现/暂停/通知，CONT-02分档完整保全，CONT-06官方duplicate；不等全部替身完成才交付保护 |
| M2 | CONT-07唯一当前状态和CONT-03 clone；原生读回、新进程恢复目标最新状态，源资源删除独立性 |
| M2b | CONT-08初始化后才首次启动、指定指令/模型，无伪Human任务，临时生命周期与结果交付 |
| M3 | CONT-04/09新旧并行、逐职责接管、实际群/DM/任务与handoff标题/侧栏投影 |
| M4 | CONT-10真实旧入站/gap、quiet和依赖、删除前竞态及退役后多代解析 |
| M5 | 成套v2制品、Host更新/强杀/重新领养、unknown恢复、实际App入口、存储长期稳态、配置/技能/帮助与完整归属退出 |

辅助能力必须有交付出口，但已合格主线不等待完整通用平台。新命令/配置只在实现和消费者检查后进入README/技能；既有未启用不冒称已启用。用户已拒绝多session和跨机器，验收不得悄悄引回这些产品范围。

## 测试方式与真实性

public fixtures独立生成预期；生产codec/operation/SQLite/Node制品实走，Provider fake从实际request检查sentinel，而非直接回答正确文本。原生方法明确opt-in固定SHA；真实Host、Server、模型、通知接收和App各自取证。已有入口：

```bash
GROKBOX_TEST_NATIVE_HOST=1 bun test --timeout 30000 packages/box-runtime/test/ownership-continuity-native.test.ts
```

该命令不证明clone/spawn/交接/删除。新测试在来源票实现时注册，无空壳verifier、绿色skip或只问模型记不记得。逐步注入崩溃/迟到/丢回执、缺blob/环境不符、原生commit后mirror失败、旧事件重投、群成员并发和重复迁移；记录实际效果次数与剩余不确定性。

## 发布和失效

功能worktree完成实现/离线与独立复核后线性合入v2，固定CLI/preload/modeld/Host profile/config组合才做现场。不会因本规划自动创建Bot、唤醒、重启、迁移群或删除；实际窗口指定对象/费用/退路，不为验收强迁真实业务Bot。

Host接口/Blob/Memory/prompt重建、输入/任务结算、Routine/peer/group/删除、标题codec、config/权限/预算/服务生命周期改变时只重验受影响性质。每条LIVE显示已证范围、未证、阻断和下一步；来源票保存代码/离线/review，不能再维护第二份动态live账本。
