# Roadmap：当前施工、未来方向与历史分开

本项目沿用既有位置：本目录中的`box-runtime-impl-spec.md`是已接受的实施规格，`box-runtime-plan.md`是策略背景；不是每份roadmap都代表待办或运行事实。源码/测试说明实现，Ticket记录实现、离线与review证据；[LIVE 唯一索引](../tickets/LIVE-integration-validation.md)集中记录当前现场已验/未验、阻断、下一步及固定候选/日期报告入口。roadmap不维护另一份现场进度。

## 现在围绕什么推进

| 入口 | 拥有的内容 |
|---|---|
| [当前Spec](box-runtime-impl-spec.md#stable-delivery) | Server归属优先、Host-only、原生可逆选模与V01–V30；S0.1.4为持续观测/SQLite/incident合同 |
| [Ticket索引](../tickets/README.md) | T37准入→T38身份写入→T24可逆选择→T39原生旅程→T40放行；T41在T37事实后并行，不等Web UI |
| [策略plan](box-runtime-plan.md) | 保留Phases 0–4与架构理由；当前顺序链接Spec，不另记一套完成状态 |
| [T41观测与告警](../tickets/T41-continuous-observation-and-alerting.md) | 浏览器前的共享采集、单盒SQLite、incident/通知及失败边界；不是新执行平台 |
| [HSO升级识别](host-seam-ops-recognition.md) | 保留已有provenance/profile工具依赖的专题合同；未实现扩展不是当前默认主线，observe不等于自动adopt |

T29自有Web UI确定会做，但前端仍未排期；实际Grok Bot.app不修改。持续观测、安全准入、真实App/Working与原生状态往返不能被“UI以后做”一并延期。

## 当前已实现主链：默认本地上下文维护

[主Spec S12](box-runtime-impl-spec.md#context-maintenance) / [CTX-00–CTX-04](../tickets/README.md#context-maintenance)固定旧失败会话下一条普通输入自动维护、本地预算、Host安全点及持久续聊。先通过[CTX-00](../tickets/CTX-00-pi-compaction-reuse.md)验证实际Pi core公共组件→最小补丁→受控提取，局部重写最后考虑；不是只参考思想再自研。入口/序列化/请求/Node证据归[Pi参考](../maintainers/pi-compaction-reference.md#core-package-reuse)，不引入Agent loop或第二会话store。T32/T35安全基础复用；当前已选择受控Pi提取并实现默认Box主链、config3/wire8及操作入口。实际source/Node制品/原生隔离和未完成独立review见[离线报告](../reports/2026-09-17-context-maintenance-offline.md)，现役加载/新输入/重启进度只在LIVE。

[PI-AI-01](../tickets/PI-AI-01-model-backend-qualification.md)独立评估pi-ai替换ModelBackend后的传输实现，不等于T30的RPC也不阻塞CTX。未经采纳决定，生产仍使用AI SDK；Node最低版本/Provider通道/credential不随规划静默改变。

## 新专项施工：原生 Bot 运维、固定证据与有界存储

[Template Ops Spec](template-ops-automation-spec.md)是唯一合同；[OBS-00–06](../tickets/README.md#incident-evidence)补最低证据、未知/无STEP故障入口、快照/脱敏及容量与安全退役。[T43–T56](../tickets/README.md#template-ops-automation)复用原生Routine、目标与可靠投递。首发固定现场后通知一个配置Bot，默认只提醒；用户委托后自主排障/管理/换模，自动维护另有权限和资格。

[2026-09-18决策](../decisions/2026-09-18-observable-native-bot-ops.md)将自动Issue退出本阶段，T52/T56延期，未来只保留用户决定后的gh路径。先做OBS合同与配置、原生任务，再并行证据/有界存储/最小通知；完整首发必须验收容量稳态，不等待高级路由或维护。当前是规划，不代表已部署，操作解释见[手册](../maintainers/template-ops-automation.md)。

## 配置底座同轮收口：AH-99 / AH-100

[统一配置重建 Spec](configuration-rebuild-spec.md) / [T57–T60](../tickets/README.md#configuration-rebuild)以破坏重建方式统一人读 config/models、client/Box 作用域、schema/writer 与迁移。ops 偏好不先落第三文件，公开命令收为 config/models/ops；真实配对与权限仍是机器状态。T51/T54 的纯规则、T43/T53 的原生任务可并行，production config 接线依统一底座。[决策](../decisions/2026-09-17-unified-configuration-rebuild.md)记录对旧冻结评论的取舍。配置底座现已实现，当前命令与证明见[配置指南](../configuration.md)及T57–T60；ops业务仍planned。当前源码已包含CTX的schema3扩展；本轮ops/storage下一不兼容版本由T51在实施时统一分配，不能将其当作当前schema3已支持。

## Future：以后做的能力

[future/README.md](future/README.md)是未排期范围的唯一目录，按能力命名，不按阶段/date/final-v2复制方案。包含：

- 单盒Web UI；多盒与盒外失联监测；尚未排期的外部渠道与长期归档。当前已接受的Bot通知和有界保留由上面的专项Spec拥有。
- daemon多客户端/通用流；额外环境与tailnet兼容；受控凭据发现；quota新来源。

每页声明已接受方向还是候选、晋升条件、当前owner、验收与非目标。晋升后把合同写回当前home、挂同一Ticket序列；future页只保留剩余内容，不成为第二progress表。

## History：不再执行的旧指令

[报告入口](../reports/README.md) / [Managed Compact演变](../reports/2026-09-12-managed-compact-evolution.md)保存仍解释现状的背景。旧owner brief与technical path已缩为跳转；旧[handoff](2026-09-12-orchestrator-handoff.md)仍以历史身份留存，缩减编辑未成功，不沿用其中旧权限/运行代/test2角色。

`2026-09-08-box-runtime-next.md`及已搬往future的4个旧主题文件仅为旧链接兼容路由，不持有内容。新链接直接指向真实home；旧路由只有入链/外部书签仍需要时保留，获得安全删除能力并完成引用核对后可退场。没有为追求目录整齐删除Git历史或未提交内容。

## 文档治理规则

[Product](../product-contract.md)拥有产品承诺，[Architecture](../architecture.md)拥有边界，[Upstream](../upstream-integration.md)拥有最小兼容事实；Spec/Ticket不以假命令或mock成功冒充已实现。临时收据、私有dump和账号数据不进入公开roadmap。当前项目不为统一模板而重命名全部docs根；`maintainers/decisions/tickets`等既有角色保留。

新增/移动必须同时修真实入链、相对路径、必要锚点和新鲜度；合并重复解释，降低旧假设，保留有价值证据引用。不能只加“历史”横幅却继续把旧稿列入当前施工入口。新日期不代表更高权威；未来项存在也不代表已获部署或费用授权。

失效时复核：身份/权限/模型/Host ABI、配置/通知数据写入owner、观测scope/cursor、服务生命周期或产品优先级变化；不复制一个新roadmap文件替代修正原home。
