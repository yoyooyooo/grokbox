# 单 Box Web UI：内部观察与必要管理

**已接受并纳入本次架构重建的完整交付范围，实施中，尚未完整交付。** 这是 grokbox 自有 Web UI，不是给官方 Grok Bot.app 打补丁。采集/观察存储/incident 由 [T41](../../tickets/T41-continuous-observation-and-alerting.md)承接，共享边界和浏览器实施归 [T29](../../tickets/T29-runtime-webui.md)，跨域收束归 [CLI-05](../../tickets/CLI-05-implementation-follow-through.md)。事实/存储合同见 [Spec S0.1.4](../box-runtime-impl-spec.md#continuous-observation)，本页拥有页面与交互目标；整体骨架与一次性采用边界见 [Agent-first Spec](../agent-first-cli/spec.md)。当前源码/功能范围见 [WEB-02](../../tickets/WEB-02-web-foundation.md) 与 [WEB-03](../../tickets/WEB-03-functional-prototype.md)；生产制品的隔离浏览器验证不代表已部署或最终验收。

## 本轮补充的产品方向

本轮确认 Web UI 主要呈现原生客户端不便查看的内部事实：全局 Memory、原生 Project 与文件、实时活动、日志及归属变化。同时提供模型配置、保护设置、按真实来源能力开放的数据修改和异常处理等必要管理操作，与 CLI 共用后台用例，不必把每个命令都做成按钮。首版不承担聊天、业务任务发起或代官方客户端回复审批。最后一批图片保留为 [V0 视觉参考](../../design/webui/v0/README.md)，最终风格未定，其中冲突的按钮与任务进度示意只保留为视觉历史。

前端应用采用 TanStack Start，放入 MonoRepo 的 apps 子项目；SSR 用于页面预取与渲染，业务 API 由独立的 Effect v4 beta、Effect-first 服务提供。前端与 CLI 消费同一套用例与归一化读面。后台骨架已确定为一个常驻管理服务和独立 modeld；采集、证据、索引、异常、保护、交接与通知属于管理服务内部职责，具有各自故障/资源边界。复用共享合同与客户端、后台领域模块和原生/存储适配，不执行 CLI 子进程；页面展示与聚合查询不形成第二套业务规则。具体包、路由和组件由实施者决定，沿 [端到端工作链路](../agent-first-cli/implementation-impact.md)接入真实能力。

[固定来源研究](../../reports/2026-09-19-webui-source-feasibility.md)保存官方形象、activity 标签、Gateway SSE、Memory/Project 与现有 worker 的证据边界；研究可行不等于浏览器或适配已实现。

## 实施依赖

T37 身份、T24 模型选择、T27/T33 观察和 T28 控制的必要能力，以及 T41 的快照、事件和 incident，按新骨架复用或重建。某个写入口须通过该用例的授权、校验、并发与回执验证后才开放，不用未实现按钮制造成功。按真实用例推进，不要求所有 future 候选先完成，也不把浏览器建设当成后台运行的前提。

Web UI 是此次最终版本的交付要求，不再等待独立的未来排期。工程和功能先行：与 Server 一起建立 apps、路由、会话、请求、缓存及订阅基础，随领域能力接入真实功能原型；最终视觉另行确认，不以 V0 样式为开工或功能验收前置。用户最终一次性采用，开发中的页面可以不完整，不承诺每个中间阶段可用。

## 页面体系

| 页面/区域 | 问题与必要内容 |
|---|---|
| Box概览 | 正在连接哪台机器；Host/source/profile/loaded运行代、modeld/controller、连接与观测新鲜度；不是一个笼统绿灯 |
| Box能力与配置 | supported / desired / effective三栏分开；能力声明不是资格证据，未支持的操作禁用并说明原因 |
| Bot列表与详情 | 真实原生 ID、Server/local 归属、conflict/unknown、当前 run 与可用操作；模型选择区分原生/跟随默认/指定，显示当前轮次与后续配置；harness 只读 |
| 变化与告警 | 后台跟踪的管理异常、发现区间、来源与 gap；ack/snooze 与实际恢复分开，通知启用和投递回执单独展示 |
| 操作与结果 | 保存中/已保存待生效/实际生效；控制operation未知/失败，模型终态、Host终态和用户结果分别呈现 |
| 全局 Memory | agent/user/project scope、跨授权来源检索、原位置定位、同步/索引年龄和正文读取；已核验来源可编辑，其余明确只读；不宣称全账号私有材料可见 |
| Project 与文件 | 原生项目、membership、Memory 与 fileRef；授权范围搜索、读取及按源能力开放的修改；不从 Git root、mtime 推导项目、作者或任务完成 |
| 保护与交接 | 确认 Box-owned 后默认保护，可逐 Bot 调整/关闭；展示真实前后继、保全材料、可用性与交接缺口，目标可用不代表旧 Bot 已可退役 |
| 运行与日志 | 有真实身份关联的 run/STEP/operation、有限日志和错误证据；不按邻近时间补造任务树 |

URL保留boxId、botId、tab/filter；切换Box后清理前一scope的草稿绑定、缓存与订阅，不用IP/名称复用身份。第一版只管理一个受控本地Box；页面模型含boxId不等于已有跨盒写权限。多盒聚合归[独立候选](fleet-observation.md)。

信息架构先定义上述区域的对象关系、跨页定位、必要查询/操作/订阅及完整交互状态，不冻结每个 URL 或组件。URL 拥有导航，查询缓存拥有远端投影，本地状态拥有草稿；订阅只维护接续和投影，不成为事实 writer。SSR 缓存按请求/身份隔离，只传安全数据给浏览器；应用组合根拥有客户端和订阅，不能组件各建一套连接。工程接线归 [WEB-02](../../tickets/WEB-02-web-foundation.md)，功能覆盖归 [WEB-03](../../tickets/WEB-03-functional-prototype.md)，材料领域实现归 [DATA-01](../../tickets/DATA-01-memory-project-files.md)。

## 读取：先快照，再订阅

API 消费统一后台的观察读面，采集/持久化的已有来源与差额由 T41 承接，返回 snapshot+cursor/source/scope/collector epoch。必要状态、变化记录和来源证据持久保存；搜索索引是可重建的派生数据，原内容和不可重建历史各有 owner。后续订阅从该cursor接续，允许重复投影但不能漏交界事件；cursor超保留期/运行代变化明确gap再取快照。UI展示lastKnown和stale，不凭返回时间标成实时。慢页面有界背压，关tab不停止collector/已授权operation；不让每个组件直接poll Server。

首版服务端推送优先适配已有有界事件协议（HTTP事件流即可，确有双向需求再评估WebSocket）。传输型别不改变同源/序号/缺口语义。任何API/前端GET不建DB、不迁移/清理、不读模型密钥、不触发prepare/repair/adopt或通知外发；显式refresh请求只交collector的观察预算，不等于强制上游原子新鲜。

## 配置与操作：只有一个writer

模型选择、保护/监控设置、Memory/Project/文件修改调用与 CLI 共用的后台领域用例；不直改观察 SQLite、模型配置文件或 Host 状态。源数据只有明确写入路径和结果核验后才开放编辑，不通过改索引冒充源更新。SQLite保存观测和incident，不承接模型配置后再异步同步。用户输入保持draft→saving→saved-awaiting-use→observed-effective；当前TURN捕获A时保存B只影响下一TURN。

Web UI 成为真实第二写入口前，在同一领域写用例建立并发检查、canonical 重读、expected revision、schema/ownership/authz 检查、唯一发布和回执，CLI 同步使用；具体模块可随命令收束重组。源端 CAS 不足时披露其真实范围，不把本机锁当成官方客户端的并发保证。旧revision冲突不覆盖新配置，不抹用户草稿。模型选择与incident ack各用自己域的revision，不能拿全局观测序号当配置版本。

高影响控制复用prepare/preview/明确confirm/apply与原operationId；双击、重连、确认ack丢失先对账，不重复signal/send。预览绑定Box身份、目标/配置/Host修订、过期时间，变化后重新确认。用户切回官方模型不走全局卸载；runtime reset最终按T24能力开放，不能沿用旧文档永久禁用。

## 安全与部署

服务生命周期沿[CLI 收束目录](../agent-first-cli/command-catalog.md)收口，当前已实现的正式前台入口为 `system service run server|web`，具体参数以 registry/help 为准；不恢复旧候选 `runtime webui run`。Web UI进程与runtime都运行在Box内，浏览器允许在云电脑外通过用户自管网络/HTTPS入口访问；这属于单Box普通部署，不是跨Box runtime写入。监听默认loopback，外部入口可反向代理至本机；确有直接绑定需求时只提供通用host/port配置，不增加Tailscale SDK、peer发现、Serve/ACL管理或尾网明文例外。[产品网络边界](../../product-contract.md#2-默认入口与连接)拥有范围。

服务绑定明确本机runtime root，不允许任意Profile、URL、路径、exec或RPC转发。页面/API优先同源相对地址；外部origin与可信代理需显式配置，不把浏览器localhost当成Box。API用独立console会话认证、owner-only bootstrap、HttpOnly/SameSite/Secure cookie、CSRF和严格Host/Origin；Gateway/provider/daemon凭据不发给浏览器，不入URL/日志。网络可达不等于登录或操作授权。

桌面App的历史/Working继续由原版App验收，Web UI的green不能代替T39真实旅程。现有远程daemon能力不自动扩张到远程runtime mutation；外部浏览器访问使用同一应用安全模型和target绑定，不因底层是Tailscale增加专属开发项目，也不豁免认证、授权或浏览器安全验收。

## 浏览器验收与非目标

功能原型使用真实服务，认证/权限、并发/未知结果、刷新恢复与资源有界按生产要求验证；不把低保真理解为可跳过安全和可靠性。功能工程与视觉体验分别进入 LIVE-WEB-FOUNDATION、LIVE-WEB-FUNCTIONAL 和 LIVE-WEB-VISUAL，视觉未定不阻前两者，也不自动签最后一项。

真浏览器验证：本地与外部HTTPS入口访问同一Box、同源API/事件流与登录cookie、严格Origin/CSRF拒绝、不依赖浏览器localhost或客户端Tailscale CLI；另验证URL恢复、切Box/切Bot、过期/未知、快照流交界、断线恢复、关闭tab、草稿/写冲突、双击apply、未知operation、权限拒绝和脱敏。headless reducer或API单测不算像素/交互通过。没有浏览器环境记录缺证，不skip后签绿。

首版不做聊天 composer、业务任务发起、审批回复、无来源的进度百分比或固定任务计划、任意 secret CRUD、通用 provider 平台、跨团队多租户、无限期历史图表、通用业务编排/任意修复工作流或 SQLite 浏览器。默认保护与证据支持的后台交接是已接受的专门职责，其实际进展和缺口由页面呈现；业务分工仍由调用者决定。更高级[通知](notification-escalation.md)、[多盒](fleet-observation.md)各有晋升条件。

失效条件：T41 DTO/cursor、T24配置时机、T28操作合同、身份/权限边界或平台部署发生变化时更新此页与T29；不复制新日期版UI方案。
