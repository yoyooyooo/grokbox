# WEB-03 · 信息架构与真实功能原型

状态：实施中。登录、Box 概览、Bot/模型、回执、观察/异常/变化、通知接入/管理、本地材料和默认保护/交接元数据页面已接通；完整原生材料、运行日志、生命周期动作和安装/最终体验仍有实施差额。归属：[T29](T29-runtime-webui.md) 的功能子票；基于 [WEB-02](WEB-02-web-foundation.md)，随真实领域能力接入，不等待 [WEB-01](WEB-01-visual-baseline.md) 视觉定稿。

## 用户结果

用户能在朴素但真实的站点定位 Bot、材料、运行与异常，执行已支持管理操作并判断结果。以后改变视觉不必重新设计对象身份、数据请求或操作恢复。

## 范围

[页面目标](../roadmap/future/webui-console.md)是唯一功能正文。本票先把其中各区域映射到路由/对象关系、所需查询/动作/订阅、领域 owner 和正常/空/加载/无权限/陈旧/冲突/未知状态；不预设每个 URL、组件或布局，也不机械为每个 CLI leaf 建按钮。

- Bot 与模型：真实身份、当前活动、三种模型选择关系、在途捕获与后续配置。
- 全局材料：Memory scope/source、原生 Project/membership/fileRef、跨授权检索、正文读取和受支持源修改；复用 DATA-01。
- 运行与异常：真实 run/STEP/operation 关联、有界日志、incident/alert、处理状态与通知回执。
- 保护与系统：默认保护策略、真实前后继及缺口，安装/服务/能力与观察新鲜度。

首版无聊天 composer、任务发起、审批回复、虚构进度或交付归因。关键功能接真服务，fixture 只能用于明确的测试，不成为缺服务时的成功 fallback。缺上游能力影响已接受承诺时回领域票/用户对齐，不靠隐藏按钮关闭票。

## 当前功能路径与差额

实际路由位于 [apps/web/src/routes](../../apps/web/src/routes)。Bot 与模型页面共享 CLI 的模型用例；模型修改使用 revision 和提交前持久化的恢复定位，发生冲突保留草稿，显示配置提交而非当前 TURN 已采用。登录、SSR 数据和页面请求使用同一主体/安装绑定，页面不执行 CLI。

`/observation`、`/incidents`、`/events` 经统一管理 API 读取原有 SQLite 观察域。快照含 watched scope、原始来源时间、陈旧状态与事务内 cursor；持久异常的 acknowledged/snooze 与 resolved 分开；有限变化分页可从快照接续，旧代/超保留期明确 gap。没有初始化库时显示 source_unavailable，不建库、不启动 collector、不调用原生 RPC。当前已接通异常详情、ack/snooze 与原操作恢复：复用原事务 writer，版本冲突保留草稿；未知结果通过刷新继续保留定位并阻止替代提交。查看记录、暂缓与实际恢复保持分离。

`/events` 支持从当前游标订阅后续已提交变化。路由服务拥有唯一浏览器订阅，页面退出/隐藏会关闭，网络失败只有限重连读取；collector 换代或保留缺口停止接续并要求新快照。最近显示最多 100 条，移出展示的数量明确说明，不伪造全量历史。

[真实 Chrome 测试](../../apps/web/test/browser.node.ts)使用可搬移生产制品，已验证这些路径、CLI 同源读写、权限/冲突/未知状态、SSR、刷新、页间切换和窄屏导航，并覆盖异常草稿冲突、丢回执恢复、CSRF/只读权限及流断线/换代恢复。合成来源仅在隔离测试内使用，正式页面没有 fixture fallback。`/notifications` 现还承载接收者绑定列表、只读资格核验、显式启用/禁用/解绑、独立可选测试、test/incident 投递列表和详情。notifications.read/write/test 分别授权，同源 CSRF 和服务端逐请求授权不因客户端按钮禁用而省略。状态、同一次操作的历史回执与当前授权分开；启用不发消息，测试不造 incident 或授予自动权限。未知测试阻止重复测试但不阻启用；未知授权操作通过原 request-id 恢复，不由新请求替代。新[接收者浏览器旅程](../../apps/web/test/receiver-browser.node.ts)覆盖无测试启用、测试前后权限不变、失败/unknown、刷新恢复、草稿冲突和窄屏。

run/STEP/日志、受支持的原生投递对账、完整材料管理与剩余生命周期动作仍随 DATA-01/T41/CONT 等领域接入，不以当前可用页面缩小接受目标；最终视觉也未定稿。

`/notification-setup` 现已提供首次目标/预算配置、精确原生 Routine 窗口、disabled 创建、状态修改和私有配对，随后链接到 `/notifications` 的独立授权/可选测试。加载只读，动作逐项明确确认，原生 key 不进入浏览器。配置冲突保留草稿，未知请求经刷新仍保留 original locator；精确 provision 对账不重发创建。`/operations` 已展示 notification-settings/routine/pairing 的历史证据，而非当前原生状态。功能、错误、权限、窄屏与整段首次旅程由生产制品的 [setup browser](../../apps/web/test/setup-browser.node.ts)验证；不是静态示例或最终视觉签署。

