# WEB-02 · Web 工程基础与访问安全

状态：实施中。TanStack 路由、请求隔离 SSR、同源桥、Console 会话、生产 Web 制品和模型/观察浏览器路径已接通并经隔离环境验证；事件订阅与异常管理恢复已接通；完整安装宿主、其他领域及原生集成仍未闭合。归属：[T29](T29-runtime-webui.md) 的工程子票；与统一 Server 骨架一起推进，不等待视觉定稿。依赖 CLI-01/02/03 已闭合的目标、操作和事件合同，不要求整组合同票先全部完成。

## 用户结果

朴素页面也能在真实浏览器中安全访问同一 Box，刷新或断线后找回对象与操作；后续视觉改版不重写请求、权限和状态归属。

## 范围与责任

- 建立 TanStack Start apps 工程，与独立 Effect-first API 通过共享合同/客户端接通。SSR 仅预取/渲染，不开第二领域 writer、collector 或 CLI 子进程。
- host 组合根拥有客户端、路由、缓存、会话与订阅寿命。URL 管导航/可恢复筛选，查询缓存管远端投影，本地状态管草稿；不在多个 store 镜像同一事实。
- 明确 SSR 请求隔离、脱水字段、浏览器接管与再验证；不序列化秘密，不跨会话复用私有缓存。组件卸载不取消已接受的后台操作。
- 从首个真实入口具备 console 会话、Host/Origin、CSRF、可信代理及 target 绑定；复用 [Web 安全合同](../roadmap/future/webui-console.md)，不留无认证原型作为发布路径。
- 接入结构化错误、操作引用、冲突与未知结果查询，快照/cursor/订阅/gap 使用 CLI-03 合同。网络恢复不重发写入。
- 与 T40/CLI-05 验证实际构建、安装和启动路径；仅 dev server 启动不构成制品资格。包名、组件库和精确路由由实施者决定。

## 当前接线

[Console authority](../../packages/server/src/console-access.ts)拥有最多 64 个五分钟一次性登录码与 128 个八小时会话，使用随机秘密的 hash 索引、严格 origin、HttpOnly/SameSite cookie 和写入 CSRF。会话绑定发起主体与管理 verifier，逐请求重读权限；不把 console 会话升级为登录码签发者。

`system console grant create --origin <origin> --credential-file <path>` 必须有独立签发能力，代码只写新的 owner-private 文件，不进入普通 stdout。`system service run server --console-origin <origin>` 显式许可浏览器来源。登录码与会话只活在管理 Server 生命周期内，不是持久业务 operation；Server 重启后重新登录，仍以相同 principal 查询原模型回执。隔离生产制品测试已验证 Web 重启不停止管理服务，会话仍由管理服务持有；管理服务重启使会话失效，原主体重新登录后仍能读取持久模型回执。独立 modeld 的真实执行寿命另验。

[Node 集成](../../packages/server/test/server.node.ts)与[认证测试](../../packages/server/test/console-access.test.ts)已覆盖私有文件、不覆盖既有目标、一次性兑换、来源/CSRF/权限拒绝、旧 cookie 重登、Server 重启及 CLI/console 共用模型回执。当前使用真实 HTTP/文件/子进程与合成身份，不代替浏览器、外部 HTTPS 或原生 E2E。

[Web workspace](../../apps/web/package.json)现有真实路由与[请求隔离服务](../../apps/web/src/server/services.ts)，通过[固定同源桥](../../apps/web/src/server/bridge.ts)调用管理服务。桥只转发许可的 cookie 读写入口，不接受浏览器 bearer、不代持管理密钥、不转发任意地址；SSR 只读，HTML 不序列化 cookie、登录码或 CSRF。浏览器操作在发送前持久化安装/主体/request-id 定位，不保存模型输入或凭据；刷新和未知结果查询不重发 POST。

[生产构建](../../scripts/build-web.mjs)将浏览器资源、SSR、独立 Node 启动器与校验清单放入 `dist/web`，根 build 已包含它。Web 要求 Node >=22.12.0；正式 CLI 的 `system service run web` 入口只管理自己的 Web 子进程。现有通用安装和服务宿主仍须与 CLI-05/T40 继续收口，不能由制品目录存在推定整套安装已合格。

