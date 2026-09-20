# CLI-05 · 架构重建与 Web UI 端到端收束

状态：实施中；共享管理 Server/客户端、模型 CLI/Web、生产 Web、观察/异常/订阅、通知授权/独立测试及首次配置/Routine/配对已接通；材料、保护交接、其余后台/命令收束、完整安装与最终交付尚未完成。前置合同由 [CLI-01](CLI-01-discovery-and-targeting.md)、[CLI-02](CLI-02-operation-contract.md)、[CLI-03](CLI-03-observation-and-wait.md)、[CLI-04](CLI-04-command-cutover.md)提供；实施可按已闭合用例推进，不机械等待全部文档字段。

## 用户结果

用户一次性采用完整新版：Agent-first CLI、统一后台、独立 modeld、必要的原生能力和 Web UI 一起可用。命令收束反推实现与架构重建，最终只有一套正式命令和领域规则。开发中允许中间版本不完整或不可用，不建设迁移期零停机、双轨或临时兼容层。

## 本票责任

[Spec](../roadmap/agent-first-cli/spec.md)拥有产品与数据兼容边界，[重建骨架](../roadmap/agent-first-cli/implementation-impact.md)拥有 W1–W5 工作链路和 I01–I09 关联。本票从原先的实现占位改为跨域集成与最终收束来源票：

- 按实际能力盘点复用、移动、重写、删除和上游资格差额；既有结构不是重建约束。
- 组织共享合同/客户端、管理服务领域模块、原生/存储适配及独立进程的责任切割，退出 CLI 内重复业务规则和重复 writer。
- 将现有必要能力迁入最终骨架，更新脚本、Skill、打包、文档及已知消费者。
- 接通 Web 工程与真实功能原型、安装和服务生命周期；视觉定稿独立推进，验证完整故事和一次性采用的数据边界。
- 按新接受目标重定 LIVE、执行手册、验证工具及消费者路由；旧 E2E 不是重建前置，旧窗口/审查只支持其原内容，适用结论须重新核对。

具体包名、目录、数据库 schema、HTTP 路由及 UI 组件由实施者决定。不以先建空壳或通用 operation 数据库作为起点；用真实查询/操作及故障场景验证边界。可以及早接通 Bot 查询和模型选择，但这不是需要用户提前试用的独立版本。

## 与来源票的关系

