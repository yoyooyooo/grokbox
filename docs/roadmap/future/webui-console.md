# 单 Box Web UI：观测、Bot详情与受控配置

**已接受方向，前端暂缓；不授权本轮建console、部署HTTP或修改官方App。** 这是未来grokbox自有Web UI，不是给官方Grok Bot.app打补丁。近期采集/SQLite/incident由[T41](../../tickets/T41-continuous-observation-and-alerting.md)先提供，命令边界和浏览器实施仍归[T29](../../tickets/T29-runtime-webui.md)。事实/存储合同见[Spec S0.1.4](../box-runtime-impl-spec.md#continuous-observation)，这里仅拥有未来页面与交互要求。

## 晋升条件

T37身份门、T24逐Bot选择、T27/T33安全观察和T28必要控制接口有真实实现；T41至少提供生命周期独立的快照、事件和incident。相关接口可用后可做只读页面，开放某个写入口须先通过该用例的授权、校验、并发与回执测试，不等所有future实现，也不让只读页面把未实现按钮变成fake success。浏览器施工单独排期，不能成为当前恢复/原生往返主线的前置。

## 页面体系

| 页面/区域 | 问题与必要内容 |
|---|---|
| Box概览 | 正在连接哪台机器；Host/source/profile/loaded运行代、modeld/controller、连接与观测新鲜度；不是一个笼统绿灯 |
| Box能力与配置 | supported / desired / effective三栏分开；能力声明不是资格证据，未支持的操作禁用并说明原因 |
| Bot列表与详情 | 公开ID、Server/local归属、conflict/unknown、当前/未来模型、当前run与可用操作；harness只读，没有任意setter |
| 变化与告警 | observed transitions的发现区间、last success/gap，incident影响和证据，ack/snooze/resolved区分 |
| 操作与结果 | 保存中/已保存待生效/实际生效；控制operation未知/失败，模型终态、Host终态和用户结果分别呈现 |

URL保留boxId、botId、tab/filter；切换Box后清理前一scope的草稿绑定、缓存与订阅，不用IP/名称复用身份。第一版只管理一个受控本地Box；页面模型含boxId不等于已有跨盒写权限。多盒聚合归[独立候选](fleet-observation.md)。

## 读取：先快照，再订阅

API消费T41统一read model，返回snapshot+cursor/source/scope/collector epoch。后续订阅从该cursor接续，允许重复投影但不能漏交界事件；cursor超保留期/运行代变化明确gap再取快照。UI展示lastKnown和stale，不凭返回时间标成实时。慢页面有界背压，关tab不停止collector/已授权operation；不让每个组件直接poll Server。

首版服务端推送优先适配已有有界事件协议（HTTP事件流即可，确有双向需求再评估WebSocket）。传输型别不改变同源/序号/缺口语义。任何API/前端GET不建DB、不迁移/清理、不读模型密钥、不触发prepare/repair/adopt或通知外发；显式refresh请求只交collector的观察预算，不等于强制上游原子新鲜。

## 配置与操作：只有一个writer

模型选择、受支持能力/监控策略更新调用既有commands；不直改SQLite、models.json或Host状态。SQLite保存观测和incident，不承接模型配置后再异步同步。用户输入保持draft→saving→saved-awaiting-use→observed-effective；当前TURN捕获A时保存B只影响下一TURN。

Web UI成为真实第二写入口前，在同一ConfigurationWrite实现短锁、canonical重读、expected configRevision、schema/ownership/authz检查、唯一发布和回执，CLI同步使用。旧revision冲突不覆盖新配置，不抹用户草稿。模型选择与incident ack各用自己域的revision，不能拿全局观测序号当配置版本。

高影响控制复用prepare/preview/明确confirm/apply与原operationId；双击、重连、确认ack丢失先对账，不重复signal/send。预览绑定Box身份、目标/配置/Host修订、过期时间，变化后重新确认。用户切回官方模型不走全局卸载；runtime reset最终按T24能力开放，不能沿用旧文档永久禁用。

## 安全与部署

未来入口可沿既有T29候选`runtime webui run`，但当前没有据此创建可执行命令。Web UI进程与runtime都运行在Box内，浏览器允许在云电脑外通过用户自管网络/HTTPS入口访问；这属于单Box普通部署，不是跨Box runtime写入。监听默认loopback，外部入口可反向代理至本机；确有直接绑定需求时只提供通用host/port配置，不增加Tailscale SDK、peer发现、Serve/ACL管理或尾网明文例外。[产品网络边界](../../product-contract.md#22-网络与旧部署兼容边界)拥有范围。

服务绑定明确本机runtime root，不允许任意Profile、URL、路径、exec或RPC转发。页面/API优先同源相对地址；外部origin与可信代理需显式配置，不把浏览器localhost当成Box。API用独立console会话认证、owner-only bootstrap、HttpOnly/SameSite/Secure cookie、CSRF和严格Host/Origin；Gateway/provider/daemon凭据不发给浏览器，不入URL/日志。网络可达不等于登录或操作授权。

桌面App的历史/Working继续由原版App验收，Web UI的green不能代替T39真实旅程。现有远程daemon能力不自动扩张到远程runtime mutation；外部浏览器访问使用同一应用安全模型和target绑定，不因底层是Tailscale增加专属开发项目，也不豁免认证、授权或浏览器安全验收。

## 浏览器验收与非目标

真浏览器验证：本地与外部HTTPS入口访问同一Box、同源API/事件流与登录cookie、严格Origin/CSRF拒绝、不依赖浏览器localhost或客户端Tailscale CLI；另验证URL恢复、切Box/切Bot、过期/未知、快照流交界、断线恢复、关闭tab、草稿/写冲突、双击apply、未知operation、权限拒绝和脱敏。headless reducer或API单测不算像素/交互通过。没有浏览器环境记录缺证，不skip后签绿。

首版不做聊天composer、任意secret CRUD、通用provider平台、跨团队多租户、无限期历史图表、自动修复工作流或SQLite浏览器。更高级[通知](notification-escalation.md)、[多盒](fleet-observation.md)各有晋升条件。

失效条件：T41 DTO/cursor、T24配置时机、T28操作合同、身份/权限边界或平台部署发生变化时更新此页与T29；不复制新日期版UI方案。
