# CONT-11 — 保护策略与逐职责操作合同

**状态：Partial implementation。材料/操作纯合同、安全意图、一次 claim、unknown 对账、runtime.continuity 配置及有限生命周期/保护/关系记录已接入；完整逐职责效果约束、多代收口和安全墓碑退役仍未实现，字段存在不证明所有消费者已采用。**

配置以 [实际 schema](../../packages/runtime-kernel/src/internal/config/schema.ts)及 [protection 规则](../../packages/runtime-kernel/src/internal/continuity/protection.ts)为准，工作流持久化见 [原 owner](../../packages/box-runtime/src/internal/io/continuity-workflows.node.ts)。新增限定证明见 [生命周期报告](../reports/2026-09-19-continuity-lifecycle-integration.md)；现役和完整默认自动化不从源码接线推导。

合同：[S13策略](../roadmap/box-runtime-impl-spec.md#continuity-policy-evidence)与[全程里程碑](../roadmap/box-runtime-impl-spec.md#continuity-delivery)。

## 已实现的安全记录入口

CONT私有管理SQLite保存内容绑定的operation、policy revision、snapshot引用与effect ID。prepare不派发；claim在返回唯一的本地派发标志前持久化effect_unknown，重复调用或新进程不再获得第二次claim。只有显式结算材料才能变为succeeded/not_executed，未知不因时间、换请求ID或诊断GC而消失；真实外部权限和副作用由相应原生/控制 owner 单独核验，回执始终不授予执行权限。

最低安全记录容量不足拒绝新增操作；当前安全墓碑尚未取得语义退役资格，保留最小记录并报告blocked，不宣称无限请求/长期日用已闭合。真实CONT恢复与安全owner共用本域DB，OBS诊断库只接事件与证据引用。[实现/进程崩溃/J1接线报告](../reports/2026-09-18-continuity-recovery-store.md)固定早期存储切片的证明；不代替配置授权、职责冲突/继任generation、原生效果或独立review。

## 目标与依赖

将best-effort恢复、唯一当前上下文、边接活边交接实现为明确规则。依赖现有config、ownership及OBS/Template Ops合同，不依赖下游clone实现。指定告警和排障Bot的配置由既有owner维护，本票仅消费其接口。

## 模块与规则

`runtime-kernel/src/internal/continuity/`拥有纯策略和operation/duty/retirement类型；现有config writer负责配置变更及版本；`io/continuity-store.node.ts`负责管理记录。

策略分开控制保护范围、材料档位、替身创建和激活、Routine暂停及迁移、关系交接、退役窗口、费用与次数。新保护默认resume档、确认接管后暂停Routine；允许关闭暂停。提高保全档位不扩大自动操作范围，既有off不被升级改掉。

best-effort是默认：材料缺口不要求逐字恢复；执行结果未知则只阻断相关职责。记录创建、初始化、激活、职责接手、关系迁移、旧入站和退役的独立状态。revision/generation是管理版本，不是多会话。

每步保存配置版本、观察来源、目标、操作ID、尝试结果和读回。程序只能在已配置范围内推进，不能从名称、标题或模型回答推导额外能力。当前事实不因旧操作迟到而被覆盖。

## 验收出口

实现时新增策略和真实管理SQLite测试：配置组合、暂停false、best-effort降级、部分职责接管、同操作恢复不多建、撤销、迟到回执、多代交接和创建限额。配置迁移及消费者版本单独验证；预期由独立用例定义，不用被测函数生成预期。

source、packed和实际运行分别取证。入口随实现注册，现场状态只看[唯一索引](LIVE-integration-validation.md#live-ownership-continuity)。

## 非目标

不做多会话、跨机器、第二运行内核或另一套告警配置。不要求先实现全部高级规则才推进后续纵切。