| 来源票 | 保留的责任 |
| --- | --- |
| [T29](T29-runtime-webui.md) | CLI/API 共享入口、真实并发保护、浏览器与访问边界 |
| [T41](T41-continuous-observation-and-alerting.md) | 持续观察、来源/游标/缺口、incident 与相关存储差额 |
| [HOST-01](HOST-01-patch-health-verifier.md) | 当前 Host 依赖风险、Rust/Oxc 静态验证与健康链集成；HCR/T44/OBS 保持各自 owner |
| [CONT](README.md#ownership-continuity) | 保护材料、真实 Bot 前后继、证据支持的交接和退役 |
| [模型/执行](README.md#modeld-effect-core)、[T24](T24-runtime-route-binding.md) | 执行权威、模型关系、实际采用与原生往返 |
| [T40](T40-persistent-release-and-rollback.md) | 最终安装、服务生命周期与必要退路；不因此要求开发迁移期保持可用 |
| [DATA-01](DATA-01-memory-project-files.md) | 材料来源、检索索引和受支持源修改 |
| [WEB-02](WEB-02-web-foundation.md) / [WEB-03](WEB-03-functional-prototype.md) | Web 工程/访问安全、信息架构与真实功能页面 |
| [WEB-01](WEB-01-visual-baseline.md) | V0 参考、后续视觉定稿与体验验收 |

本票不复制这些领域的实现验收。实施前依据实际差额补充必要子票，沿用已经合格的成果，不按历史阶段重做。新差额必须有来源票，不能以“仍待拆票”永久留在占位。

## 验收

1. CLI 与 Web 共用合同和后台领域用例；Web 不执行 CLI 子进程，不另写模型/保护/数据修改规则。
2. 常驻管理服务承载已接受的后台职责，modeld 独立；网页关闭和客户端退出不停止后台管理工作，故障恢复入口符合明确例外。
3. 必要旧能力、已知消费者、正式入口及 writer 都有去向与验证；最终不保留两套正式合同。
4. 官方 Bot、Memory、Project、原始文件及身份继续接入，模型/连接配置按需一次性转换；投影与索引可重建。旧开发期数据库、历史日志/回执/测试状态不承诺导入，不为此建立通用历史版本迁移框架。
5. 不把兼容范围解释成自动清理授权。识别实际在途或未知外部效果，防止重新接入导致重复执行；新版必要回执、保护材料与历史仍受各领域合同约束。
6. 按 Spec 核心故事形成完整功能候选，收口适用整体构建/回归、实际安装制品与独立审查，再集中验证原生与浏览器功能、恢复和长期运行；证据不足的必需项保留阻断，不能改成可选或用 mock 签收。视觉验收独立，不阻先完成的功能验收。
7. 用户集中验收之后才开始日常吃狗粮，正式发布另行授权。施工期可不完整/不可用，不要求每个提交发布演练；局部针对性检查及关键原生/宿主资格应及早反馈。
8. 固定报告保留原窗口；当前现场结果进入 [LIVE](LIVE-integration-validation.md)，本票记录跨域实现与验证差额。命令、apps/Server 源码与制品身份进入验证工具覆盖，构建接线随实际包结构落实。

## 当前源码进展

模型域已连接共享 API、新版 CLI 与真实 Web 消费者。`runtime-kernel` 的 [选择规则](../../packages/runtime-kernel/src/internal/selection/models.ts)支持原生、显式模型和默认跟随关系；[模型管理程序](../../packages/runtime-kernel/src/model-management.ts)提供严格输入、模型引用检查、revision 与按安装/主体/request-id 绑定的重放语义。Host/modeld 仍使用每轮捕获，不改写在途选择。

[模型回执适配](../../packages/box-runtime/src/internal/io/model-management.node.ts)复用 canonical models writer，先声明操作再写文件；已完成回执先于新的准入/revision 检查返回。仅凭安装/主体/request-id 可读取原回执，不依赖当前配置、Gateway 或原请求正文。写后回执丢失保持 unknown，不用相同内容 hash 推导历史提交、也不重放。模型读写使用受保护文件、进程身份锁和持久发布；回执容量满时拒新操作，不淘汰旧安全记录。

[管理 Server](../../packages/server/src/server.ts)以 Effect 管理 listener、请求、授权和关闭寿命；安装入口使用现有 canonical root 与 verifier，不初始化或采用 Host。授权每请求重读，凭据轮换保持原 principal，权威替换拒绝。断连不取消已准入模型提交；关闭等待其不可中断发布检查点。

[共享客户端](../../packages/client/src/client.ts)有界解析响应、绑定安装与 request-id，不重试未知写入，也不做 transport/Gateway fallback。浏览器 bundle 不含 Node、Effect、存储或 provider 实现。列表同时限制条数与 UTF-8 响应字节，保留续页；Bot 游标绑定原生代际和成员集合，字段按次刷新。名称歧义与截断身份保留不确定性，不按显示名执行写入。[CLI 消费者](../../packages/cli/src/commands/management-api.ts)已接通有界 Bot 列表/摘要、名称解析与稳定引用、模型/选择查询、显式 patch/replace 与删除引用检查、默认与逐 Bot 设置/reset、模型回执读取和 Server 前台入口。缺省固定本机，显式 connection 要有安装绑定；不读共享 current Profile 决定目标。旧 `models list/use/show/reset` 及 CLI 直写实现已退出，剩余命令族仍待迁移，不是完整 CLI 合同。

[原生读取适配](../../packages/box-runtime/src/internal/io/management-gateway.node.ts)只读取本机 Gateway 的 Bot 清单、独立所有权证据及已选通知接收者的 Routine/Host 能力；没有旧 CLI 的 daemon/远端 fallback。来源响应、字段和期限有界；未知状态保留为 unknown，错误/缺源不伪装空清单，重定向不带凭据离开本机。

验证以 [Node 集成](../../packages/server/test/server.node.ts)、[共享客户端](../../packages/client/test/client.test.ts)、模型域与 CLI 消费者测试为入口。真实 Node 子进程、loopback HTTP、文件和 Effect Scope 已覆盖认证/撤权、安装绑定、读取脱敏、并发 revision、重放、断连、写后不确定、服务重启、凭据轮换与前台入口关闭；原生与 Provider 事实仍是合成输入，不计真实六格 E2E。使用声明的 Bun runner，未修改全局 PATH。

[Web 工程与访问安全](WEB-02-web-foundation.md)已接通真实 TanStack 路由、请求隔离 SSR、固定同源桥、Console 登录与共享客户端。根 build 生成独立 `dist/web` 浏览器/SSR/Node 启动制品；正式 CLI 可前台运行 Web。生产制品复制到源码树外后，经真实 Chrome 验证模型操作、CLI 并发冲突、丢回执恢复、权限/SSR 隔离、本机测试 HTTPS 及 Web/管理服务各自重启。Node 最低版本为 22.12.0；此范围不代替目标宿主完整安装、实际外部入口和真实原生/Provider 验收。

[2026-09-19 只读来源核验](../reports/2026-09-19-live-source-qualification.md)已获单独授权，实际使用 4 次有界 HTTP 请求及目录/stat 元数据，没有正文读取、原生写入、模型请求或服务切换。该次原生列表可读，但当时 HostStatus 缺少所需 ownership 观察字段，受管执行资格仍未验证；该事实不计候选 LIVE 通过。

继续完成完整 CLI 发现/引用/输入合同、凭据管理、其他领域与 Web。模型 apply 的结构化文件/stdin 已接通；省略保留、显式清空、重复语义字段、UTF-8/大小约束仍由实际输入和共享领域规则检验。本地模型发布按本地文件读回确认，不把外部 Pi 投影的重新显现误判成一次本地写丢失。模型回执的公共只读查找已接通；有证据的 unknown 对账、精确恢复和安全保留维护仍未完成。Server 尚未承载全量 worker，也未完成独立 modeld 实执行寿命、安装、独立审查和集中 LIVE。没有切换现役服务、修改全局 shim、使用真实模型或清理原生资料。

共享客户端的[公开响应合同检查](../../packages/client/src/response-validation.ts)及[反例回归](../../packages/client/test/response-contract.test.ts)已实际复验：请求/响应的模型与 Bot 身份、选择/采用语义、分页/来源、回执范围/动作/目标/原 revision 均须匹配；异步等待期间固定输入和连接，防止恢复 request-id 漂移。修复后的 7 组反例、共享客户端和 36 个 Node 管理集成场景通过。先前工具阻断已不再是当前施工状态，不需重复补写已存在的 Web。

### 持久观察跨入口切片

[管理查询](../../packages/server/src/observations.ts)通过现有 MonitorStore 的只读子集消费原 SQLite，不建第二观察库或采集器。`system observation get`、`incident list`、`event list` 与 Web 的 `/observation`、`/incidents`、`/events` 共用 [公开 DTO](../../packages/client/src/observation-contract.ts) 和客户端。独立 `observations.read` 权限先于源读取检查；诊断正文、通知载荷、凭据和内部路径不进入公开视图。

快照保留 watched scope、来源时间、lastKnown/freshness 和同事务 cursor；记录为运行不等于进程存活。异常的 ack/snooze 不代表解决。历史与订阅均只消费已提交观察；初次读取从可接续保留边界开始，旧代/超保留期给出 gap，不补造历史。订阅窗口的实现与验证见下文。12 个真实 Node/SQLite 场景覆盖不存在/坏库不重建、权限撤回、零上游查询、文件字节/mtime/sidecar 不变、陈旧/停止、分页和保留边界，以及管理服务持有采集器的启动、互斥、关闭取消与恢复。扩展后的生产 Chrome 组合为 15 个测试节点（含父测试），验证新页面、正式 CLI 一致性和窄屏布局。

### 采集器归属迁移

管理 Server 的 Effect Scope 现已持有原有 [MonitorService](../../packages/box-runtime/src/internal/roots/monitor-service.runtime.ts) 的获得和关闭；尊重已有显式 `daemon.observation` 配置及 monitor enabled，不初始化数据库、不自动启用通知或采用 Host。配置项沿现有 canonical writer 读取，名称不再表示旧 daemon 是采集器 owner。旧 daemon 启动/关闭接线、`getMonitorService` RPC 和 `runtime monitor service` 正式命令已退出，没有增加转发兼容层。

新 `system service get server` / `/v1/service` 使用独立 `system.read` 权限，公开当前管理进程与其采集器状态；Web 将服务状态与持久观察快照分别呈现。实际 Node 管理服务测试验证：显式配置后采集 Host/control 测试日志、Scope 关闭取消慢原生读取并结算写库、再启动不重复 incident、竞争 Server 的 collector 阻断但不拖垮其 API。通知 worker 已按下文迁入同一管理寿命；保护 worker 及其余领域仍待迁移，不据此声称全后台迁入完成。真实 modeld 寿命也未由这些合成测试证明。

### 前一固定源码窗口的集成验证

以下证据只支持当时的观察读取/collector 切片，不签后续新增动作或订阅。该次扩大回归前后，`captureVerificationSource` 均为 `c853b0ab6a60ec8de9239cf723e4a483aa3dafc4742a9598b9b719855a6e94e4`，1011 个输入；范围仍为 git-visible 源码/测试/工具链，不含 docs 或已安装依赖。使用 Node 22.22.0 与声明的 Bun 1.3.14。根/Web typecheck、生产构建、25 个文件中的 210 项 Bun 测试全部通过；其中包装测试实际执行管理 Node 36、同源桥 Node 9、观察/服务生命周期 Node 12、Chrome 15 个测试节点（含父测试），这些是内部计数，不能再与 210 相加。组合还覆盖旧 daemon、runtime CLI、原 monitor 全组与 incident/notification 证据链。

[打包测试](../../test/packaging.test.ts)实际安装 tarball 到隔离前缀，核对两套等价 CLI 入口、Server/Web 内容、Web 清单中的每个文件字节/hash 与 Node 语法。生产 Web 构建显式固定 `NODE_ENV=production`，避免 Bun 测试环境带入开发 JSX；按真实制品清单升级旧 CLI-only 断言，不为保持旧清单删除新版制品。目录搬移的 Chrome 测试仍不代替操作系统服务注册或真实 Host 采用。

文档检查 15 项通过；发布扫描包含未跟踪源码，未发现问题；tracked diff 格式检查通过。工作树及未跟踪成果继续保留，未提交、未切换现役服务或全局 shim，未调用真实模型。此结果是已声明范围的源码/隔离安装/浏览器证据，不关闭完整 LIVE、独立审查或用户验收。

重跑本切片可用 `bun run test:web`；其余主要入口为 `packages/client/test`、`packages/server/test/server.test.ts`、`test/daemon.test.ts`、`test/cli.test.ts`、`test/packaging.test.ts`、`test/runtime-cli.test.ts`、`test/incident-evidence-integration.test.ts` 与 `packages/box-runtime/test/monitor-*.test.ts`。

### 异常处理、恢复与订阅接续

[异常领域入口](../../packages/server/src/incidents.ts)复用现有 SQLite management 表，将安装/主体/数据库/request-id 绑定到域内键。ack/snooze、revision 和事件在同一事务提交；已完成重放先于当前 revision、暂缓截止时间和容量检查，COMMIT 回调丢失保留 unknown。旧 `runtime monitor ack/snooze` 退出，新 `incident get/ack/snooze`、`operation get --domain incident --database-id ...` 经共享客户端；未创建跨领域 operation 数据库。Web 在提交前保留最小恢复定位，刷新后仍阻止对同一异常提交替代请求，原回执可查询，草稿/冲突与真正修复分开。

[有界事件窗口](../../packages/server/src/event-watch.ts)以同事务快照 cursor 接续，最多 8 个订阅、默认 30 秒/最多 60 秒、128 页及 4 MiB 输出；共享同 cursor 的在途数据库读取，不缓存授权。每页在异步读取前后重验权限，Node 背压等待 drain，取消只关闭本订阅。CLI 的 `event watch` 和浏览器/同源桥共用[有界解码器](../../packages/client/src/event-watch.ts)；EOF 不算完成，只有已验证 end frame 才结束窗口。浏览器正常续接窗口，传输失败最多三次只读重连，scope/权限/协议缺口需要显式处理，关页面不停止采集。

[Node 异常/订阅组合](../../test/incident-actions.test.ts)实际执行 19 个场景，覆盖过期暂缓重放、主体/数据库隔离、写后回执丢失、真实 COMMIT 回调丢失、容量、取消/撤权/换代、读取合并、慢消费者和 CLI EPIPE。真实浏览器已验证 CLI 并发冲突保留草稿、异常 unknown 刷新恢复、订阅只读重连及明确 gap。

### 通知 worker 归属迁移

管理 Server 的 Scope 已获得原有[通知 worker](../../packages/box-runtime/src/internal/roots/ops-automatic-notification.runtime.ts)，在采集器之前获得、之后关闭，继续消费原授权、outbox、预算与防重放边界。旧 daemon 的 worker 启动/关闭、状态 RPC、capability 和 `ops notifications worker` 命令已退出；不留第二自动投递 owner。新 `notification status`、`/v1/notification-worker` 及 Web `/notifications` 只投影实际 worker 的安全状态，使用独立 `notifications.read` 权限，不返回私有授权/work ID，不把等待、HTTP 受理或进程存活解释为已启用、已读或安装通过。

[共享接收者适配](../../packages/box-runtime/src/internal/io/notification-receiver.node.ts)供管理安装入口及剩余 CLI 共用：Routine、同帧 Host capability/model、独立所有权读取在有限期限内完成；保留原配对的 generation 算法，不借 Bot 清单的另一种 hash 误替代。源/profile 换代、重定向、超长/慢响应、取消均保持失败，不获取 webhook key、不启用 Routine、不调用模型。

[通知管理 Node 组合](../../test/notification-management.test.ts)实际执行 14 个场景：包含真实 Node HTTP 接收者适配、惰性/未授权零外发、后台自行选取授权之后的新 work、竞争进程单次投递、慢来源不挡 API、管理关闭取消并结算真实 HTTP、unknown 重启不重发，以及正式 CLI 状态查询。HTTP 接收端与原生事实均为隔离合成输入，不是实际 Bot/用户收到提醒的证明。

### 上一段固定源码与验证

以下固定结果不签后续新增接收者管理与独立测试。事件/异常恢复及通知迁移组合的回归前后指纹相同：`66db2724bd08c48d5f60d702a1c417699c5387ebc3b6e8058977891c63d7c298`，1033 个 git-visible 源码/测试/工具链输入；不包括 docs 或已安装依赖。Node 22.22.0、Bun 1.3.14 下根/Web typecheck 通过；44 个测试文件的扩大回归为 **391 pass / 0 fail**。包装测试内部包含管理 Node 36、桥 Node 9、观察 Node 12、异常/订阅 Node 19、通知 Node 14，以及生产 Chrome 20 个测试节点（含父测试）；不与391重复相加。

本次重新构建生产制品并运行 tarball 安装验证。浏览器覆盖本机 HTTPS 代理的 Secure 会话、变化流及异常 ack 到达、有限重连与缺口、通知状态权限与窄屏。已把[旧打包采集器重启测试](../../test/monitor-service-packed.test.ts)迁到正式 `system service run server`：实际 Node 子进程 SIGKILL 后重新启动，cursor 接续、既有 incident 身份保留、通知 off 没有 work、正常停止无晚写；旧 `--json` 选项不再误加到默认 JSON 的新命令。没有恢复旧 daemon 入口来迁就测试。

`bun run test:web` 已纳入通知管理组合；扩大回归还包含 client 全组、旧 daemon/CLI/Skill、monitor 全组、原通知 outbox/配对/接收者/防重放与 native Gateway 适配。文档及完整命令覆盖15项通过，含未跟踪文件的发布扫描无发现，tracked diff 格式检查通过。源码/原生事实/安装/用户验收仍分层：原生事实和通知接收端均为合成隔离输入，未切换现役服务、全局 shim、操作真实 Bot 或调用真实模型；没有提交或发布。

### 接收者授权、独立测试与投递回执

A22 已进入[共享通知用例](../../packages/server/src/notification-management.ts)、CLI 与真实 Web。`notification receiver list/get/verify/enable/disable/unbind/test`、`notification list/get` 以及 `operation get --domain receiver|notification-test` 绑定安装、原数据库、实际 binding/work 和原 request-id。启用只记录显式未来授权，不再要求 `fromWorkId`、`reminderObserved` 或先发一条测试。独立测试权限 notifications.test 与授权修改 notifications.write 分开；原生 Routine/凭据准备、当前精确模型与来源资格仍必需。

[原私有 capsule](../../packages/box-runtime/src/internal/io/ops-bindings.node.ts)原子保存 v2 explicit-enable 授权、revision 和有限管理回执；普通新授权门64条，另保留16条及16 KiB给现有绑定禁用/解绑，不让普通容量阻止撤销；disable/unbind 不改写历史，重放旧 enable 不重新授予已撤销权限。旧 v1 仅为安全读取已存在的私有授权保留，不作为新输入兼容。新公共修改全部经 Server，旧 `ops targets activate/disable/unbind` writer 与注册入口退出；初始 config/Routine/provision/bind 已按下节迁入；旧取证/显式发送入口仍有领域收束差额。

[独立测试](../../packages/box-runtime/src/internal/io/notification-outbox.node.ts)在同一个观察库 schema 4 中保存有限 test work，不制造 incident、事故 evidence 或错误事件；共享已有 attempt、唤醒预算、私有原生 HTTP 出口与 unknown 防重放。固定测试内容在秘密出口再次重构校验，不接受用户任意 body/URL/命令。相同 test request 只读回，自动 worker 不消费测试表；管理关闭会取消并结算实际网络/事务，不留晚写。schema 升级显式执行，保留数据库、既有 incident/ack/attempt 身份，活跃旧 collector 不被夺权，普通 GET 不升级。

Web `/notifications` 已承载绑定列表、显式只读核验、授权/禁用/解绑、独立测试和有限投递记录/详情；操作页支持两个新领域。发送前仅保存恢复定位，不把模型 hash、完整输入或凭据写入浏览器存储。未知授权变更阻止替代变更；未知测试仅阻止再次测试，不能成为启用的隐性门槛。并发冲突保留草稿，独立查询原回执后再决定下一动作。权限、CSRF、SSR 和字段白名单沿用共享基础。

验证入口扩展为[管理 Node 旅程](../../packages/server/test/receiver-management.node.ts)、[边界组合](../../packages/server/test/receiver-boundaries.node.ts)、[真实生产浏览器](../../apps/web/test/receiver-browser.node.ts)、[公开客户端合同](../../packages/client/test/receiver-contract.test.ts)及原 outbox/配对/receiver/monitor 回归。测试来源和接收端均隔离合成，不等于现役 Bot 或用户已收到。具体固定源码和最终组合计数在本票本段验收记录中维护。

### 首次通知接入与 Routine 领域收束

[共享 setup 用例](../../packages/server/src/notification-setup.ts)已贯通 `notification settings get/apply`、固定 blueprint、`routine list/get/apply/enable/disable/delete`、私有 `notification receiver bind`，并提供 notification-settings/routine/pairing 三种原请求回执。CLI 和真实 Web `/notification-setup` 从无 Routine、无绑定状态逐步完成接入，再进入现有接收者 verify/enable/test；不需要预先发生事故或先发一条测试。每步独立确认，不在页面加载、保存配置或绑定时顺带授权/投递。

配置通过原 canonical writer 的窄 notification-settings 变更保留其他目标和系统策略。完成回执先于当前配置/锁查回；同时删除旧的 prepared + 当前内容等于 after hash 即判成功的分支。未验证的历史配置发布保持 unknown，当前内容相同不能补造历史提交证据。

原 Routine SQLite 在 schema 3 添加有限状态操作记录，与 provision/binding/tombstone 同 owner；先保存目标/revision/request guard 再单次原生修改，丢回复/COMMIT 回调保留 unknown，不另建通用 operation 库。配对管理记录位于原私有 capsule，与 enrolling/credential 同文件原子提交，历史记录不随 unbind/rebind 被改写。公开键按安装、主体、领域和原目标隔离；浏览器只保存最小恢复定位，不存 blueprint、秘密、完整输入或 revision。读取不初始化/迁移存储。

[窄原生 Routine 适配](../../packages/box-runtime/src/internal/io/routine-gateway.node.ts)固定每个交互的 generation/期限；在重新读取 discovery 后再次检查 pinned generation，换代前拒绝新 dispatch。独立 `routines.read/write` 与 `notifications.bind` 分别控制定义与凭据。原生 revision preflight / readback 不是 native CAS；删除只披露返回窗口内的缺失，不声明全局删除或取消在途工作。

旧 `agents routines ...`、`ops targets ...` 普通命令、daemon Routine RPC 与 capability 已退出。仍受 CONT/保护拥有的**本地**原生 primitive 没有删掉，真实 handover 回归继续覆盖其使用；这不代表 CONT 已迁移。原 provision 可由 `operation reconcile --domain routine` 在 exact disabled definition/revision 核对后只写本地关联，不重新创建或领 key；未知状态切换与凭据请求没有被这种对账偷偷重放。

[首次接入 Node](../../test/notification-setup.test.ts)实际使用合成 Gateway HTTP、管理 HTTP、原私有文件/SQLite 和打包 CLI，覆盖完整接入→无测试授权→新事故后台投递，以及并发/权限、丢 native create/key/state 回复、保留历史、精确 reconcile、换代前拒绝 dispatch 和关闭期间无晚写。[生产浏览器](../../apps/web/test/setup-browser.node.ts)从未准备状态完成同一链路，验证草稿保留、丢回执刷新、精确对账、权限/CSRF、秘密不进 HTML/恢复记录和窄屏。fixture 只在测试存在；实际原生与用户收到仍未因此证明。

### 首次接入大阶段的固定验证

本阶段最后一次扩大回归前后 `captureVerificationSource` 一致：`63e8b08fd9bd2931978aa2c491900c08f246ab1584a3a264aecd6bdbfd809904`，1054 个 git-visible 源码/测试/工具链输入，不包括 docs 或已安装依赖。Node 22.22.0 与声明的 Bun 1.3.14 下，根与 Web typecheck 通过；62 个测试文件的受影响扩大回归为 **496 pass / 0 fail**，不是全仓所有测试已验收的声明。

其中包装测试内部实际执行首次 setup Node 18、接收者/通知管理 Node 31、异常/订阅 Node 19、同源桥 Node 9、观察/服务 Node 12、模型管理 Node 36，以及生产 Chrome 33 个测试节点（含父测试）；这些内部数不与496重复相加。新 setup 浏览器从无原生 Routine/无私有绑定的已初始化测试安装开始完成目标配置、disabled Routine、配对、原生 enable、独立授权和可选测试；不把初始安装/观察库资格藏在页面中完成。

组合同时实际运行生产构建、搬移 Web、tarball 安装/清单核验、正式 CLI、原配置/迁移/锁/冷读、原 Routine/provision 崩溃/容量、旧入口拒绝、daemon 和 CONT handover 等交叉回归。真实 Node SIGKILL 后 collector cursor 与 incident 身份接续也仍通过。新的配置历史证据反例、并发 Routine 单 dispatch、原生回复丢失、预留 COMMIT 回调丢失和关闭期间凭据请求取消都有执行断言，不由结构检查代替。

文档与所有实际 CLI leaf 的主场景覆盖15项通过；只读 probe 的旧 targets 路由已换成正式 `notification receiver list`，没有实际执行 LIVE probe。发布扫描明确包含未跟踪文件，1336个文本 blob 无发现。工作树的暂存与未暂存成果均保留，HEAD 仍为 `a3e9131`，未提交、发布或切换现役服务/全局 shim。原生事实、通知接收端仍为隔离合成输入，未调用真实模型，未据此关闭完整原生 LIVE、长期存储、独立审查或用户验收。

`bun run test:web` 已纳入首次 setup Node 组合。再次推进先读取本票及 T45/T46/T53 的当前边界；不要重做已有空壳，也不要恢复已退役的普通命令或 daemon RPC 来迁就旧脚本。

### 材料来源、检索与源写入恢复

[DATA-01](DATA-01-memory-project-files.md)已进入真实跨入口实施，不再只是占位。管理 Server 持有有界材料 indexer；显式材料配置选择根目录、声明账号 scope、Bot/Project allowlist 与普通文件写权限。当前资格是 Linux 本地源文档，不把上游账号登录、同步或原生完整 CRUD 当成已知。Agent/User/Project Memory 分片、Project 描述和 membership 保持原身份；文本相同不跨来源合并，Project 不从 Git 路径推断。

新 `system materials get`、`memory list/search/read`、`project list/get`、`file root list`、`file list/search/read/write`、`operation get --domain material` 与 Web `/materials` 共用[管理用例](../../packages/server/src/materials.ts)和[客户端合同](../../packages/client/src/material-validation.ts)。原 positional Memory/`--content` 入口退出，元数据、检索、正文和修改权限分别检查。浏览器只为明确选择的引用加载正文；编辑冲突保留草稿，未知提交刷新后仍阻止替代写入并提供原回执查找；本地存储不保存正文、revision 或凭据。

[原文件读取和文本 writer](../../packages/box-runtime/src/internal/io/material-source.node.ts)绑定真实根目录与逐层目录描述符，拒绝穿越/符号链接/硬链接/来源替换，原生分片始终只读。普通文本只替换已存在且显式授权的文件，源提交后独立读回；外部 writer 不共享原子 CAS，回执如实披露。持久预留先于源副作用；丢回复、COMMIT 回调丢失或发布后故障都保留原 unknown，匹配当前内容不补签历史成功。

[索引和写操作 owner](../../packages/box-runtime/src/internal/io/material-store.node.ts)将派生文档和不可随索引重建丢弃的操作分表。周期校准逐项更新变化，不变文档不重写正文或失效游标；故障源与其他来源隔离，新鲜度和可用性独立。读取不创建/迁移/回收索引。索引器由真实进程身份串行化源扫描，不在数据库事务内读源。无关配置变更不影响材料扫描；撤销或替换源立即阻断旧索引引用。坏/丢数据库不重建安全历史；索引损坏不挡完好源的直接读取，但不允许在丢失安全记录时进行新源写入。

验证入口为[Node 文件/SQLite/HTTP/CLI 组合](../../test/materials-management.test.ts)、[客户端反例](../../packages/client/test/material-contract.test.ts)及[生产 Chrome 旅程](../../apps/web/test/materials-browser.node.ts)。源材料、账号声明和原生布局全部是隔离合成输入，没有读取用户真实正文或修改原生资料。完整原生事实修改、Project 文件附件/二进制、源和权限管理命令完整收束以及长期安全维护仍归 DATA-01；当前文本切片不关闭这些义务。

### 默认保护、恢复材料与后台交接

[保护服务](../../packages/box-runtime/src/internal/roots/protection-service.runtime.ts)已迁入管理 Server Scope，与原采集器、材料 indexer 和通知 sender 分别拥有资源寿命；不再由旧 daemon 启动保护 worker。服务发现真实原生 Bot 并复核账号/Box 所有权，默认只接纳新核验的 owned Box，保留显式排除；默认 alert/resume，不因发现就自动创建替身。每次发现轮转32个候选、累计128个主体；容量、分批覆盖和未关联创建分别可见，未知创建不会把刚出现的目标误登记成第二个受保护主体。

原[保护程序](../../packages/box-runtime/src/internal/roots/bot-protection.runtime.ts)继续拥有 subject CAS、loss guard、恢复材料、替换预算和原 lifecycle。观察、材料/继任推进和交接独立运行；慢捕获不阻止失去归属的观察和精确 Routine 暂停。捕获完成在原数据库内只合并对应 generation/pending ID 的材料字段，和 GC 引用同时提交；保留并发更新的 loss/事件状态，不再吞掉陈旧 CAS 后声称快照已关联。关闭等待这个有限本地结算检查点，不在事务中执行原生网络，也不让旧捕获覆盖新继任者。错误、陈旧、账号变化或不匹配的原生身份不算确认丢失；暂停前重查事实与策略，结果未知不重复暂停。已恢复所有权也不自动恢复原生 Routine。完整 CONT 库丢失或损坏保持阻断，不重新建空库取得许可；单个 fd gate 拥有同根所有保护通道，竞争进程仍可服务普通查询。

[共享原生适配](../../packages/box-runtime/src/internal/io/continuity-gateway.node.ts)及 lifecycle/protection/handover/convergence 组合移到 box-runtime，Server 不执行 CLI 或导入 CLI 业务实现。内部 Routine 的 operation deadline 同时传到真实 HTTP，不能只让调用者先返回、让原生读取继续悬挂。checkpoint/材料资格缺失显示 snapshot_unavailable，不合成成功材料或新 Bot。当前测试中的可恢复端是显式替换外部端口，不能作为真实 Host/Provider 已恢复的证明。

新 `system protection get/set`、`bot protection get/set/reset`、`bot snapshot list/get`、`bot handover get` 及 protection 操作查询进入统一 API；旧 `agents protection status/observe/advance` 普通入口退出。策略通过同一配置 writer 与提交前权限检查，未知结果用原安装/主体/目标/request-id 查回；原 Bot ref 不自动改指继任者。Web `/protection` 展示默认与覆盖策略、worker、原/现/前任身份、恢复材料元数据及逐职责记录；明确正文不加载、继任可用不等于交接完毕、交接完毕也不等于旧 Bot 可删除。继任激活后仍保留最多16个历史交接导航引用，超出显示省略，不删除原 workflow 或改变执行权限。

保护事件经原观察桥进入 monitor；关闭通知不关闭保护和必要证据。每个新事件的连续序号与 subject 一起持久化，不再把毫秒时间戳当序号制造巨量缺口；真实队列溢出消耗序号并保留 gap。编号新流与旧未决导出区分，重放旧事件不改变其原格式。事件导出受阻有有界欠账，不阻塞归属恢复；导出成功不等于通知投递。

[管理 Node 场景](../../test/protection-management.test.ts)、[浏览器旅程](../../apps/web/test/protection-browser.node.ts)和[原保护回归](../../packages/box-runtime/test/bot-protection.test.ts)验证默认发现、37/132候选轮转/容量、竞争 owner、慢捕获隔离、关闭结算、真实 HTTP 取消、配置丢回执/撤权、模拟继任、未知创建不重试、交接链接跨刷新，以及生产 Node SIGKILL 后 loss guard/原暂停记录保留。打包进程按真实30秒观察周期取证，不为测试更改生产节奏。最终固定源码和扩大回归结果在本票本段验收记录中维护；原生身份与恢复端仍为隔离合成输入。

### 保护阶段固定源码验证

最终源码指纹为 `c6920b0b72fae55fbccc60a33239950499574038c174ef0b38032575489e9014`，1088 个 git-visible 源码/测试/工具链输入。Node 22.22.0、Bun 1.3.14 下根/Web typecheck 通过；两组文件不重叠的扩大回归分别为235项/28文件、444项/55文件，合计 **679 pass / 0 fail，83个测试文件**。两组前后指纹相同，不计 docs 和已安装依赖，也不是全仓最终候选签署。

包装测试内部包括保护 Node23、材料 Node25、原模型管理 Node36、首次通知接入 Node18、通知管理 Node31、异常/订阅 Node19、桥 Node9、观察 Node12，以及生产 Chrome47个测试节点；内部数量不与679相加。浏览器使用搬移到源码树外的生产制品，包含材料、保护、继任后交接定位、丢回执刷新、权限和窄屏；打包测试实际安装 tarball 并核对 Web 清单，补齐已随包交付的 materials Skill 文件断言，而不是删除该 Skill 来迁就旧清单。

交叉回归包括原 CONT recovery/subject/workflow pins/GC、真实 Node 进程强杀、current-state/native-worker 的隔离测试端、原 handover HTTP、通知预算/防重放、原观察与配置迁移/锁，以及旧命令和 daemon 回归。复现后修复了原生 Routine 超时不关连接、捕获结束与归属观察并发时关联丢失、继任激活后交接链接消失、事件时间戳伪装序号等问题。服务关闭可能真实产生 source_gap，验证逐条保留事件连续序号而不是要求隐藏该事件以满足固定计数。

最终文档与全部实际命令 leaf 覆盖15项通过；含未跟踪文件的发布扫描核验1372个文本 blob、无发现，暂存和未暂存差异格式检查通过。最终复核源码指纹仍与上述两组一致。

本阶段原生 Bot/Host/Provider 事实、恢复材料和账号声明仍是隔离合成输入。没有切换现役服务或全局 shim、读取用户真实材料、调用真实模型、提交或发布；工作树暂存/未暂存成果继续保留。剩余实际原生能力、完整附件和职责、源删除边界、安装/独立 modeld、长期容量与独立审查不由这些通过结果签收。快速复验 `bun run test:web` 已包含材料和保护管理包装测试；CONT 领域进一步使用原 continuity-lifecycle 非 qualified 组合。

### 人工生命周期的统一管理入口与原操作续接

`bot clone/replace/spawn --input ... --preview/--confirm`、`operation list/get/resume --domain lifecycle` 已进入[统一用例](../../packages/server/src/lifecycle.ts)，复用原 CONT 生命周期、native owner/checkpoint worker 与初始化程序。原私有 immutable workflow 增加安装/主体/request/intent digest；原生阶段、已知目标、材料引用与恢复仍由原表拥有，不增加通用操作数据库或第二工作流引擎。预览只读原生 scope/policy/profile/模型，返回有界摘要，不建立安全库或新 Bot；提交重算并检查原计划。

同一提交只返回历史，显式 resume 才继续原计划；客户端先固定输入与恢复定位，回复丢失或不匹配保留 unknown。操作列表先按主体过滤再分页，原账号 scope 和 public UUID 固定。`ready`/`active` 可能只是后续阶段之前的检查点，跳过执行必须核对最后所请求阶段完成；已激活 replacement 的 resume 只继续原 handover，不再次 capture/create/initialize。程序启动和用户身份交接消息分别需要 lifecycle.start/messages，且与原生 policy/scope 核对同时成立。原生与旧 handover/后台适配不能继承人工主体权限，旧 attest 也不能绕过该边界。

单个有限 fd gate 串行同根人工 driver；并发请求/管理进程保持 ordinary reads 可用，原 CONT step claim 仍拥有外部防重放。HTTP 断开不取消已接受的 Server Scope 程序；关闭服务则取消实际原生工作并等待原领域最终结算。重启后只能查原请求或明确续接，未知创建不因新进程再次 dispatch。完整安全库丢失不重建为空库取得新许可，长期容量/墓碑仍保留原义务。

Web 新增[只读 lifecycle 页面](../../apps/web/src/routes/_console.lifecycles.tsx)，显示原/目标身份、阶段、未决效果与交接链接，私有指令/profile/材料不加载。浏览器同源桥只开放 lifecycle GET，不增加创建/任务发起/续接入口。旧 `agents clone/replace/spawn` 与 `agents lifecycle status/advance` 普通注册及直连 writer 已退出；独立 current-state/其他 handover 管理尚有迁移差额。

复核默认保护与新人工生命周期的交界后，修正了所有 workflow target 被永久排除的旧逻辑：仅未完成独立目标和 replacement 前后继继续排除；已完成的独立 clone/spawn 可被默认保护按原生资格接纳，未知创建仍阻断新身份猜测。[管理 Node 组合](../../test/lifecycle-management.test.ts)验证权限、原主体隔离、重启/断连、未知创建、并发 gate 和独立续接；[原 native owner 测试](../../packages/box-runtime/test/native-current-state-owner.test.ts)的完整 clone/spawn 已迁到真实管理 HTTP，仍调用原 owner/worker 而不是用假的初始化替代。[生产浏览器](../../apps/web/test/lifecycle-browser.node.ts)验证 scoped history、未知结果刷新、私密数据隔离和窄屏。原生身份/恢复端仍是隔离合成输入，不代表真实账号或完整 Provider/App 已恢复。

### 人工生命周期阶段的固定验证

最后两组不重叠扩大回归均在指纹 `3de1fe2fa7ca4ebdbf072f2f45244aa0cf72e9a6b1d4e8669d799ba2497e08b5` 上执行，前后1098个 git-visible 源码/测试/工具链输入一致，不含 docs 或已安装依赖。Node22.22.0 / 声明的 Bun1.3.14 下，A组243项/30文件、B组445项/55文件，合计 **688 pass / 0 fail，85文件**；这不是全仓所有测试或真实原生完整验收声明。

包装测试内人工生命周期 Node18、保护 Node23、材料 Node25、首次通知接入 Node18、通知管理 Node31、异常/订阅 Node19、同源桥 Node9、观察 Node12、模型管理 Node36，以及搬移生产制品后的 Chrome52个测试节点均通过，不与688重复相加。原 native owner/worker 的24项测试中，完整 clone/spawn 已经使用新 CLI→管理 HTTP→Gateway→原生 RPC→原 owner/worker→材料读回路径，不是删除旧高强度验证来迁就新接口。CONT对象/安全记录回收保护、真实子进程崩溃、后台保护、通知、配置、旧 daemon、打包与 Skill 同批回归。

第一次扩大检查发现浏览器依赖白名单尚未登记两个新增的纯合同模块；仅补充这两个精确输入，未放宽 Node/Effect/存储导入边界，随后重跑固定源A/B两组。阶段中也修正了测试 discovery 文件不符合正式来源权限要求和重启后旧连接池复用的测试条件；没有为它们放松生产文件检查或增加自动写重试。根/Web typecheck、生产构建、tarball安装与Web清单核验已执行；浏览器桌面/窄屏截图已检查，视觉仍不签最终设计。

收尾限制：固定源两组回归完成并写回本段后，包含文档复验、typecheck补跑、含未跟踪文件发布扫描和Git差异检查的最后一个工具命令及一次同参重试均被安全状态检查拦截，未进入执行。因此不宣称本阶段已完成最后一遍发布扫描或文档复验；前述688项、类型检查与生产制品结果来自已实际执行的各自窗口。最后成功核验的源码指纹仍为本段所列值，之后只修改本票的说明。没有提交、部署、切换现役服务/全局入口或真实模型调用。

### 独立当前上下文控制的统一入口与恢复

`bot context get/initialize/reset/restore`、`bot snapshot create`、`bot activate` 与 context 域 operation get/resume/reconcile/cancel 已进入[统一管理用例](../../packages/server/src/context.ts)。旧 `agents state` 全部普通注册、dispatch 与直连 writer 退出，不以兼容转发保留另一套执行。当前 head 和能力来自同一个受限原生适配；CONT 原 capture/prepare/claim/commit/reopen/marker 程序仍拥有真正的源副作用，管理入口不直写原生资料。

原 CONT 控制表记录安装/主体/request/Bot/scope、准确原始 head、策略及固定材料引用，不新建通用操作库或更改原生 session 模型。同一提交只查历史；明确 resume 才安全续接，已有未知原生 apply 只查原标记，不再次导入。客户端断开不撤销 Server 已受理执行；关闭取消实际原生连接并等待有限回调和持久结算，进程强杀后的安全记录不重新初始化。原生应用缺失不是未执行证明。显式取消仅限根 driver 互斥下无任何原生应用声明/解除声明的准备，保留取消墓碑，原请求不复活，也不删除未知效果换容量。

reset/restore 在源替换前保全目标 checkpoint，未完成准备与等待解除的来源/备份/候选和原 GC 在同一数据库事务内核对引用。确认源快照不存在时在 target 预留前拒绝，避免拼错引用把目标变成永久未决。捕获重复读回核对原始 head，源应用请求核对固定 mode/target/effect/backup/candidate。材料按来源捕获时间保留，复制旧快照的写入时刻不冒充新安全点；历史回执可继续定位已退役材料，不保证正文无限保留。

配置上下文、解除 hold 和历史分别需 context.write、context.activate 和 operations.read；源读取需 context.read。管理授权与原生 scope/policy/ownership 在效果处同时成立，反向输出前重核读取权限。解除仅处理原应用标记，不发消息/模型任务；回复丢失后从历史取首次解除 revision，原生幂等解除可以证明该标记已释放或仅解除其仍准备的 hold，不能打开另一操作或重导 B0 覆盖 B2。

Web [contexts 页面](../../apps/web/src/routes/_console.contexts.tsx)和操作页读取同一来源/历史；更改与续接分别确认，提交前只保存原定位，正文、材料选择和 revision 不写入 localStorage。冲突保留草稿；尝试取消未知 apply 被拒绝不能误清原 unknown，丢解除回执刷新后仍沿首次解除 revision 恢复。原生 source 不可用时历史仍可读；别的 Bot 的已知原请求不会被当前选择自动接管。

[管理 Node 组合](../../test/context-management.test.ts)实际执行 HTTP、文件/SQLite、原生 owner/RPC/checkpoint worker、打包 CLI 与管理进程 SIGKILL，覆盖 capture/initialize/reset/restore、Memory/历史保留、独立解除、B2不回退、COMMIT 回执丢失、并发/断连/撤权、原生 unknown 不重发、有限取消和材料GC；[生产浏览器旅程](../../apps/web/test/context-browser.node.ts)验证真实页面、刷新恢复、权限/CSRF、错目标和窄屏。native schema、账号和内容均为隔离合成输入，无现场Bot/Provider调用。最终扩大回归与源码固定证据见下段，不沿用前一阶段688项作为本阶段签署。

### 当前上下文阶段固定验证

固定源码 `0e31d6ce81ab47bac6cd159ab61032abb0eb7304bf85f65128918e6e726ddf44`，1110 个 git-visible 源码/测试/工具链输入；Node22.22.0、声明 Bun1.3.14。根/Web typecheck 通过；两组不重叠扩大回归 A260项/34文件、B445项/55文件，合计 **705 pass / 0 fail，89个测试文件**。A、B 各自前后指纹均相同，不包括 docs 和已安装依赖，不作为全仓最终候选资格。

包装组合内部实际执行当前状态 Node18、人工生命周期 Node18、保护 Node23、材料 Node25、模型 Node36、通知接入 Node18、通知管理 Node31、异常/订阅 Node19、桥 Node9、观察 Node12，以及搬移生产 Web 的 Chrome59个测试节点；这些内部计数不与705相加。新增当前状态 Node 使用真实项目 native owner/RPC/checkpoint worker 和 SQLite，而不是替换管理程序；schema/账号/原材料仍是合成测试事实。打包管理进程在实际原生 apply 后 SIGKILL，重启以原 marker 对账，initialize计数保持1；正常停止后数据库无晚写。生产页面覆盖丢 apply/解除回执、刷新、原 release revision、错误原 Bot、读面/写面权限与CSRF。

A 还执行生产构建、tarball 实际安装与 Web 清单核对；B 保留原 current-state、checkpoint/owner、材料回收/引用、配置、生命周期、通知及保护交叉回归。浏览器 source conflict保留草稿、原生unknown不能取消、新解除版本不能覆盖原解除声明、旧入口拒绝与前端bundle边界均保留反例。界面桌面和窄屏截图已读回检查，仍是功能视觉，不是用户最终风格签收。

最终文档/实际CLI leaf覆盖15项通过；包含未跟踪文件的发布扫描1396个文本blob无发现，暂存/未暂存差异格式检查通过，最终源码指纹仍相同。HEAD为a3e9131，当前施工树368个跟踪改动，既有成果完整保留。

本阶段没有读取用户真实 Memory/历史、执行实际 Provider/账号任务或切换现役服务/全局 shim；工作树成果原地保留，未提交或发布。剩余 handover/compact 迁移、附件/源资源独立、self-reset和实际原生资格、安装/独立 modeld/长期容量/独立审查仍是后续责任。

### HOST-01：实际来源—Rust验证—原OBS—多入口的首个工作包

接收[Host升级/健康整合交接](../roadmap/host-patch-health-integration-handoff.md)后，已从current-state固定闭合点切入W3平台依赖；没有重做705项阶段、切新平行工程或选择另一个parser。已有及并行的Cargo/协议/producer/空目标collector成果保留并整合。当前用例见[HOST-01](HOST-01-patch-health-verifier.md)，固定验证和磁盘来源复核见[阶段报告](../reports/2026-09-20-host-health-first-integration.md)。

原TS apply是唯一transform；真实candidate经过Node只读快照FD→正式Rust/Oxc→原provenance→原OBS installation condition/outbox，再由共享 `system host health` 与 `/host-health` 展示。新wire schema覆盖完整initialize/JSON-RPC包络，两端生成/核验；binary/lock/toolchain/schema/规则进入构建身份和tarball，安装后实际运行binary/FD并验证许可文本，不需runtime cargo或联网下载。

静态predicate实现真实绑定、有限CFG及受支持直接调用/CJS注册；捕获并修复dead-code/TDZ/错词法frame/后写覆盖/未注册入口误判。实测修复了同size同毫秒mtime来源变化被漏检，以及新receipt尚未索引时沿用旧intake成功。原observer保留dirty/backstop、单producer、有限cache、过期结果阻断、retain→intake重启补入；公开fixtures不访问用户Host，实际磁盘只在明确静态资格命令读取，未执行私人源或调用模型。

最终 `verify-host-health.mjs` 两组固定源码 `0af5f91658b47a95e594fd2c9fc4c0a75ebeaee4a51dfc7a70b766713b359206`，1153输入，前后相同。core的Bun271项/31文件及integration21项/15文件不重叠，合计292项/46文件、0失败；另Cargo20项通过，根/Web类型检查和wire生成一致性通过。包装内部Host管理Node10、verifier两个组合21/20、Chrome63节点及原context/lifecycle/保护/材料/通知/观察/模型组合全部执行，通过数不重复相加。生产构建、tarball实际安装、安装后Rust/FD、Web清单和窄屏截图也已验证。该受影响回归不是全仓最终候选签署。

同窗口磁盘Host26523565字节、worker677638字节，SHA仍是前置报告的2380c2…/56f87f…；正式Oxc严格source/companion诊断0错误、约3.76M/116K节点，分析548ms，整个资格命令6391ms（单次，不是SLA或RSS）。完整recipe仍不匹配，core39中9项/current-state19中2项失败，worker配对未资格。未传profile的调用没有exact candidate，三个candidate规则不签通过；不改旧recipe/SHA/pin求绿。

收尾文档/实际CLI leaf覆盖15项通过；包含未跟踪成果的发布扫描1441个文本blob无发现，暂存与未暂存差异检查通过，未产生新提交。完整证据固定在上述阶段报告，不另建现场进度账。

**本票下一段仍先在HOST-01收必要平台依赖**：实际native角色/全能力、compile负回执与同代attachment/exercised、当前idle/manual/startup等适配。三个有限静态规则、local-only投递coverage和产品qualified=false明确保留，不把这一纵切上限当最终可靠性交付。相关HCR/CONT、T41/T44、OBS-01/04、T40/T50、T45/T55职责已回写原票。其后再继续受Host依赖的handover/compact与其他尚未迁移领域；无关材料/纯管理工作可并行。未提交、部署、真实Bot/Provider或外部通知，未切现役服务和全局入口。

### Host 编译与运行代阶段

接续已有编译/运行观察施工成果，完成 preload 正负 marker→准确进程身份→原 provenance/OBS→CLI/Web 的组合，并修正中断的 model-management/transport 分层迁移。运行代与磁盘来源分别呈现；编译成功不代表 native 挂接/实际使用，静态通过不能修复正在运行的未打补丁代。未安装旁路 controller 或修改实际 Host 配方。固定细节归[编译健康报告](../reports/2026-09-20-host-compilation-health.md)。

源码 `b7fb831cc870e970dd7d810f1c0b905357b6f0cad6c405bfffd2830b563a3d3a`，1161个输入，两组前后固定：core334/36文件、integration22/16文件，合计356 pass/0 fail；20个 Rust 测试、协议生成和根/Web typecheck通过。包装内部编译 Node11、Chrome65等不与356相加。安装后binary/Node、搬移Web、原其他管理域都按当前源码复验，不沿用旧705项。分层反例保持纯合同不能导入Effect，未放宽任意出口或恢复旧writer。

### 同代注册与实际边界见证

已接续并完成 preload 原引用注册→原认证 getHostStatus challenge→管理 Server 独立采样→原 runtime provenance/OBS→CLI/Web。session、retry、context 记录有界实际边界；原对象/方法被替换可检测，getter不执行；没有机会覆盖时不推断 bypass。错误旧回复也核运行代，丢失原回执文件不重置稳定来源序列；心跳不制造持久事件或重复通知。详细实现、反例及剩余范围归[固定见证报告](../reports/2026-09-20-host-capability-witness.md)。

固定源码 `2d1c173370c46232c964c24d8e459f5acbb2ab5ed24b32fd65cb55648a51745b`、1168个输入，两组前后相同：core375/42文件、integration23/17文件，398项/0失败；Rust20、根/Web类型及实际打包/安装通过。包装内部 witness Node19、Chrome66 不与398重复相加。仍 `qualified=false`，没有真实Host/Provider/外部投递或部署。

### 阶段提交与 v2 集成

用户已授权从本阶段开始分批提交。原工作树由 detached HEAD 转为 `feat/agent-first-management`，本地跟踪集成目标 `feat/box-runtime-v2`；创建分支时两者均位于 `a3e9131`，未移动 v2、重置文件或创建平行工程。已有422个暂存文件作为一份完整的重建施工基线保全，避免为拆历史提交制造不可构建的中间状态。提交前源码指纹与上一 Host 健康固定回归相同；后续每个可验证工作包分别提交，未经验证的差额明确记录。

未来在本开发分支工作树干净、并行改动已协调后，先核对 v2 的实际新增提交，再 rebase 到本地 `feat/box-runtime-v2` 并复验受影响范围；合入时在 v2 所在工作树进行 fast-forward。阶段提交不代表部署、发布或授权切换现役服务，不能覆盖 v2 的并行成果。

### 下一实施边界

**Host 平台依赖已进入当前 W3 阶段（2026-09-20）：** 当前独立 current-state 切片已按上节705项固定回归闭合，不重复施工或重跑旧候选来替代新资格。接收[跨会话交接](../roadmap/host-patch-health-integration-handoff.md)后，当前优先进入 [HOST-01](HOST-01-patch-health-verifier.md)：先核实际新版 Host 配方/worker/原生依赖，再以 Rust/Oxc＋Node 的真实纵向切片接入既有证据和 incident，逐步补齐所声明能力的语义与运行见证。这是平台依赖工作，不等所有材料扩展/剩余命令完结后才排，也不延期成 T48 的可选自动维护。无关页面/纯管理/材料工作可以继续；具体并行共享文件由当前实施者协调。

完整实现边界与责任分配以 HOST-01 为准；相关原生采用/恢复/通知验收必须先有对应资格，完整健康与必要告警在新版候选冻结前收口。源码/fixture 通过不代替当前实际来源。眼前实际Host/worker风险盘点与Rust静态验证—原OBS故障投影并行推进；相关HCR/T44/OBS/T40/T45责任保留，shared Server/build/client/本票由当前实施阶段一并收束。没有暂停其他会话，也不扩大现场采用、模型费用或外部投递授权。

材料的本地来源—索引—原文读取—受控文本替换—回执恢复以及默认保护后台/管理读写面已接通。继续 DATA-01 的原生源写能力/Project fileRef/完整文件通路和长期安全维护，以及 CONT 的剩余 handover/compact 控制迁移、完整职责约束/资源独立性与退役资格；人工 clone/replace/spawn、独立当前上下文及原操作续接已进入统一管理面。T45 的确定未受理重试、上游对账、旧发送/取证收束仍保留。各领域原生缺口不通过本地副本或 fixture 降级消除；不为挪容量删除 unknown。完整功能、安装宿主、独立 modeld 实执行、独立审查与集中 LIVE 仍是本票责任，不重新询问已接受的产品边界。
