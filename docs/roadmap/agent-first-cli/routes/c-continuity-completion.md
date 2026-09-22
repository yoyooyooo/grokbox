# C · 完整恢复、self-reset、交接与原生退役

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-continuity-complete`，从当前v2切出。核心管理入口迁移已闭合，完整自动接替/退役继续交付，但不作为普通切模型日用的整票前置。

## 目标与入口

使真正的恢复材料、启动屏障、逐职责接替、旧入站和资源独立性形成完整链路；目标可工作与旧对象可退役分开。先读[CONT-02](../../../tickets/CONT-02-continuity-snapshots.md)、[CONT-03](../../../tickets/CONT-03-native-box-clone.md)、[CONT-07](../../../tickets/CONT-07-current-context-control.md)、[CONT-08](../../../tickets/CONT-08-instructed-spawn.md)、[CONT-09](../../../tickets/CONT-09-relationship-handover.md)、[CONT-10](../../../tickets/CONT-10-inbound-convergence-retirement.md)和[CONT-05完整旅程](../../../tickets/CONT-05-continuity-acceptance.md)。仅按所做出口展开阅读，不重读全部历史。

## owner与模块

原`packages/box-runtime/src/internal/roots/bot-lifecycle.runtime.ts`、bot-protection/handover/convergence及continuity-native-*；原CONT recovery/safety/current-state存储、kernel continuity合同、Server context/lifecycle/handover用例。不要另造工作流/operation库。

B拥有材料/附件枚举、writer和引用闭包；A统一原生checkpoint/startup/入站/删除接缝与资格；D拥有原生群/DM/消息关系，E拥有观察装配和incident。C拥有原CONT策略、阶段、引用保护与效果恢复。原current-state、Compact、handover管理入口和回执已迁入，不以迁移名义重新实现。

## 出口与阻塞

| 出口 | 可开始条件 | 必须交付 |
| --- | --- | --- |
| **C1 队列与消费合同** | J0即可做本域程序；A1提供安全点，B1提供材料合同 | self-reset先持久登记/返回，当前回合结算后由原owner执行；迟到工具/checkpoint/Memory不串revision。恢复材料/工作流引用和GC同事务；有界预算、未结职责和原请求定位。不得Bot等CLI、CLI等当前Bot死锁 |
| **C2 完整恢复与职责接手** | A1相关能力、B3资源闭包、D关系原语 | clone/replace/spawn真实目标身份、准备/初始化/激活/首轮、重启后最新状态、源删除独立；逐职责迁移保留原启用意图、独立项可继续、unknown不重发；多代关联和未交付结果可追踪 |
| **C3 收敛与安全退役** | C2；真实入站覆盖/原生条件删除边界 | 旧DM/群/外部结果收敛、quiet/gap、全部依赖、资源独立与原子屏障；准确原生退役和原删除回执恢复；临时spawn费用/TTL/结果交付与孤儿清理。交J5 |

完整C2/C3可后置；E/R必需保全涉及CONT捕获/引用的真实缺陷须优先修原owner并交E1/R1，不能因路线后置把数据保护也关掉。当前没有可靠原生屏障时保留具体CODE/DEP，安全blocked不是整项交付。若能力确实改变可实现的产品承诺，按Spec变更规则对齐，不凭quiet、时间到期或人工hash强删。

## 验证

复用`test/context-management.test.ts`、`test/lifecycle-management.test.ts`、`test/handover-management.test.ts`、`packages/box-runtime/test/native-current-state-owner.test.ts`及原continuity恢复/引用/保留/并发/强杀测试。C1/C2分别有可执行出口，不建立空的verifier标完成。

实际原生/Provider/关系/删除资格由A/R/D/Q共同窗口验证；合成账号+原owner测试不能签真实资源独立。旧B0不得覆盖目标B2，不凭现有内容反推旧提交成功，不从新UUID获得重放机会。缺确认的未知删除只对账原记录，不再发delete。

## 回流

各出口阶段性合回v2，报告原owner和新增合同、依赖生产者、实际证据及不能签的范围。不得在未交接时修改E的采集/通知writer或B的材料实现；共享接缝由A、共享装配由Q整合。W接已有管理API，不应成为C原生验收前置。
