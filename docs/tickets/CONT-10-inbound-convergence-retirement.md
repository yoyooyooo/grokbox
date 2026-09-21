# CONT-10 — 旧入站收敛、持续交接与安全退役

**状态：Partial implementation。旧入站观察、关系进度、quiet/gap 判定及显式 retirement 入口已接线；原生可靠条件删除/入站排空能力缺失，自动删除保持阻断。多代收口、资源独立与安全墓碑退役仍未完成，新 Bot 已接活不代表本票关闭。**

实现见 [convergence 程序](../../packages/box-runtime/src/internal/roots/bot-convergence.runtime.ts)、[原生读取/删除前边界](../../packages/box-runtime/src/internal/roots/continuity-native-convergence.runtime.ts)；限定证明见 [生命周期报告](../reports/2026-09-19-continuity-lifecycle-integration.md)，操作见 [指南](../maintainers/bot-lifecycle.md)。缺少可靠屏障不能用安静期、人工 hash 或普通 delete 绕过。

合同：[S13交接与退役](../roadmap/box-runtime-impl-spec.md#continuity-handover)。依赖CONT-04/09、CONT-01观测和CONT-11策略；消费OBS的cursor/gap/容量能力，不另建黑盒轮询器。

## 目标与模块

交接期间持续观察旧Bot的DM、群聊与外部结果，处理新发现的旧入口；趋零后在可证明条件下退役原身份。`monitor`及关系reader提供来源与coverage，`continuity-store`保存进度/依赖/安静窗口/墓碑，runtime按政策提出和执行退役；原生删除仍走正式有界接口。

## 当前管理与原操作恢复

`bot handover observe/retire`使用统一Server、原CONT入站水位与retirement guard，旧CLI/适配兼容入口已退出。observe保留有界原生事实但不执行原生写入；retire消费同主体原observation引用，显式授权与自动策略分别核验，不把人工确认偷换成automaticDelete开关。缺源资源独立性或原生删除屏障时保持blocked。

`operation reconcile --domain handover`对退役只运行原convergence的无native-port对账程序：准确的原持久删除回执可以完成本地phase结算；缺失、prepared、unknown记录不能重新观察出一个删除机会或再发delete。历史GET不依赖原生可用性，外层管理回执完成不证明全部职责完成。固定实现与隔离验证见[管理交接报告](../reports/2026-09-21-handover-management.md)。

## 收敛与计时

只计算真实新入站；历史引用、重复事件、controller自检与旧Bot自己的指路消息不算新业务。每个source有cursor/last successful read，gap/服务端不可见/采样失败不算安静；恢复后补齐连续区间或重开安静计时。不是看App Working或搜索旧名字决定归零。

新关系/未处理输入进入CONT-09逐项交接，新Bot已接职责不暂停。旧任务结果按原ID收尾，不重派；无法分类的输入保留并告警。报表同时显示最近流量、监控覆盖、未结任务和下一步，不承诺长期引用必然自动消失。

## 退役条件

最短保留期、连续健康观察的安静期、Routine/监听/回调与任务依赖清零、输入已处置、新Bot仍可用、目标资源不依赖待删除源、有效删除授权全部成立。建议7天/72小时策略初值可调，期限不是强删倒计时；unknown/gap/新活动使删除保持blocked并提醒。

删除前复核水位和活动，能取得原生撤销入口/排空能力就使用并取证。没有可靠屏障或覆盖不充分时不自动删除，保留旧对象并说明，不能以连续两次空读伪称原子安全。删除丢回执先读回，不再对其他ID执行；源目录GC不能破坏目标blob/附件。

多代交接统一解析current successor，旧A和B均指向当前C，不能形成循环；grace中的旧代不阻止受限的新候选创建。最小旧ID映射、操作回执和必要未结记录有界保留；原始历史按材料策略，安全记录不随普通日志轮转。

## 验收出口

新增虚拟时钟/真实管理DB与独立进程用例：新旧事件区分、重复和乱序、失联不计quiet、恢复补采、窗口临界新入站、周期间隔回调、旧Routine保留、所有未结类别、删除前竞态、unknown删除结果及源资源独立性。坏变体“到TTL就删”“空列表视为无任务”“旧代覆盖继任ID”必须失败。

真实交接后持续观察及原生删除只在[LIVE-CONTINUITY-RETIREMENT](LIVE-integration-validation.md#live-continuity-retirement)登记；短时fixture不代表真实长期覆盖。

## 非目标

不以零活动替代依赖对账，不强删无法观察的Bot，不提供跨机器监控，不让旧Bot或LLM自己批准退役。无法安全自动删除时的可解释保留也是规定结果，不冒称整个退役已成功。
