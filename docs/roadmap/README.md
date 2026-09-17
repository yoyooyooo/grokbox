# Roadmap：当前施工、未来方向与历史分开

本项目沿用既有位置：本目录中的`box-runtime-impl-spec.md`是已接受的实施规格，`box-runtime-plan.md`是策略背景；不是每份roadmap都代表待办或运行事实。源码/测试说明实现，Ticket记录关闭证据，[readiness](../maintainers/t32-live-enable-readiness.md)唯一记录实际候选与发布结果。

## 现在围绕什么推进

| 入口 | 拥有的内容 |
|---|---|
| [当前Spec](box-runtime-impl-spec.md#stable-delivery) | Server归属优先、Host-only、原生可逆选模与V01–V30；S0.1.4为持续观测/SQLite/incident合同 |
| [Ticket索引](../tickets/README.md) | T37准入→T38身份写入→T24可逆选择→T39原生旅程→T40放行；T41在T37事实后并行，不等Web UI |
| [策略plan](box-runtime-plan.md) | 保留Phases 0–4与架构理由；当前顺序链接Spec，不另记一套完成状态 |
| [T41观测与告警](../tickets/T41-continuous-observation-and-alerting.md) | 浏览器前的共享采集、单盒SQLite、incident/通知及失败边界；不是新执行平台 |
| [HSO升级识别](host-seam-ops-recognition.md) | 保留已有provenance/profile工具依赖的专题合同；未实现扩展不是当前默认主线，observe不等于自动adopt |

T29自有Web UI确定会做，但前端仍未排期；实际Grok Bot.app不修改。持续观测、安全准入、真实App/Working与原生状态往返不能被“UI以后做”一并延期。

## 当前新增规划：默认本地上下文维护

[主Spec S12](box-runtime-impl-spec.md#context-maintenance) / [CTX-01–CTX-04](../tickets/README.md#context-maintenance)固定旧失败会话下一条普通输入自动维护、本地工作窗口、预算计量、Host root安全点、有界摘要与持久续聊。采用[Pi固定参考](../maintainers/pi-compaction-reference.md)的成熟行为，不引入Pi Agent loop或第二会话store。新实现仍planned；T32/T35作为已有恢复/寿命基础被复用，基础proactive不再后移，后台预生成/更多模型可后续优化。

## 新专项施工：Template Bot 运维闭环

[Template Ops Spec](template-ops-automation-spec.md) / [T43–T56](../tickets/README.md#template-ops-automation)按 Spec-first 推进；2026-09-17 补充 user 默认轻量监测/短提醒、maintainer 手动配置、用户预览确认后 issue、通用 Agent/Routine CLI 与真实 HTTP E2E。基础支持可先上线，深诊断与低风险维护各自 opt-in/验收。不是已实现/已部署声明；HSO/T41/唯一 controller 各守事实 owner。[初始决策](../decisions/2026-09-16-template-ops-automation.md)限定维护授权，[补充决策](../decisions/2026-09-17-ops-defaults-support-and-routines.md)限定默认/公开发布，[维护手册](../maintainers/template-ops-automation.md)拥有配置/操作解释。

[同日多目标/授权发布修订](../decisions/2026-09-17-ops-routing-and-authorized-issues.md)由 T54–T56 落地：默认单命名目标、用户自建 custom Bot、按处理意图等有限规则分流；明确模型/数据/故障域/总成本，内置 Node REST 提 issue 并单独支持有限摘要 grant。模板不是唯一接收者，维护者预设不默认开发布/诊断/维护。专项路径不变，不复制第二份总 Spec。

## 配置底座同轮收口：AH-99 / AH-100

[统一配置重建 Spec](configuration-rebuild-spec.md) / [T57–T60](../tickets/README.md#configuration-rebuild)以破坏重建方式统一人读 config/models、client/Box 作用域、schema/writer 与迁移。ops 偏好不先落第三文件，公开命令收为 config/models/ops；真实配对与权限仍是机器状态。T51/T54 的纯规则、T43/T53 的原生任务可并行，production config 接线依统一底座。[决策](../decisions/2026-09-17-unified-configuration-rebuild.md)记录对旧冻结评论的取舍。配置底座现已实现，当前命令与证明见[配置指南](../configuration.md)及T57–T60；ops业务仍planned。CTX的schema3扩展另在主Spec S12规划，不把它当作当前schema2已支持。

## Future：以后做的能力

[future/README.md](future/README.md)是未排期范围的唯一目录，按能力命名，不按阶段/date/final-v2复制方案。包含：

- 单盒Web UI；多盒与盒外失联监测；高级通知与长期保留。
- daemon多客户端/通用流；额外环境与tailnet兼容；受控凭据发现；quota新来源。

每页声明已接受方向还是候选、晋升条件、当前owner、验收与非目标。晋升后把合同写回当前home、挂同一Ticket序列；future页只保留剩余内容，不成为第二progress表。

## History：不再执行的旧指令

[报告入口](../reports/README.md) / [Managed Compact演变](../reports/2026-09-12-managed-compact-evolution.md)保存仍解释现状的背景。旧owner brief与technical path已缩为跳转；旧[handoff](2026-09-12-orchestrator-handoff.md)仍以历史身份留存，缩减编辑未成功，不沿用其中旧权限/运行代/test2角色。

`2026-09-08-box-runtime-next.md`及已搬往future的4个旧主题文件仅为旧链接兼容路由，不持有内容。新链接直接指向真实home；旧路由只有入链/外部书签仍需要时保留，获得安全删除能力并完成引用核对后可退场。没有为追求目录整齐删除Git历史或未提交内容。

## 文档治理规则

[Product](../product-contract.md)拥有产品承诺，[Architecture](../architecture.md)拥有边界，[Upstream](../upstream-integration.md)拥有最小兼容事实；Spec/Ticket不以假命令或mock成功冒充已实现。临时收据、私有dump和账号数据不进入公开roadmap。当前项目不为统一模板而重命名全部docs根；`maintainers/decisions/tickets`等既有角色保留。

新增/移动必须同时修真实入链、相对路径、必要锚点和新鲜度；合并重复解释，降低旧假设，保留有价值证据引用。不能只加“历史”横幅却继续把旧稿列入当前施工入口。新日期不代表更高权威；未来项存在也不代表已获部署或费用授权。

失效时复核：身份/权限/模型/Host ABI、配置/通知数据写入owner、观测scope/cursor、服务生命周期或产品优先级变化；不复制一个新roadmap文件替代修正原home。
