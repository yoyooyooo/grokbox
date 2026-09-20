# T29 — Shared CLI/API boundary, concurrent writes and Web UI delivery

## Status / owner

**Open · 已纳入本次架构重建的完整交付范围，尚未实施。** 持续观察与观察存储/incident 归 [T41](T41-continuous-observation-and-alerting.md)，其运行不依赖 Web UI。本票拥有共享合同/API、并发修改保护和真实浏览器交付；[单盒 Web UI](../roadmap/future/webui-console.md)拥有页面与交互目标，[CLI-05](CLI-05-implementation-follow-through.md)拥有跨域重建和最终收束。工程/访问安全由 [WEB-02](WEB-02-web-foundation.md)承接，信息架构和真实功能页面由 [WEB-03](WEB-03-functional-prototype.md)承接；[WEB-01](WEB-01-visual-baseline.md)的视觉定稿不是两者前置。

## 本轮设计资料

[Agent-first CLI 收束](../roadmap/agent-first-cli/README.md)已确认一个常驻管理服务、独立 modeld、CLI/Web 共用后台及破坏式命令切换；具体命令与包拆分仍待细化。Web UI 以观察和必要管理为主，Memory/Project/文件按真实来源能力开放读写；不把旧入口或模块形状当成未来架构限制。[WEB-01](WEB-01-visual-baseline.md)保存 V0 风格与功能纠偏，[来源研究](../reports/2026-09-19-webui-source-feasibility.md)保存有限上游证据。本票继续拥有共享边界与后续浏览器实施；当前未启动浏览器施工。

## 共享能力合同

- CLI/API 共用领域用例、T37 归属判定和 T41 观察读面，目标/输入输出/错误/操作/事件来自共享合同与客户端；Web 不执行 CLI 子进程，不另建 admission/controller/collector。页面可有展示和聚合查询逻辑，不能复制领域规则。
- 模型/保护/监控配置各有唯一领域写用例。模型选择区分原生、跟随默认和指定；指定不随默认切换，但自身模型配置更新用于后续轮次。草稿、已保存选择、当前 TURN 捕获和实际生效分开，具体模块可随重组调整。
- 每次操作绑定明确Box/Bot/scope，缺身份拒绝；IP/显示名/当前页面不是目标权威。capability supported/desired/effective分别显示，勾选不能制造支持资格。
- 现在固定revision/幂等/错误合同，不为未出现的writer建立通用CAS系统。CLI+Web API成为两个实际写入口时，同一入口短锁→重读→expected configRevision→同一校验/归属/权限→原子发布；CLI同时接入。
- GET只读，不建库/迁移/retention、解析模型密钥、启动monitor/prepare/repair或投递通知。显式refresh受T41采集预算约束，不等于修改上游。

## SQLite与独立后台

旧“WebUI一律无SQLite”调整为**不得有SQLite配置/执行SoT**：T41可在UI之前实现本地观测与incident库。浏览器只经有限API读取，不能直接开DB或通过写DB再同步models/desired。current projections可重建，历史observations/ack/snooze/通知回执不能一律当可丢cache；数据合同唯一在[Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation)。Host 原生数据与身份继续接入；J13 等领域记录按其事实权威整合，不迁给 UI。旧开发期内部历史的兼容范围统一服从 [重建 Spec](../roadmap/agent-first-cli/spec.md)，不因此放弃新版必要历史。

目标架构中 collector、证据/索引、管理异常、保护/交接与启用后的通知归常驻管理服务，modeld 独立；网页拥有订阅和草稿。现有 T41 记录的实现按新边界迁移，快照/cursor、scope/epoch 与保留缺口的合同继续收口；关页面不停止服务，不重放未知操作。

## 部署边界

进程与runtime在Box内，外部浏览器经用户自管HTTPS入口访问，是已接受的单Box场景，不是跨Box runtime写入。沿用[产品网络边界](../product-contract.md#2-默认入口与连接)：只提供必要的通用监听/外部Origin配置，不发现或管理Tailscale、Serve、ACL。使用同源API或显式地址，不能依赖浏览器localhost指向Box；应用会话、严格Host/Origin、CSRF、代理信任和target绑定照常验收。本票仍未启动浏览器开发。

## Module / dependency

统一后台的命令/API 边界按已闭合用例收口，浏览器工程与 Server 骨架同时建立，朴素功能页面随领域能力接入，不等后台全部完成才首次检验第二消费者。共享领域语义不等于把 CLI 输出直接当页面模型；SSR 聚合不拥有写规则。现有 runtime-kernel、box-runtime 与 CLI 中的领域责任按新边界评估复用、移动、重写或删除；API/CLI 共用后台用例，不各建业务 owner。Gateway 适配有界，不让领域服务反向依赖 CLI 或浏览器接触 Gateway secret。

T27/T28/T37提供相应能力，T41供观察；某模块可用才开放它的写操作，不等所有future、也不假开放未就绪功能。T41不等待本票，T29与T40无相互整票Done依赖。

## Acceptance

1. CLI和API同一程序/输出语义；构建边界拒绝第二配置规则/控制器/collector。
2. 真实 CLI/API 并发修改进入同一领域 writer：版本冲突不丢更新、保留草稿；旧 read model 不授权写，重复 requestId/ack 丢失按原 operation 对账，不二次 signal。
3. 错Box/账号scope/身份未知、过期确认、权限不足在产品写入前拒绝；secret不入URL/日志/HTML。
4. GET counted ports产品写、DB管理写、signal、模型调用和notification均为0；状态GET不自动refresh上游或变更服务。
5. 按[页面合同](../roadmap/future/webui-console.md)交付真实功能 Web，并在浏览器验证路由/刷新、SSR 交接、快照/流交界、断线恢复、草稿/冲突、关闭 tab 和受支持写入；先验功能与安全，视觉定稿后另验最终呈现，API/reducer 绿不代替浏览器。
6. console会话认证、默认loopback与用户自管外部HTTPS入口、Host/Origin、CSRF、confirm操作有独立证明；外部浏览器不依赖客户端Tailscale CLI，不把网络可达当认证，也不复用高权限Gateway/provider身份。构建/运行不需要私有App源码，不修改官方App。

## 非目标 / 下一动作

页面随真实用例接通，不以 React/Playwright/HTTP 空壳作为交付；不做跨盒 runtime 写、通用 exec/RPC 代理、聊天 composer、通用业务编排/任意自动修复、多渠道升级或全量分析平台。默认保护及证据支持的交接属于已接受的后台专门职责，页面只共用其用例与结果。此前“禁止另建React/Query/SQLite平台”仍禁止平台化，不禁止T41有实际owner与生命周期的SQLite adapter。

按 [Agent-first Spec](../roadmap/agent-first-cli/spec.md)与[端到端工作链路](../roadmap/agent-first-cli/implementation-impact.md)收束命令、共享后台和真实页面。用户一次性采用最终版，集中工程 E2E 后由用户验收再吃狗粮；不为开发期中间版本建设兼容或持续可用保障。功能工程按生产要求建设，最终视觉尚待确认，不以 V0 样式锁定实现。既有 [runtime Spec](../roadmap/box-runtime-impl-spec.md#webui)及 T24/T37/T41 保留各自来源与差额。本轮仅更新规划，未开始浏览器施工或现场采用。