执行入口：`bun run test:web` 包含前端操作记录、Node 同源桥、SQLite 观察/服务生命周期、[异常操作与订阅边界](../../test/incident-actions.test.ts)及生产 Chrome。浏览器将实际制品复制到源码树外运行；HTTPS 使用本机隔离测试代理，原生事实为合成输入，不是实际外部部署、Host/Provider 或整个 LIVE 的通过。固定源码与实际计数由 [CLI-05](CLI-05-implementation-follow-through.md)记录。

[订阅桥](../../apps/web/src/server/event-stream.ts)逐帧校验并转发有界 NDJSON，不缓存整条流；管理 Server 每批读取前后重查授权，慢消费者等待 drain，取消只结束对应订阅。浏览器路由服务只持有一个订阅，隐藏/退出页面关闭，恢复只重连读取；旧代或保留缺口需要显式新快照。SSR 不持有订阅。

异常管理复用原 SQLite 事务与回执，独立 `incidents.write` 权限及同一 CSRF 检查。原数据库/主体/request-id 定位在提交前保存；未知操作在刷新后仍阻止替代提交，只查询原回执。完成与已查看/暂缓不代表异常恢复。管理 Server 已拥有原采集器与通知 worker 的 Scope；保护及其他后台职责仍待迁入。`/notifications` 使用独立 `notifications.read` 权限消费安全状态，SSR/刷新不发通知，状态不泄露绑定、授权或 work ID；通知启用/测试/逐条投递管理仍有领域差额。

通知接收者 enable/disable/unbind、独立 test 与投递查询也已进入同一个同源桥和共享客户端。读取、修改许可与可产生费用的 test 使用独立 capability；SSR 只读绑定/历史，不自动 preflight、测试或启用。浏览器先保存原数据库/主体/request-id 与领域定位，再提交。授权 unknown 和测试 unknown 分别阻断同类替代请求，测试不确定不能成为启用门槛；终态拒绝不是“测试成功”。服务关闭取消并结算在途测试，查询历史不重放。字段白名单同时在 Server 公开投影和浏览器客户端核验，私有 capsule、固定消息正文和真实凭据不进入页面。

首次 setup 的配置、Routine 和私有配对已消费同一认证客户端与同源桥，`/v1/setup-changes` 丢回执同样保留 operation_unknown。`routines.read/write` 与 `notifications.bind` 独立授权，SSR 只读固定 blueprint/元数据，不串入原生 prompt/key。新 setup 历史定位按安装/主体/领域/原目标隔离，当前原生状态不覆盖历史回执；浏览器刷新后可按原请求恢复，精确 provision 对账不重发原生创建。完整生产浏览器与源码范围由 [CLI-05](CLI-05-implementation-follow-through.md)记录。

材料桥接新增 `/v1/materials`、状态、显式正文和源写入/回执路径，仍只接受固定同源管理目标；SSR 不写源、不启动索引。正文读取有独立权限，异步读取后再查权限；源替换发布前重新核验授权。`/materials` 的草稿属于组件，URL 管分类/筛选/选择，恢复存储只保留原请求与来源引用，正文和完整输入不进入 localStorage。索引器属于管理 Server，关页面只结束页面读取，不带走后台。隔离浏览器验证原文转义、权限/CSRF、冲突、刷新恢复与窄屏，不由此推定实际原生账号已授权或上游同步已完成。

## 验收

1. 真实浏览器与 CLI 读同一个 Bot，通过同一用例修改模型；并发冲突、重复提交和丢回执恢复有真实服务证据。
2. 刷新/前进后退、登录过期、未授权、SSR 到浏览器交接和切对象不串缓存/草稿/订阅；秘密不入 HTML、URL 或普通日志。
3. 断流/缺口可恢复，慢消费者有界；关页面或重启 Web 不带走管理服务/modeld，不产生第二 collector。
4. 功能与安全验收进入 LIVE 的 WEB-FOUNDATION、CLI-API、EVENT-CONTINUITY；视觉未定不阻这组验收，也不签视觉完成。

页面业务覆盖归 [WEB-03](WEB-03-functional-prototype.md)，领域规则与数据源归各来源票。本票不建设第二 API 或平台化前端状态框架。
