# E · 运行观察、必要保护、投递与安全维护

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-observation-delivery`，从当前v2切出。E1保障核心日用；E2完成全产品观察/投递义务。

## 目标与先读入口

无页面/CLI常驻时，核心故障、失权、保全、unknown与资源压力仍可追溯；已启用的自动动作有真实资格，未启用零外发。先读[T41](../../../tickets/T41-continuous-observation-and-alerting.md)、[T45通知](../../../tickets/T45-template-webhook-delivery.md)、[OBS-04](../../../tickets/OBS-04-bounded-observation-storage.md)、[OBS-05](../../../tickets/OBS-05-safe-state-retirement.md)、[CONT-01](../../../tickets/CONT-01-ownership-loss-notification.md)和[核心LIVE集合](../../../tickets/LIVE-integration-validation.md#core-runtime-lane)。

## owner与模块

原`internal/roots/monitor-service.runtime.ts`、通知/保护service装配、`internal/io/monitor-*.node.ts`、notification-outbox/receiver、共享观察/异常领域和本域安全维护。E拥有采样/事件/incident/outbox语义，不拥有Host变换、模型执行准入或CONT材料/工作流写入。

R/D交付真实执行/原生事件关联；A交付安装级Host健康。E把它们接回原OBS，不能自己再判另一套ownership或重建transcript/run事实库。C拥有CONT恢复/引用/职责算法；核心必要保全涉及C的底层缺陷，由C修原owner，不由E复制。F只接服务生命周期。

## 分阶段出口

| 出口 | 依赖与并行范围 | 必须交付 |
| --- | --- | --- |
| **E1 核心运行闭环** | J0可做本地存储/权限/故障隔离；原生资格消费A1/D1，宿主消费F1 | 请求→TURN/STEP→故障/副作用/原回执可关联；缺源/陈旧/检测器退出不假健康；默认观察/必要材料保全和失权处理符合策略；未知不重放；采集/索引/通知故障不带倒合法执行；实际启动worker与有效配置清单、未验副作用隔离、容量/维护/关闭结算。交J2及J3真实验收 |
| **E2 完整观察与投递** | E1后继续，消费A/D新增事实；不等待W | 原生alert/evidence与公共读面、确定未受理的有限退避、上游对账、合格接收者与故障域之外的授权出口、长期保留/计量/撤销及当前全部消费者。交J5 |

E1不能靠关闭全部保护/诊断制造可运行。已生效策略会触发未验的替身/退役、通知或桌面效果时，要由原owner明确隔离并验证，不能悄悄降低用户已有保护。核心使用的实际外发通路必须验收；未启用通知的local-only要明确，不宣称用户已被提醒。同Host上的接收Bot不等于Host失效时有独立告警，不能为送达放宽模型/ownership门。

完整C交接/退役不作E1前置；若当前必要保全本身无法成立，只把具体材料/捕获依赖交B/C并阻断E1相应出口，不能排除数据安全。

## 验证与回流

现有入口包括`test/observation-management.test.ts`、`test/incident-actions.test.ts`、`test/notification-management.test.ts`、`test/notification-setup.test.ts`、`test/protection-management.test.ts`及原monitor/outbox/CONT引用交叉回归。覆盖真实SQLite/文件/进程、坏库与恢复、迟到/撤权、持久接续、COMMIT丢回执、有限容量、取消/关闭和不重发。

本地HTTP接收端不是实际Bot收到，生产Chrome不是原版App，24小时计划不是实际时长。Q统一现场窗口，E提供事件/故障/资源及至少三个维护周期的实际证据；持续运行按手册执行。

不要新建通用GC、operation数据库或第二poller；各领域安全标记由原准入/恢复owner证明可退役后维护，不按诊断TTL删unknown。E1先阶段性回流，E2的完整通知产品不阻已合格核心；安全关键失败不可作为普通残余后置。


### E1 固定核心观察入口（2026-09-23）

核心候选采用前的观察/保全固定入口为 [E1 固定报告](../../../reports/2026-09-23-core-observation-safety.md) 与 `node scripts/verify-host-health.mjs core-observation`。该入口固定执行关联、Host 健康、monitor、protection、notification、容量维护和管理边界的 evidence 文件集合；需要显式 current native Host/continuity/Node 输入。它不宣称真实外部通知已送达、真实 App 已观察或 24 小时现场运行已完成，这些仍归 J2/J3/LIVE。