`/materials` 已接入 DATA-01 的显式本地源文档：Memory 的 agent/user/project 分类、原生 Project 描述与授权 membership、文件元数据/字面搜索/直接正文。选择文档才取正文，元数据/检索/正文权限各自控制；来源可用性与索引新鲜度分别显示，native sync/账号新鲜资格不由本地文件推定。普通 writable 文本的替换、并发冲突保留草稿、未知回复刷新恢复和操作页共用后台领域；原生分片保持只读，未资格化的原生写入、附件/fileRef/二进制和完整文件管理仍是 DATA-01 差额。真实浏览器旅程位于 [materials-browser.node.ts](../../apps/web/test/materials-browser.node.ts)，不是原生完整材料已验收。

`/protection` 已读取管理 Server 的默认保护 worker、策略、原/现/历史 Bot 身份、快照元数据及分阶段交接职责。策略修改、并发冲突、权限/CSRF、丢回复刷新与原请求恢复共用 CLI 用例；不从页面调用原生或加载恢复正文。继任激活后仍可发现未完交接，有限历史导航明确省略，不等于旧对象可删除。离开页面后保护继续；真实浏览器场景位于 [protection-browser.node.ts](../../apps/web/test/protection-browser.node.ts)，恢复端和原生事实仍为隔离合成输入。

`/lifecycles` 已接人工 clone/replace/spawn 的原主体保留列表、精确操作查询与交接定位。页面只读，不提供创建/任务发起/续接按钮；同源桥也不开放 lifecycle POST。原操作、scope、计划、阶段和目标分别展示，effect_unknown/未关联目标与当前可用性/退役事实分开；刷新不重新 dispatch，私有指令/profile/恢复正文不加载。[生产浏览器旅程](../../apps/web/test/lifecycle-browser.node.ts)覆盖跨主体拒绝、原生不可用时仍读取历史、handover 链接和窄屏，具体固定验证归 CLI-05。

`/contexts` 已接入当前上下文的真实 head、原操作历史、checkpoint 捕获、初始化/重置/恢复、显式对账/有限取消及独立解除。页面和 `/operations` 共用 CONT 回执；不加载 Memory/原生 blob 正文。旧 revision 冲突保留选择，未知提交刷新后阻止替代写入，续接失败不会把原未知记录降为普通拒绝。首次解除 revision 从原服务回执查回，不存浏览器本地输入。当前源不可用不妨碍独立历史查询，原请求属于其他 Bot 时不重定向操作。真实生产浏览器使用原生 owner/RPC/checkpoint worker 的隔离 schema/账号端口，见 [context-browser.node.ts](../../apps/web/test/context-browser.node.ts)；不作为完整原生现场或视觉定稿签署。

## Host健康与浏览器重复性差额

`/host-health`已分开显示磁盘候选、运行编译、同代原引用注册、详细边界与累计lease机会。当前API只接受现行完整健康/witness合同，不为旧三项规则或window-only事件读面提供兼容；旧资料保留但不充当新成功。四项静态规则和当前有限配对已有资格，整Host/Provider/App与完整机会覆盖仍未证明，不能显示整体healthy。源码与原生/合成范围见[当前收束报告](../reports/2026-09-21-current-host-contract-convergence.md)。

本轮扩大浏览器回归曾有一次180秒子进程超时和一次保护页刷新后继任链接数为0；后续66节点完整通过，但这两次失败根因仍unverified。已保留超时TAP和链接失败时源状态/页面诊断，未放松断言、跳过场景或自动重试提交。后续独立稳定性检查仍需复现并归因，不把单次重新通过当成这两个缺口已修复。

### 保护读面并发调查（2026-09-21）

已将同类链接缺席问题追到原SQLite只读连接的native busy等待：多个读者占满libuv线程时，释放锁的原写方提交也无法执行。真实单线程池反例修前失败、修后通过，80轮并发保护读取通过。修复只在原驱动的只读SQL等待层，不缓存健康/绕过历史读取或重放业务事务。[固定范围](../reports/2026-09-21-sqlite-read-scheduling.md)。此前180秒浏览器超时的确切根因仍未证，不把这次修复扩为所有浏览器稳定性已完成。

同轮进一步复现独立的 `unsafe_path`：原DELETE journal已被unlink，路径检查返回私有同owner但nlink=0的inode。仅sidecar增加一次重观察，不放宽持久库/对象或任何链接/权限检查；7项确定反例及200轮并发读通过，见[后续journal竞态](../reports/2026-09-21-continuity-journal-race.md)。这与busy调度是两项修复，不用后一次绿色覆盖前一次失败。

## 验收

1. 每个页面区域能追到真实能力与来源；跨页定位使用稳定引用，刷新和返回保留声明的导航状态。
2. 必需功能、错误、权限、冲突、未知和恢复在浏览器可操作、可辨识；键盘与窄屏基本可用，不以低保真豁免功能可访问性。
3. CLI/Web 同一操作结果一致；保存不冒充实际采用，ack 不冒充修复，索引命中不冒充源写成功。
4. 完成功能覆盖后进入 LIVE-WEB-FUNCTIONAL；最终配色/布局/动画与视觉体验归 WEB-01/LIVE-WEB-VISUAL，分别记录。

本票不复制领域规则或数据采集；开发中的部分页面不构成对用户的独立可用版本承诺。
