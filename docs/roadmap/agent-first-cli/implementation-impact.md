# 重建骨架与端到端工作链路

状态：W3 实施收束中，多个管理领域已接通，当前差额见 [CLI-05](../../tickets/CLI-05-implementation-follow-through.md)。完整交付仍覆盖统一后台、必要能力重建、Web UI 与最终安装验收；2026-09-22 排程校准为运行核心先通过完整质量/范围验收并日用，其余能力并行完成。本页固定责任骨架和 W1–W5，[并行交付拓扑](parallel-delivery.md)固定路线、阻塞边及核心/完整两次汇聚；产品语义与数据边界唯一见 [Spec](spec.md)。

## 责任骨架

| 边界 | 拥有的责任 |
| --- | --- |
| CLI 与 Web 应用 | 分别处理机器调用和页面体验；Web 使用 TanStack Start，SSR 仅预取/渲染 |
| 共享合同与客户端 | 目标、输入输出、错误、操作回执、事件的共同语义；不复制领域规则 |
| Effect-first 管理服务 | API 与内部领域模块；模型管理、保护交接、观察检索、材料管理、异常通知的用例与规则 |
| 原生与存储适配 | Gateway、Host、文件和数据库的实际能力与故障转换；不向页面泄漏内部协议或凭据 |
| 独立 modeld | 模型执行与独立进程寿命；管理服务停止不主动终止已开始的合法执行 |

Web 不通过 CLI 子进程办业务。页面聚合查询可以独立，写用例必须共享。命令树不是模块树；只有真实职责、资源、故障或寿命边界才成为拆包/拆进程的理由。当前模块形状不限制重建，也不为目录对称创建空包。

## 现有能力的关联

| 影响 | 已确认目标产生的压力 | 现有来源与关联 | 仍需收口 |
| --- | --- | --- | --- |
| I01 命令发现与输入输出 | Agent 可发现、组合基础能力，不内置业务分工策略 | [registry](../../../packages/cli/src/registry.ts)、CLI parser/help/operator Skill；[共享客户端](../../../packages/client/src/client.ts) | D01–D03、D06；命令族、引用和机器合同 |
| I02 统一后台入口 | 普通业务经一个管理服务，bootstrap/离线诊断/外部 Box 控制有明确例外 | [管理 Server](../../../packages/server/src/server.ts)、待迁移的 [daemon host](../../../packages/cli/src/daemon/host.ts)、[T29](../../tickets/T29-runtime-webui.md)；保留真实可用的远程意图 | D08；故障期间回执定位与消费者迁移 |
| I03 常驻模块/worker | 采集、管理异常、保护、交接、启用后的通知由后台推进，各有故障/资源边界 | [monitor root](../../../packages/box-runtime/src/internal/roots/monitor.runtime.ts)、现有通知/保护 worker、[T41](../../tickets/T41-continuous-observation-and-alerting.md) | D07–D08；唯一 writer 接管、关闭、恢复与通知首装 |
| I04 领域操作与恢复 | 真实 Bot 前后继关联、默认保护、证据决定自动化范围；提交/回执/在途事实分开 | CONT、配置、通知、Job 账本；[continuity](../../runtime/continuity.md)、[operations](../../runtime/operations.md) | D04–D05；幂等、unknown、并发与领域回执，不建立独立人格身份或通用任务系统 |
| I05 持久观察读面 | 必要快照、变化和证据可追溯，CLI/Web 共用来源/新鲜度/缺口语义 | Gateway adapter、[daemon events](../../../packages/cli/src/daemon/events.ts)、redaction、T41；[研究记录](../../reports/2026-09-19-webui-source-feasibility.md) | D07；采集资格、游标、保留范围和缺口恢复 |
| I06 Memory/Project/文件 | 跨授权来源检索；索引可重建；源数据写入按实际能力核验 | 受控文件 adapter、原生存储与共享 Memory 同步；[DATA-01](../../tickets/DATA-01-memory-project-files.md)承接领域实施，不把此责任留给页面 | D03、D09；scope、源 owner、并发、写结果与索引新鲜度 |
| I07 modeld、模型选择与生命周期 | modeld 独立；原生/跟随默认/指定模型分开，配置更新在后续轮次采用 | [modeld root](../../../packages/box-runtime/src/internal/roots/modeld.runtime.ts)、[T40](../../tickets/T40-persistent-release-and-rollback.md)、模型选择与原 Host controller | D01、D05、D08；选择迁移、无默认/删除引用、每轮版本、drain 与启动回执 |
| I08 apps 与 Web UI | TanStack Start SSR + 独立 Effect-first API；功能与工程先行，视觉定稿后置 | Web 位于 apps 子项目；[WEB-02](../../tickets/WEB-02-web-foundation.md)承接工程基础，[WEB-03](../../tickets/WEB-03-functional-prototype.md)承接信息架构与真实功能页面 | T29 拥有共享 API、并发和浏览器总责；WEB-01 只拥有视觉参考和后续定稿 |
| I09 破坏式切换 | 最终一次性采用；中间版本可不完整/不可用，不建迁移期双轨或零停机层 | [固定基线映射](migration-map.md)、安装文档、Skill、脚本、测试与打包入口 | CLI-04 定合同，CLI-05 验证原生数据接入、必要配置导入、投影重建与旧入口/writer 退出 |

