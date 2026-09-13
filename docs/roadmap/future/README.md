# Future：未排期产品面与扩展候选

这里只保存**未来要做或值得调查的能力**，不保存当前进度、生产回执或待处理事故。Web UI是已接受方向但前端暂缓；其他候选须满足各自晋升条件。进入本目录不代表已经获实现/部署权限。

| 主题 | 状态 / 何时晋升 | 当前owner，不在此复制 |
|---|---|---|
| [单盒Web UI](webui-console.md) | 已接受方向；共享接口成熟并显式排期，先读后按能力开放写 | T29页面/共享命令；T41观测底座 |
| [多Box与外部失联监测](fleet-observation.md) | 候选；真实多盒或盒外告警需求，先有外部owner和安全API | T40单盒服务、T41单盒状态 |
| [多渠道通知/升级/长保留](notification-escalation.md) | 候选；实际多个渠道/责任人或长期审计需求 | T41基础incident/有限通知 |
| [Daemon多客户端与通用流](daemon-access-and-streaming.md) | 候选；独立权限/撤销或至少两个已实现流族重复同合同 | architecture的现有有限daemon |
| [额外环境与tailnet兼容](box-lifecycle-and-tailnet-hardening.md) | 候选；新宿主/多handler/版本迁移造成真实压力 | T40当前环境的持久运行不延期 |
| [凭据发现](cursor-credential-discovery.md) | 候选；受支持broker/明确同意与窄权限均成立 | product-contract已有secret refs |
| [Quota新来源](quota-query.md) | 候选；确有有界授权API和源身份合同 | quota.md已有实现 |

## 进入与退出规则

近期共享事实、SQLite观测/告警不放这里：[Spec S0.1.4](../box-runtime-impl-spec.md#continuous-observation)＋[T41](../../tickets/T41-continuous-observation-and-alerting.md)已经承接。不能用“UI以后做”推迟安全准入、真实消息/Working或原生模型往返。

未来项晋升时，补明确用户场景/非目标、接口owner、安全与数据合同、可执行反例，链接现有Ticket或在同一编号序列新增；把已接受合同回写Product/Architecture/Spec，本文只保留剩余候选与路由，不再复制完成状态。已过时内容合并/降低/删除，不建立v2/final/new等并行草案。

历史事实进入[reports](../../reports/README.md)，不是future。当前路线从[roadmap入口](../README.md)进入。每页维护失效条件和晋升门，不按日期数量推定优先级。
