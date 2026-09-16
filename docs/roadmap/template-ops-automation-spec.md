# Template Bot 运维闭环实施规格

**状态：2026-09-16 接受方向后的 Spec-first 施工基线；T43–T50 尚未实现或部署。** 本文拥有「持续监测 → 原生 Webhook 唤醒 grokbox template bot → 有界诊断/主动告警 → 受限静默维护」的专项合同。总运行时树、Server 准入和原生会话语义仍归 [主 Spec](box-runtime-impl-spec.md)；来源识别归 [HSO](host-seam-ops-recognition.md)，观察/incident 归 [T41](../tickets/T41-continuous-observation-and-alerting.md)，唯一 Host 控制与持久服务归 T28/T40。本文不是另一套 modeld、Agent loop 或 Host updater。

[决策与旧规则衔接](../decisions/2026-09-16-template-ops-automation.md) · [Tickets](../tickets/README.md#template-ops-automation) · [操作与故障手册](../maintainers/template-ops-automation.md)

<a id="scope"></a>
## 1. 用户结果、范围与实施授权

用户可以只使用自己的 grokbox template bot，而不必盯 CLI 或打开网页：已识别但不能安全静默处理的问题，由 Bot 主动说明影响、证据、已做动作和下一步；可重复的只读排障自动完成；满足有限规则且已有用户预授权的极低风险维护，可以安静完成并留下可查询回执。静默不等于无记录；无法处理不等于静默丢弃。

本次交付仅为 Spec、Tickets 与文档。没有创建真实 Webhook/routine、发送消息、安装常驻进程、下载升级、改现役 profile、发模型请求或授予部署范围内的自动执行权。实现时也必须将「功能代码存在」「本安装已配对」「用户已授权」「当前组合已资格化」「实际动作已验证」分别表示。

v1 首个纵切是单安装的 Host/source/profile/preload/modeld 协议变化和监测失联；已有 T41 incident 可共用同一 Bot 通知出口。用封闭的 source adapter 注册表容纳以后更多监控来源，不先建多租户事件平台、跨盒控制中心、任意公网 webhook ingress、第二定时调度器或通用远程 shell。原生 Webhook routine 是唤醒入口，不是本地高频采样定时器。

模板 Bot 保持官方模型，不给自己分配 custom model。它仍可能与被维护 Host 共用故障域，因此不是唯一安全控制器，也不能承诺在整个 Box/官方服务离线时主动通知成功。

<a id="baseline"></a>
## 2. 已核实的仓库基线与待验证上游能力

基于 v2 提交 `43166b6` 检查；这些是代码事实，不是实时部署承诺。

| 当前代码事实 | 依据与边界 |
|---|---|
| 模板内只有按需加载 skill，routines 为空 | [recipe](../../scripts/templates/grokbox.recipe.json)；本轮不将未实现能力塞入生产模板 |
| Recipe 类型含 routines，但 pack 不导出真实原生任务 | [template-recipe.ts](../../packages/cli/src/template-recipe.ts)：`packAgentRecipe()` 将 routines 置空；描述性 routine content 不能证明 webhook trigger/secret 可导入 |
| CLI 有 template pack/stage/publish/import | [template.ts](../../packages/cli/src/commands/template.ts)；没有已资格化的本闭环 routine 配对/投递程序 |
| profile watch 仍是 one-shot | [watch.ts](../../packages/box-runtime/src/internal/ops/host-seam/watch.ts) 与 [CLI test](../../test/host-upgrade-watch-cli.test.ts)；无常驻采样承诺 |
| Sense 数据模型存在，但 CLI profile status 未接真实 sense 输入 | [seam-status.ts](../../packages/box-runtime/src/internal/ops/host-seam/seam-status.ts)、[runtime.ts](../../packages/cli/src/commands/runtime.ts)；未知不是安全 |
| runtime 先整源 SHA、唯一字面应用、最后 transformed SHA | [profile.ts](../../packages/box-runtime/src/internal/host/profile.ts)、[compile-hook.ts](../../packages/box-runtime/src/internal/host/compile-hook.ts)；内存注入不是磁盘覆写 |
| 两个 knife replay、19 个 envelope 窗口不是完整能力覆盖声明 | [replay.ts](../../packages/box-runtime/src/internal/ops/host-seam/replay.ts)、[envelope-windows.ts](../../packages/box-runtime/src/internal/ops/host-seam/envelope-windows.ts)；以实际 profile 切片集合为准，不把观察片与执行片混算 |
| 当前 reconcile 无 Host 变更权，显式 apply 才执行 | [controller-operation.ts](../../packages/runtime-kernel/src/internal/commands/controller-operation.ts)；不复活旧 `observeAndHeal` |
| Host lifecycle 有 running gate，但 upgrade 入口未共用它 | [operator.ts](../../packages/cli/src/commands/operator.ts)；自动执行前必须统一，不能定时拼接 `upgrade --yes` |
| T41 有磁盘 SQLite、incident 与 local-only 通知决策 | [monitor.runtime.ts](../../packages/box-runtime/src/internal/roots/monitor.runtime.ts)、[monitor-store.node.ts](../../packages/box-runtime/src/internal/io/monitor-store.node.ts)；本地提交不是原生 Bot/用户交付 |

**上游前提：** 用户确认 Grok Bot 的 Webhook 定时任务能够接收 Payload。本设计采用这个产品能力，而不是重新发明它。但当前仓库不足以证明具体创建/读取/禁用接口、认证方式、原始 Payload 到 Bot 的形态、大小限制、响应含义、重试、克隆/导入以及调度行为。T43 必须输出有界兼容 adapter 与合成测试；不得猜 API、将普通 `routines[].content` 当作完整导出，或把 GitHub 等其他产品的 Webhook 行为当上游事实。

T43 的 live 证据只能来自另获批准的一次性测试 Bot/任务与无害合成 Payload；源码研究保持私有，公共仓库只留最小接口事实与合成夹具。没有 live 权限时仍完成合同/fixture，原生状态保持 `unqualified`，后续 Fake 纵切可继续。

<a id="authority"></a>
## 3. 权威、信任与角色

| 角色/事实 | 唯一职责 | 禁止权限或推论 |
|---|---|---|
| 用户/安装策略 | 绑定安装、账号作用域、精确 Bot 和动作类；批准/撤销预算 | 模板导入和名字相同不是自动授权 |
| 本地 collector / HSO | 采样、换代证据、留存与失效通知 | 不收 provider secret、不发 Host 信号、不自动 approve profile |
| T41 observation writer | observed transitions、incident、通知 outbox/inbox 与交付状态 | 不写 activation、grant、模型配置或 controller 结果 |
| grokbox template bot | 从本地证据复核、选择有界诊断、提出 plan、解释/报告 | Payload/模型评分/自然语言「已批准」不是许可；不直接 signal、清 circuit、改产品数据库 |
| Policy/qualification 程序 | 确定性规则、证据完整性、预授权与时效交集 | 不依靠 LLM confidence 阈值授予权力 |
| 唯一 controller | 复核、串行执行、退出/恢复、读回与 operation 结果 | 不从通知已读或诊断成功推断变更已完成 |
| 原生 Webhook/官方 Bot 运行时 | 接收唤醒并执行受控任务、通过原生用户交付路径报告 | HTTP 接收不是运行完成；Bot 文字不是执行收据 |

同一 UID 的恶意进程或拥有任意 shell 的 Agent 不在本地 hash/文件权限可以隔离的威胁模型内。Prompt 中写「只读」不是安全沙箱。自动 Webhook 诊断必须验证原生工具 allowlist/权限隔离或使用只暴露有限 typed 工具的执行面；无法证明时，降级为固定只读报告，不向该 Bot 暴露维护 capability。人工日常使用官方 Bot 的权限不自动借给不可信 Payload。

Payload、上游状态文本、日志片段和 LLM 结论都是数据，不是指令。payload 不携带 shell、任意路径/URL、replacement 源码、credential、模型正文或用户 transcript；外部 source 也只能提交有身份的信号。真正采取动作前只能读本机权威证据和当前策略。

<a id="chain"></a>
## 4. 一条端到端主链

1. T41 的已授权长期 Scope 组合 HSO collector：目录事件只标 dirty；周期 backstop、重启、PID/作用域变化触发完整只读对账。区分 advertised / staged / installed / loaded；不调用官方更新 RPC 来探测。
2. HSO 固定源字节、完整性与安装 episode，写其原有 provenance。T41 用来源 cursor/receipt 引用提交 incident 与待通知 outbox；跨两个 store 不假装原子，按稳定 receipt ID 重读/幂等索引，崩溃可补齐。
3. 本地纯规则先合并/分级：无变化不唤醒；重复同 incident 更新 lastSeen；确定性且预授权的已资格化维护可不调用模型。需要解释、诊断或批准才进入 Bot 通道。
4. 投递器从已提交 outbox 领取有租期的记录，只向本安装固定的原生 Webhook 目标投递 allowlisted envelope。网络不占 SQLite 写事务；超时先记 unknown，不把它等同于未唤醒。
5. Bot 被原生任务唤醒；只使用不可猜的 delivery reference 调用受控 `claim`。本地检查真实记录、安装/账号/精确 Bot/routine/bindingRevision、过期、schema、去重与预算，再返回安全 evidence summary。Webhook 文本不具有执行授权。
6. Bot 可调用有限只读诊断或已有固定 playbook；每个工具调用重新检查 lease、作用域与预算。输出 diagnosis，选择 report / request-approval / propose-plan / no-action；这不是任意自动改代码。
7. 需要维护时，policy 程序取当前 grant、qualification 和 evidence，生成不可变 plan；Bot 只提交候选，不能自己传 `confirmed:true`。grant 的动作类、目标、时效与预算必须覆盖整个 plan。
8. plan 持久化进入现有 controller operation 存储后，Bot 结束本次唤醒，不等待 Host 重启。独立于 Bot/modeld 的维护调度 Scope 领取 plan，按唯一 controller 执行；先确认 Bot 回合及相关原生子任务确已终结，再进入维护屏障。
9. controller 完成当前源/进程复核、原生 admission/drain、切换和 read-back。marker/HTTP ready 不代替 actual loaded tuple 或功能验证；失败、partial、unknown、退出受阻分别保存。
10. T41 索引确定的控制收据，生成完成/失败通知。Bot 恢复后 claim 并解释；静默成功只入时间线或用户选择的摘要，失败和需决定事项主动告警。交付状态与 incident resolution 各自推进。

如果 Bot 或 Host 已经不可用，监测仍保留 incident/outbox；合法且预授权的确定性保护可以不等 Bot 解释。没有已资格化的处置则不动，保留本地故障与通知欠账。整个 Box 离线只能由另配的外部观察者发现；v1 不引入该外部服务，也不宣称原生 Webhook 可以穿透所有故障域。

<a id="payload"></a>
## 5. Webhook envelope、认证与交付合同

以下是 **grokbox 自己的 v1 消息体**，不是声称上游已接受的 API DTO；T43 负责投影到真实 native payload。示例标识均为合成值。

```json
{
  "schemaVersion": 1,
  "kind": "grokbox.ops.notification",
  "deliveryId": "delivery_example",
  "installationId": "installation_example",
  "bindingRevision": 1,
  "incidentId": "incident_example",
  "incidentRevision": 3,
  "episodeId": "episode_example",
  "sourceKind": "host-seam",
  "intent": "diagnose-or-report",
  "createdAt": "2026-09-16T12:00:00Z",
  "expiresAt": "2026-09-16T12:15:00Z"
}
```

生产 deliveryId 使用至少 128-bit 不可预测标识，但它仍只是索引，不是独立 bearer 执行许可。只传小 envelope；本地 evidence 另读，过期/不存在的 reference 不去任意 URL 取回。schema 未识别、额外危险字段、错 scope/目标或旧绑定拒绝，拒绝不自动再唤醒。

发送端只消费用户配对的受保护 secret reference。HTTPS 校验开启、重定向默认拒绝、地址变更重新配对；端点允许范围由经过资格化的原生 adapter 定义，Payload 不能覆盖。URL 可能自身含 secret，原值不得进入日志、模板、普通状态或 git；不会复用 Gateway/provider 凭据。原生支持签名/时间戳时按其真实合同验证；不支持时不得伪称 HMAC 已验证，使用原生认证加本地记录/作用域复核，并将发送者信任降为明确能力字段。

外部任意第三方监控接入不是 v1 公网入口：先经明确认证、schema 与 source 授权的 adapter 产生本地事件，再走相同出口。无法在模型唤醒前阻断伪造流量时，要披露原生 endpoint 滥用/推理成本风险，并禁用不合格的自动模式。

交付至少分开：

```text
outbox: queued → attempted → accepted | failed | unknown | expired | superseded
bot:    unclaimed → claimed → diagnosed → report-prepared → reported | report-unknown
action: proposed → approved → waiting-safe-boundary → running → verified | partial | unknown | blocked
```

`accepted` 只能表示资格化 adapter 所证明的接收层级；没有原生 receipt 时不填 queued/run。`reported` 需要与该 delivery/报告相关联的原生 SendToUser/交付证据；无客户端显示/已读能力时明示 not_observed，不声称用户看到了。人工 ack/snooze 不是投递 ACK，也不解决故障。

同一 incident/发生周期/通知阶段使用稳定 deliveryId；重试不制造新任务身份。Bot claim 事务去重并带租期；崩溃后复领先对账诊断/报告/控制阶段，不重放未知动作。native endpoint 无幂等时，重复唤醒和额外推理仍可能发生；只能使本地处置幂等，不能承诺 exactly-once inference。unknown 默认先查可用原生状态；无查询与无幂等时按明确的「允许重复告警」策略有限重试，绝不借重试重新执行维护。

<a id="policy"></a>
## 6. 自动化等级与低风险资格

critical、保护受阻或需要用户决定的事件，Bot 可运行时先报告已确认的影响/缺口，再做深入诊断；诊断失败/超预算不得吞掉初始告警。模型或原生通知通道不可用则保存未交付事实，不谎称已报告。维护收据只推进同 episode/plan 的通知阶段，不把自己制造的告警重新变成一个新维护计划。

安装默认为 `off`；显式配对可启用 `notify` 或 `diagnose`。`maintain-low-risk` 是独立 opt-in grant，包含 installation/scope/bot、action classes、policy revision、有效期、速率、维护窗口和撤销方式。模板不能预装有效 grant。只有用户在受信管理入口建立 grant，Bot 与 Payload 均不能扩大它。

| 等级 | 可做的事 | 不可越过的门 |
|---|---|---|
| notify | 汇总已存在的安全事实、主动报告 | 不运行任意排障脚本或维护 |
| diagnose | 有界只读 doctor/status/incident、源码/加载证据分析、离线 replay；生成候选 | 需已证明的工具边界；不自动改配置、发模型探针、清队列或终止 Bot |
| maintain-low-risk | 指定已资格化动作类的轻量维护；允许 Bot 辅助判断，但程序决定资格 | grant ∩ qualification ∩ 当前事实 ∩ 安全执行条件；任何 unknown 不升级为 true |
| human-required | 改语义/切片、变协议、变 provider/数据去向、强制打断、修改官方更新策略 | 用户对具体不可变 plan 另行批准；批准仍不能绕过 source/ownership/完整性硬门 |

**不是所有新 SHA 都必须重新人工点一次，也不是所有新 SHA 都能自动处理。** 接受以下可施工动作类，逐类资格化和启用：

- `observe-reconcile`：补采样、生成纯派生分析、对齐已存在事件索引。仍受 IO/保留规则约束，不偷偷删证据。
- `realign-qualified-generation`：当前实际安装组合已具有本策略承认的完整资格，重新应用已批准 recipe/preload 或恢复同代加载。不能自动变更 npm 依赖/模型分配/官方 Host channel。
- `derive-equivalent-profile`：对新源码用**已经批准的 recipe**派生新的 exact-SHA profile。必须有版本化规则证明所有生效执行片、其依赖闭包和必要 companion/sensor 合同未发生相关变化；仅外围布局偏移或已界定非语义字节变化可入选。所有实际生效切片纳入清单，少片/缺依赖/解析失败/动态依赖不可界定即拒绝。LLM 可提出该类别或否决，但不能代替证明。
- `exit-patch-at-safe-boundary`：仅在明确预授权的保护原因与退出策略下，拒绝新的受影响 managed admission，安全排空后回到当前官方安装的未注入 Host。不是执行留存旧 Host 或偷偷把本 STEP 换供应商。退出不自动清掉用户的模型选择；后续行为须按授权策略明确阻止 custom 或允许未来新回合用官方通道。

每个 QualificationRecord 绑定 source/必要 companion digest、profile/recipe/patch-set digest、preload build、modeld wire 与相关构建、rule/test revision、证据覆盖、作用域和失效条件。support/compile/loaded/behavioral evidence 分列，不输出一个掩盖缺口的绿色 compatible。任何关键依赖变化、上游 swap/rollback 线索、policy 撤销或新 evidence 否决都会取消可执行资格。

机械全通过仍可能遗漏语义依赖；因此自动等价规则只有在独立负例证明能拒绝「锚点未变但调用顺序/状态/取消/工具相关性已变」之后才可列入 grant。覆盖边界不可证明时只告警并准备候选，不以“差异很小”或“高置信度”强行上线。

Profile 发布保持唯一 writer、固定源、全 ordered apply 与 transformed SHA。扩展 publisher 增加 `approvalSource: human | qualified-policy`、policy/qualification refs 与 expected current profile digest 的 CAS；现有人工入口不自动获得 policy 权限。发布与 adopt 分开记事实；发布后安装代次变了就 supersede，不趁机应用旧计划。移位本身不触发误报；语义变化本身不能被窗口数量掩盖。

<a id="execution"></a>
## 7. 安全执行、交接与退出

不可变 MaintenancePlan 至少绑定 planId/intent、installation+scope、installed/loaded 元组、目标 profile/preload、qualificationRef、policy revision、预计影响、到期时间、回退/退出策略、预算与 expected current configuration。审批绑定整个 plan digest；修改任何字段都产生新 plan 并重新授权。

控制入口统一为已有 controller program 的扩展。所有 host start/stop/restart、upgrade、re-adopt 与 policy apply 共用同一实时 admission/drain 预检；CLI 外壳不是安全门的唯一落点。`reconcile` 永远无 Host mutation；新增 policy 模式不能通过伪造 `confirmed:true` 借用人工授权。显式人工确认与机器预授权具有不同、可审计的 provenance。

光看 roster 一次 idle 不消除竞态。自动 Host 切换（不含只读重采样、离线候选生成）要求已经资格化的原生暂停/排空能力或等效 admission fence，取得可关联当前 Host generation 的屏障，再复核父回合、待审批、原生监听子任务、工具/流/压缩、managed active steps 和未决 controller operation。缺屏障、分页不完整或 unknown 时不自动中断；等待到预算后告警。不要把 child-only Working 简化成一个布尔值，也不能为达到 idle 自动取消用户任务。

模板 Bot 提出计划后先完成持久交接并退出。调度器不能把提出者自身从 running 清单里忽略；必须观察其回合终结。维护完成通知在屏障解除、Host 健康后发送，避免每发一个告警就再次制造 busy。Bot 不等待后台子任务来盯自己的重启。

实际变更在 root-scoped 串行控制 lease 内执行；重新读取 source/进程 PID+start/拓扑/配置/授权，沿用 independent guardian、部分前缀、源复核与读回。grokbox 锁不锁官方 updater；任何检测到的 mixed/transition/superseded 均停止推进。不能把两次稳定 hash 当成整个官方包发布的排他锁。

默认每安装仅一个在途 Host 变更；同 plan 一次 mutation attempt。动作开始后的超时/取消/服务重启先恢复 operation 事实，不自动重发 signal/spawn。无法证明完整退出则 `rollback_unverified/blocked`，不得称 official 已恢复。确定性退路也必须在原 grant 范围内；不能无限循环 patch → rollback → patch。

既有 open circuit 不能自动关闭；未知/存量 circuit 原因要解释，不和 source mismatch 或模型分配错误混为一谈。自动化可撤销自己的未执行资格或 inhibit，但不得篡改旧 controller/Host 事实。退出不删用户数据、不覆写官方 source、不执行 corpus、不升级官方 image、不清官方 ack、不改 Server harness。

<a id="storage"></a>
## 8. 状态存储、资源预算与 Effect

| 内容 | 唯一 owner / 位置 |
|---|---|
| 源码、profile 副本、机械 replay/qualification 派生证据 | HSO 受保护 provenance 根；资格引用证据，不复制私有源到 git/通知 |
| 配对绑定与 grant | `${durableRoot}/ops-policy.json`，通过 ConfigurationWrite 扩展的唯一校验/CAS writer；只存 secret refs，不存 URL secret 明文 |
| incident、通知 outbox、claim、诊断/报告状态 | T41 同一个 observations.sqlite 的扩展事务与迁移；不另开 webhook.db |
| 不可变 plan、operation/进度/恢复 | 现有 controller operation store 的扩展；不是把激活权交给 observation DB |
| 命令/Host/modeld 事实 | 原有 writer 不迁移；T41 只索引结果，保持 J13 与独立 guardian |

通知事务先提交再发送；网络与模型诊断不持 SQLite 写锁。跨 HSO、T41、policy、controller 的推进使用幂等引用与 CAS，承认部分提交，不宣称 Effect Scope 是跨库原子事务。过期 plan、被撤销 grant 和 tombstone 不能因备份恢复而复活；恢复后更换 observer/binding epoch，重新配对或复核后才有发送/执行资格。

下列为本专项 v1 **默认策略预算**，不是上游 SLA，也不是当前程序已实现参数；代码只在 kernel 的一个 policy owner 定义，CLI/skill 不复制常量。HSO 既有采样预算复用，不顺带改 modeld 或 T41 Server 准入预算。

| 预算 | v1 初值/处理 |
|---|---|
| source 事件合并 / metadata / hash backstop | HSO 的 250ms / 30s / 60s；启动、重连与换代强制 resync |
| envelope | 最大 8KiB；长证据本地引用，拒绝静默截断 |
| 通知在途 / 原生请求 | 每安装 1 个请求、单次 10s；正常最多 6 次/小时，critical 独立保留 2 次/小时；合并/抑制要有记录 |
| 有歧义重试 | 默认 unknown 不盲重发；启用允许重复通知后最多 3 次/条，退避 30s、120s，上限仍服从小时预算 |
| Bot 诊断 | 每安装 1 个活动 claim，最多 2 轮 × 8 个只读操作，总 120s；每次工具调用受同一 lease 校验，超时报告 partial |
| 模型成本 | 默认被动监测 0 模型调用；Bot 诊断使用安装时明确批准的原生推理/消费预算，不可证明的原生 token 上限必须标 unknown，不冒充硬配额 |
| plan | TTL 15min；最多等待安全边界 10min；一次动作预算由已资格化 action 定义，默认总 120s；超过后对账，不追加 mutation |
| Host 变更 | 每安装最多 1 在途、每小时最多 1 次；同组合失败隔离，只有新证据或人工解禁才能新试 |
| 存储 | 未终结通知软目标 1000 条/16MiB；合并同周期，受保护 critical/unknown 不静默删除；达到硬存储不可用则暂停新外发/自动维护并记录 gap，已有推理不依赖本库 |
| 保留 | 已结算交付/诊断默认 14 天，幂等 tombstone 至少 30 天且覆盖 retry/恢复窗口；未决 operation/critical incident 依 owner 保护；超过保留的查询明确 gap |

Effect 固定仓库 `4.0.0-beta.107`；Node 发布下限和 Bun 锁不随本方案升级。collector、投递 lease/退避、诊断期限、资格 worker、维护调度使用各自宿主 Scope 的有界子 Fiber/队列；Fake/Live 替换 port，不复制程序。preload/Host 不导入 Effect、SQLite、Webhook 客户端、ops policy 或模型 SDK。取消、expected failure、defect 与 unknown outcome 不合并为空成功。硬崩恢复不能依赖会随父进程死亡的 Fiber。

<a id="layout"></a>
## 9. 最小目标骨架与 ports

下面是要实现的目标路径，不是当前文件已存在清单。保留三个现有 npm/workspace 边界，不新增安装包、服务框架或通用插件系统。

```text
packages/runtime-kernel/src/
  ops.ts                              # 本专项窄 DTO、纯规则及用例导出
  ports.ts                            # 扩展有限 NotificationTransport / OpsEvidenceRead / OpsState 能力
  internal/ops/
    policy.ts                         # grants、预算、动作准入；唯一 policy 常量
    notification.ts                   # envelope/交付/claim 状态规则
    qualification.ts                  # 组合身份、覆盖与失效/等价规则
  internal/commands/
    ops.ts                            # claim/diagnose-plan/submit 用例；不拥有原始 signals
    controller-operation.ts           # 扩展授权 provenance、统一 busy/drain、实际唯一 mutation
packages/box-runtime/src/internal/
  ops/host-seam/watch.ts               # 复用 observe writer 的长期 sensing/重同步
  ops/automation/
    notify.ts                         # outbox 驱动与投递 Effect 程序
    diagnose.ts                       # 有界只读工具执行；不运行任意 shell
    qualify.ts                        # 调现有 replay/profile 规则，不执行留存 Host
  io/
    ops-policy.node.ts                # 经 ConfigurationWrite 的 binding/grant IO
    template-notify.node.ts            # 固定目标 HTTP adapter、secret refs、网络安全
    monitor-store.node.ts             # 原库迁移：outbox/inbox/诊断，不新增 DB owner
  roots/
    monitor.runtime.ts                # 既有观测宿主中组合 HSO + 通知子 Scope
    ops.runtime.ts                    # 独立 Bot/modeld 的受限计划调度；只调用唯一 controller
    controller-program.node.ts        # 原 controller Live ports/存储扩展
packages/cli/src/
  gateway-automation.ts               # 隔离已资格化原生 routine CRUD，不向内核泄漏私有 DTO
  commands/ops.ts                     # 薄参数/输出入口，调用同一程序
  template-recipe.ts                  # blueprint 处理与安全导入能力校验
  skills.ts                          # 实现后注册 ops 进阶主题
skills/grokbox/ops.md                 # 实现后才进入安装包，按需加载
scripts/templates/grokbox.recipe.json # 实现后加入无绑定、无 secret 的 routine blueprint
```

NotificationTransport 的 canonical 合同描述固定已绑定目标的投递/可用回执，不接任意 URL；OpsEvidenceRead 只返回 allowlisted 快照与诊断数据；OpsState 通过既有 monitor store 提供 claim/交付事务。controller 仍消费 ControlResources；不另定义第二个 Promise/Effect 控制接口。native routine 创建/配对由 CLI 宿主装配，box-runtime/kernel 绝不 import CLI。

长期观测与受限维护是两个权限不同的进程角色，可以同一包发布，但 collector 无 signals。`ops.runtime.ts` 不是第二个 reconciler：它不实现注入/停止流程，只领取已批准计划并调用已有 controller。T40 负责真实安装、自启/停止；不假设 systemd 存在，不修改官方 supervisor，不让 Bot 自己 nohup 一个 loop。

<a id="surface"></a>
## 10. 用户与 Bot 的目标命令面

以下为 **T43–T50 计划新增，当前不可直接运行**。具体 JSON/schema/错误码由同一 kernel 程序导出；不存在通用 `exec` 参数。

```text
runtime ops status                     # 只读：binding/collector/delivery/diagnosis/policy/action 六面
runtime ops bind / unbind               # 精确 Bot+scope，secret 安全输入，显式确认/CAS
runtime ops policy show / set / revoke  # 用户授权；Bot 无扩大 grant 能力
runtime ops claim <delivery-id>         # 受控 Bot 工具，真实记录/作用域/租期检查
runtime ops diagnose <delivery-id>      # 有限只读 playbook，不接受任意 shell/URL
runtime ops plan <delivery-id>          # 不可变候选；尚无执行权
runtime ops submit <plan-id>            # 策略核验与持久交接，不等待 Host 重启
runtime ops approve <plan-id>           # 受信用户对 exact digest 批准，仍需安全硬门
runtime ops outcome <plan-id>           # 原 controller 事实，不从 Bot 文本推断
runtime ops run                        # 显式受监管维护角色；不因 status 自动启动
```

T46 以实际能力探测决定蓝图安装：优先原生模板安全携带禁用的 routine 描述，导入后为本安装创建独立 endpoint 并激活；若原生模板不能保证禁用/新密钥，则不携带已激活任务，随模板发 bootstrap skill，在用户配对后通过官方接口创建。两者实现同一产品结果，不从原 Bot 复制活 endpoint、token、installId、grant 或旧投递记录。

模板入口保持小：只有收到合法 ops 触发才加载已安装版本的 `--topic ops`。本次文档不新增该主题到实际 skills 清单，避免 Bot 提前调用不存在的命令。用户报告固定说明「发现了什么、可信度/缺口、实际已做什么、为什么不能静默、需要何种决定」；无动作、等待边界、unknown 和成功分开，不把告警本身当用户新指令。

<a id="tickets"></a>
## 11. 施工顺序与证明

| 阶段 | Ticket | 可独立交付的退出 |
|---|---|---|
| 合同与上游验证 | T43 | 原生 Webhook 能力表、版本化 adapter、合成 envelope/交付测试；缺 live 证据明确保留 |
| 连续事实 | T44 | HSO → T41 采样/失效/incident，只读权限闭合 |
| 可靠唤醒 | T45 | 固定目标通知 outbox → Native Webhook → claim/报告回执；unknown/重复不放大动作 |
| 可分发模板 | T46 | 禁用蓝图、安装配对/撤销、克隆隔离、进阶 skill，官方模型不变 |
| 自动排障 | T47 | 受限工具、有限诊断、报告/候选分流，无运行中维护 |
| 低风险证明 | T48 | 全切片/依赖覆盖、等价规则、预授权 profile 发布、stale 拒绝 |
| 唯一受限执行 | T49 | 同 controller 的统一 drain、持久 handoff、policy apply/退出、恢复和验证 |
| 持久运行与验收 | T50 | 显式安装/权限隔离、故障演练、原生用户旅程、签署范围与退场 |

依赖：T43 后 T44/T45 可并行；T46 依 T43/T45 的可用合同，T47 依 T44–T46；T48 可在 T43/T44 后离线并行；T49 依 T48 与 T47 的交接合同，并在 T28/T40 当前能力上增量施工。T50 的观察/通知部署可先验，自动维护须等 T49。任何票不要求 T40/T41 整票先 Done；它们的当前实现与限定缺口是能力依赖，避免循环等待。

测试目标由各票定义，默认 Fake upstream/clock/通知与 disposable 本地进程；公共 CI 不执行私有 Host 或真实模型。新增 `verify-runtime-rebuild` 的 `template-ops` 组只在有对应测试后注册，必须区分 offline/source/packed/native。上线需独立复核以下反例：错 scope/克隆 token、重复乱序/ACK 丢失、Bot 崩溃后复领、锚点不变但语义坏、helper-only 变化、A→B→A、maintenance Bot 自占 busy、新任务撞上 drain、取消后的未知 signal、退出失败、通知成本耗尽、observer/DB/Box 离线。

先交付 monitor→Webhook→Bot 的只读真实纵切，再开放单动作类 canary；不能用全仓测试绿代替 native endpoint/任务/SendToUser/进程切换证明。每次验收声明固定构建、已启用动作类、安装范围、证据缺口与撤销路径；不在公共文档存现场 secret、真实 Bot 标识或原生私有源码。

## 12. 参考与失效条件

Node 对 fs.watch 的 inode/rename 限制支持「事件 + backstop」的设计，不证明上游发布原子性：[Node fs caveats](https://nodejs.org/api/fs.html#caveats)。Webhook 的认证、及时接收后处理、delivery ID 等通用工程参考：[GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) 与 [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。这些不是 Grok Bot 的协议文档；不照搬其 header、超时或自动重投语义。

原生 routine/模板复制行为、Payload 投影/认证、Host/component/recipe、modeld wire、工具权限、存储 schema、用户 scope/授权改变时，复核本 Spec 对应资格而不是复用旧绿灯。实现事实继续由 source/tests 与限定 live 收据拥有；本页只拥有此专项的施工合同。