这些来源说明已有实现的关联，不证明新架构已交付，也不保证旧限制合理。细化时逐一判定复用、移动、重写或删除，不能另建同名实现后留下旧 writer。

各领域保留自己的事实权威。观察存储不接管模型配置、执行记录、Host 原生状态或 CONT 私有恢复材料；派生视图/索引与不可凭空重建的历史、回执分别管理。Effect 管服务内部资源，supervisor 管进程寿命，Host/preload 原生适配继续轻量。

## 工作链路与责任

| 工作段 | 结果与主要责任 |
| --- | --- |
| W1 命令合同 | CLI-01～CLI-04 固定 Agent 可发现的能力、目标、结果与旧意图去向；精确工程细节采用合理默认解 |
| W2 统一骨架 | CLI-05/T29 重组服务与领域，WEB-02 同时建立 Web 工程、身份/请求和路由基础；以真实 Bot 查询和模型选择验证两个消费者、并发与 modeld 独立寿命，及早核验目标宿主 |
| W3 能力与并行交付 | 按拓扑 A/R/F/E/D1 先汇聚运行核心候选，完成真实模型/原版App/持久化/恢复/持续运行及用户核心范围验收后到 J4 日用；B/C/D2/E2/F2与WEB-03并行继续，CLI-05组织旧writer退出 |
| W4 完整功能候选与集中 E2E | J5汇聚全部W3义务后，固定全产品候选做适用整体检查/独立审查及完整LIVE；运行核心已验证依赖按变化复验，不自动继承，也不无条件重做所有无关场景 |
| W5 全产品用户验收与最终呈现 | 用户验收完整产品；不再作为此前运行核心日用的阻塞。WEB-01定稿后补视觉/体验，命令文档与Skill同步；正式发布另行决定 |

这些是依赖关系，不是五次公开发布。J2允许受控切Host/modeld进行工程验收，J3证明核心工程通过，J4才由用户接受并日用；自有Web可后置，原版App不可混入后置范围。具备用例合同的独立工作可推进，不要求全部字段先一次性定完，也不要求每次中间提交都能供用户使用。及早接通真实用例用于验证责任边界；不得以长期 mock 页面、仅改 CLI 名字或保留重复业务 owner 代替完成。

开发期针对变化验证，不反复做旧版本采用/回退和完整模型矩阵。运行核心和全产品各在冻结候选时收口适用整体检查/独立审查；高风险原生能力、来源写入和目标宿主提前核验。核心仍保留真实模型矩阵、必要保全和至少24小时持续运行，不以用户日常试用补证据。局部报告不签整个系统可用，CLI-05的施工拓扑与[LIVE的核心集合及E0–E6](../../tickets/LIVE-integration-validation.md#core-runtime-lane)分别拥有排程和验收。

需要提前固定的是稳定对象/来源引用、能力覆盖、共享用例与权限边界、操作恢复、事实/索引/历史归属和资源寿命。前端 URL 拥有导航与可恢复筛选，查询缓存拥有远端投影，本地状态拥有草稿，订阅拥有接续/去重/gap；SSR 请求与浏览器各自拥有缓存和会话，不重复创建后台工作。具体包名、组件库、表结构和视觉参数不在此预设。

T29/T41/CONT 等来源票继续拥有各自实现差额；[CLI-05](../../tickets/CLI-05-implementation-follow-through.md)拥有跨域集成和最终收束。实施前依据实际差额补充必要的可执行子票，不按目录平均拆票，也不重做已有且仍符合目标的能力。本页不改变历史验收记录；源码进展由 CLI-05 维护，现场采用仍需独立授权。

## 最终完成条件

- Agent 从能力发现、明确目标到操作回执与异常恢复走通；CLI 与 Web 的共同操作进入同一领域用例。
- Bot 状态/活动/日志与全局 Memory、Project 文件有真实来源、覆盖和缺口；受支持写操作经过源 owner 并验证结果。
- 模型选择、默认保护、证据约束的交接、管理异常和启用后的通知在无页面/调用者常驻时按已接受职责工作；未知能力不伪装完成。
- 新 CLI、服务、modeld、Web UI 和官方 Host 的职责及寿命符合骨架；必要旧能力有去向，旧语法和重复 writer 退出。
- 官方数据及身份继续接入，必要配置按需导入；开发期内部历史不承诺迁入，重建索引不补造历史。
- 可安装和启动完整版本，真实 CLI、原生往返与浏览器故事按所声明范围验证；离线、浏览器与现场证据分开，现场结果仍只进入 LIVE 索引。
