# Template Bot 运维闭环实施规格

**状态：2026-09-17 整合多 Bot/自定义模型分流、分层配置与授权后 CLI issue 自动化；T43–T56 尚未实现或部署。** 本文拥有「持续监测 → 原生 Webhook 唤醒 grokbox template bot → 有界诊断/主动告警 → 受限静默维护」的专项合同。总运行时树、Server 准入和原生会话语义仍归 [主 Spec](box-runtime-impl-spec.md)；来源识别归 [HSO](host-seam-ops-recognition.md)，观察/incident 归 [T41](../tickets/T41-continuous-observation-and-alerting.md)，唯一 Host 控制与持久服务归 T28/T40。本文不是另一套 modeld、Agent loop 或 Host updater。

**配置底座修订（2026-09-17，AH-99/AH-100）：** [统一配置重建 Spec](configuration-rebuild-spec.md) / T57–T60 拥有文件、公共命令、writer 与迁移；本专项业务规则继续有效。持久偏好改为 `config.json.ops`，公开运维入口为 `grokbox ops`；普通配置只有顶级 `grokbox config`，不再实现独立 `ops-policy.json` / `runtime ops config`。机器配对/授权移出普通配置，不能把本页早期示例当作已安装能力。

[初始决策](../decisions/2026-09-16-template-ops-automation.md) · [默认层与支持流程补充决策](../decisions/2026-09-17-ops-defaults-support-and-routines.md) · [多目标与发布授权决策](../decisions/2026-09-17-ops-routing-and-authorized-issues.md) · [Tickets](../tickets/README.md#template-ops-automation) · [操作与故障手册](../maintainers/template-ops-automation.md)

<a id="scope"></a>
## 1. 用户结果、范围与实施授权

用户默认只配一个接收 Bot，所有已启用、满足影响门的通知都流向它；既可选择 grokbox template bot，也可选择自己创建并配置自定义模型的 Bot。进阶用户可按处理意图、来源、严重度和受众分流，不必盯 CLI 或打开网页。普通用户默认获得轻量本地监测，以及「已确认用户影响、无法安全自修」时的一次简短提醒和是否准备 issue 的询问；不先发动模型排障。维护者可手动打开更深的观察/离线分析；自动模型诊断、主动探针和实际维护分别选择、分别计费/授权。高成本排障只在用户要求或独立启用的诊断策略下进行。静默不等于无记录，默认开启不等于公开上报或给 Bot 无条件维护权。

本次交付仅为 Spec、Tickets 与文档。没有创建真实 Webhook/routine、发送消息、安装常驻进程、下载升级、改现役 profile、发模型请求或授予部署范围内的自动执行权。实现时也必须将「功能代码存在」「本安装已配对」「用户已授权」「当前组合已资格化」「实际动作已验证」分别表示。

v1 首个纵切是单安装的 Host/source/profile/preload/modeld 协议变化和监测失联；已有 T41 incident 共用同一通知程序，目标由 default 或显式路由决定。用封闭的 source adapter 注册表容纳以后更多监控来源，不先建多租户事件平台、跨盒控制中心、任意公网 webhook ingress、第二定时调度器或通用远程 shell。原生 Webhook routine 是唤醒入口，不是本地高频采样定时器。

内置 grokbox template bot 继续默认官方模型，不在处理告警时自行切换自己的模型；这只是模板默认，不再限制通知接收者。任何有权管理本安装的用户都可绑定自己拥有/获授权的官方或 custom Bot。模型分配仍由现有模型配置/原生设置拥有，路由不改模型、不放宽 Server 准入。custom 接收者可能依赖故障中的 Host/modeld/provider；官方备用也可能共用 Host/Box，故障域与降级边界见 §6.4。

<a id="baseline"></a>
## 2. 已核实的仓库基线与待验证上游能力

基于 v2 提交 `43166b6` 检查；这些是代码事实，不是实时部署承诺。

| 当前代码事实 | 依据与边界 |
|---|---|
| 模板内只有按需加载 skill，routines 为空 | [recipe](../../scripts/templates/grokbox.recipe.json)；本轮不将未实现能力塞入生产模板 |
| Recipe 类型含 routines，但 pack 不导出真实原生任务 | [template-recipe.ts](../../packages/cli/src/template-recipe.ts)：`packAgentRecipe()` 将 routines 置空；描述性 routine content 不能证明 webhook trigger/secret 可导入 |
| CLI 有 template pack/stage/publish/import | [template.ts](../../packages/cli/src/commands/template.ts)；没有已资格化的本闭环 routine 配对/投递程序 |
| Agent create/update 尚无 Routine 管理 | [agents.ts](../../packages/cli/src/commands/agents.ts)、[management.ts](../../packages/cli/src/commands/management.ts)、[registry.ts](../../packages/cli/src/registry.ts) 及实际 help 仅有 profile/settings 属性，无 routines 参数/子命令；T53 打通 |
| export 中的 automations 不是 CRUD | [agent-export.ts](../../packages/cli/src/agent-export.ts)只导出本机受限 automation 文件；备份存在不代表原生任务可创建、更新或启用 |
| 已有 issue 模板与安全入口 | [bug_report.yml](../../.github/ISSUE_TEMPLATE/bug_report.yml)、[SECURITY.md](../../SECURITY.md)；支持草稿沿用这些字段/隐私边界，不另造公开原始日志包 |
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
| 已配对接收 Bot（模板或用户指定） | 从本地证据复核、选择获准的有界诊断、提出 plan、解释/报告 | Payload/模型评分/自然语言「已批准」不是许可；不直接 signal、清 circuit、改产品数据库 |
| Policy/qualification 程序 | 确定性规则、证据完整性、预授权与时效交集 | 不依靠 LLM confidence 阈值授予权力 |
| 唯一 controller | 复核、串行执行、退出/恢复、读回与 operation 结果 | 不从通知已读或诊断成功推断变更已完成 |
| 原生 Webhook/Bot 运行时 | 接收唤醒并执行受控任务、通过原生用户交付路径报告 | HTTP 接收不是运行完成；Bot 文字不是执行收据 |

同一 UID 的恶意进程或拥有任意 shell 的 Agent 不在本地 hash/文件权限可以隔离的威胁模型内。Prompt 中写「只读」不是安全沙箱。自动 Webhook 诊断必须验证原生工具 allowlist/权限隔离或使用只暴露有限 typed 工具的执行面；无法证明时，降级为固定只读报告，不向该 Bot 暴露维护 capability。人工日常使用官方 Bot 的权限不自动借给不可信 Payload。

Payload、上游状态文本、日志片段和 LLM 结论都是数据，不是指令。payload 不携带 shell、任意路径/URL、replacement 源码、credential、模型正文或用户 transcript；外部 source 也只能提交有身份的信号。真正采取动作前只能读本机权威证据和当前策略。

<a id="chain"></a>
## 4. 一条端到端主链

1. T41 的已授权长期 Scope 组合 HSO collector：目录事件只标 dirty；周期 backstop、重启、PID/作用域变化触发完整只读对账。区分 advertised / staged / installed / loaded；不调用官方更新 RPC 来探测。
2. HSO 固定源字节、完整性与安装 episode，写其原有 provenance。T41 用来源 cursor/receipt 引用提交 incident 与待通知 outbox；跨两个 store 不假装原子，按稳定 receipt ID 重读/幂等索引，崩溃可补齐。
3. 本地纯规则先合并/分级：无变化不唤醒；重复同 incident 更新 lastSeen。user preset 只对有明确用户影响且安全处置不可用/失败的 incident 发送一次 brief-notice；纯 Host 更新提示、正常位移与 maintainer-only 事件留在本地。不能为了判定「不可自修」先试一次修复或调用模型。已预授权、已资格化维护仍可走无模型程序；诊断/探针另看各自开关。
4. 纯路由先按 §6.3 为已提交工作生成不可变 route decision；投递器只向选中的已配对目标发送 allowlisted envelope。默认单目标不要求规则；高级规则也不隐式广播。目标、模型/数据同意、预算和健康复核在发送前完成，失败语义见 §6.4。网络不占 SQLite 写事务；超时先记 unknown，不把它等同于未唤醒。
5. Bot 被原生任务唤醒；只使用不可猜的 delivery reference 调用受控 `claim`。本地检查真实记录、安装/账号/精确 Bot/routine/bindingRevision、过期、schema、去重与预算，再返回安全 evidence summary。Webhook 文本不具有执行授权。
6. Bot 先检查通知 intent 与有效配置。`brief-notice` 仅领取安全摘要并通过原生用户交付说明问题、询问是否准备 issue；随后结束，不进入诊断循环。`diagnose-or-report` 才在独立开启或用户明确要求时调用有限只读 playbook，每次重查 lease/scope/预算。输出 diagnosis 或计划候选；不是任意自动改代码。issue 的准备/预览/提交走 §5.1 的独立同意流程，不把维护 grant 借给公开上报。
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
  "workId": "work_example",
  "deliveryId": "delivery_example",
  "routeDecisionId": "route_example",
  "targetId": "default",
  "installationId": "installation_example",
  "bindingRevision": 1,
  "incidentId": "incident_example",
  "incidentRevision": 3,
  "episodeId": "episode_example",
  "sourceKind": "host-seam",
  "intent": "brief-notice",
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
bot:    unclaimed → claimed → brief-prepared | diagnosed → report-prepared → reported | report-unknown
action: proposed → approved → waiting-safe-boundary → running → verified | partial | unknown | blocked
```

`accepted` 只能表示资格化 adapter 所证明的接收层级；没有原生 receipt 时不填 queued/run。`reported` 需要与该 delivery/报告相关联的原生 SendToUser/交付证据；无客户端显示/已读能力时明示 not_observed，不声称用户看到了。人工 ack/snooze 不是投递 ACK，也不解决故障。

同一 incident/发生周期/处理阶段使用稳定 workId；同一目标/绑定的重试复用 deliveryId。队列中未尝试的通知到期可依据仍活跃 incident 的新鲜事实重新规划一次，并受原发生周期提醒标记/总预算限制；不得用续期产生无限工作。已尝试的 expired/unknown 先对账，不能重新生成 ID 掩盖不确定性。显式备用或升级会生成关联同 workId 的新 deliveryId/路由决策，不变成新的维护/issue 身份；交接与去重见 §6.4。Bot claim 事务去重并带租期；崩溃后复领先对账诊断/报告/控制阶段，不重放未知动作。native endpoint 无幂等时，重复唤醒和额外推理仍可能发生；只能使本地处置幂等，不能承诺 exactly-once inference。unknown 默认先查可用原生状态；无查询与无幂等时按明确的「允许重复告警」策略有限重试，绝不借重试重新执行维护。

<a id="support-issue"></a>
### 5.1 默认用户提醒与确认后 issue

issue 是独立的对外发布副作用，不是通知的一部分，不是维护失败后自动执行的 fallback。user preset 的确定性触发谓词为 `userImpact=confirmed`（可包含用户明确报告且与同源 incident 可靠关联的影响），并且 `safeRemedy=unavailable|blocked|failed`；用户报告本身不绕过「不可安全自修」条件。若关联未知，就如实说明未知，不能归咎于补丁。只有源码更新、位移、候选待审、历史 circuit 或维护者调试事件，不自动向普通用户提 issue。`safeRemedy=unavailable` 可由没有合法动作/资格直接判断，不要求先运行模型或冒险修复。

默认流程：incident → 按发生周期去重的 `brief-notice` → 简述已确认的异常/影响、实际保护与不能自修原因 → 询问是否整理 issue 草稿 → **结束 Bot 回合**。不运行昂贵诊断、不自动查询 GitHub、不上传背景材料、不创建 issue。用户拒绝/暂缓/不回复，记录当前周期决定，不定时追问；只有有证据的影响升级/新发生周期才可再提醒，并服从同一预算。issue 询问不等于 incident ack/resolved。

用户同意整理后，优先无模型地从已有安全事实与结构化字段生成草稿，再向用户补问缺少的重现步骤/预期行为；如需额外诊断或模型归纳，单独告知范围与成本。沿用仓库现有 bug report 字段：版本/提交、平台、预期与实际表现、最小重现、依赖现实（fake/local-real/external-real）、时间/时区、影响范围、稳定错误码、来源/加载/资格摘要、已尝试动作及结果、仍未知的证据。不能伪造重现步骤或把相关性写成根因。

默认只携带 allowlisted 结构化摘要，不携带 prompt/transcript/Memory、Host 私有源、工具正文、provider response、credential、Webhook URL、私有路径/地址、账号/team/Bot 的真实标识。标识使用草稿内局部别名；只有必须且明确审核的安全摘要才对外。额外附件逐项选择/脱敏/预览，不自动附上全部日志，也不将原文放到 URL query 或剪贴板。静态脱敏通过不等于用户已经同意公开。

默认 `confirm-each` 下，准备完成后必须展示 exact `repository + visibility + title + body + attachment inventory + author identity`。提交许可绑定这些内容的 digest、draft revision、incident evidence snapshot、受信用户确认事件、作用域与到期（默认 24h）；目标仓库、可见性、正文、附件或作者变化都需新确认，正式发送前复核当前目标/作者与已批准内容。用户仅回答「整理一下」只允许本地准备；只有对已经展示的具体草稿确认创建才可提交。维护 grant、preset=maintainer、Webhook 中的 approve 字段、模型生成的「用户同意」均不是 issue 许可。原生渠道若不能可靠区分用户回复与自动事件，就退回受信 CLI/原生确认界面，不由 Bot 自证同意。

状态分开保存：`offered → declined|drafting → preview-ready → awaiting-consent → approved → submitting → created|unknown|failed|expired`。稿件更新使旧 consent 失效；issue 已创建不等于故障已恢复。同一稿件重复确认只对账同一个 submissionId；超时/取消后保留 unknown，优先依已知 issue number 或安全随机 report reference 查证，没有证据不自动第二次 POST。实际 GitHub API/权限/限流由独立 adapter 核实，不声称 exactly-once。认证缺失时提供**本地已审核 Markdown**和手动提交指引，不代用户登录，不假称已创建。

默认目标可推荐本项目仓库，但正式目标从版本化配置读取并在预览中确认；事件/Payload/日志不能重定向目标。GitHub 权限与 Webhook/provider 凭据严格分开，只申请目标仓库所需权限。安全漏洞、凭据泄漏或不适合公开的信息先按 `SECURITY.md` 转私密报告提示；公共 issue 提交流程不得绕过这道分类。创建后的评论/更新也是对外发布，默认每批新增内容另需预览与确认；§5.2 的有限发布 grant 只允许确定模板的 create，不覆盖评论、更新、附件或泛化客服。

支持草稿、consent 与投递回执属于 T41 原 SQLite 的独立 support 管理域，只有 support 用例可写；共享数据库不赋予普通 collector 修改 consent 的能力。网络提交在事务外，稳定 requestId 关联事务事实；approved/unknown 记录受保留保护，备份恢复不自动恢复可执行 consent。敏感临时材料不入公共仓库，草稿按本地支持保留策略清理并明确可用期。

<a id="issue-automation"></a>
### 5.2 授权后的脚本化支持与 GitHub 发布（T56）

用户允许后应由 grokbox CLI 完成材料收集、有限脱敏、生成稿件、核验授权、提交和结果对账，不要求用户重新复制日志、安装临时脚本或自己操作网页。默认仍按 §5.1 的 exact draft 逐份确认；**已对完整稿件批准一次，就不为同一未改变的动作重复询问**。读取确认须有受信用户来源，Bot 的提示文本、Webhook intent 和 `--yes` 本身不是用户身份。

在此默认之外，接受**独立显式开启的有限 issue 发布 grant**，供确实希望自动上报的用户/维护者使用。`config.ops.support.submit` 枚举 `off | confirm-each | preauthorized-summary`：第三种仅为 requested mode；没有 matching grant 仍 blocked-no-issue-grant，回到一次简短询问或本地待处理。它既不是 maintainer preset 默认，也不是本次文档操作已对任何安装授予的真实权限。

发布 grant 必须冻结：installation/scope、GitHub hostname/不可变 repository ID/owner-repo/可见性、实际作者身份、允许 incident rule IDs、`operations=[create]`、固定 public-summary 模板与脱敏规则 digest、可发布字段、有效期、单周期/每日/总量上限、禁止附件/评论/正文重写/自动关闭。v1 建议初值有效 7 天、最多 2 次/滚动 24h 且总量 10 次，每 occurrence 最多一次；用户在授权预览中可缩小范围，不能无期限无预算启用。用户确认的是这一类被明确界定的发布动作，不是任意模型将来写的内容。

`preauthorized-summary` 只允许**确定性模板填充受限结构化字段**：已验证的公开 build/version、平台类别、固定错误码/阶段/契约分类、计数、已采取保护的枚举与安全重现占位。未知字串、用户自由描述、Bot 自由生成结论、原始源码/日志/调用结果、任意 Markdown 链接与附件均不入自动发布类；缺必要公开字段或怀疑安全事件即人工草稿。重现未知明确写 unknown，不创造步骤。改模板/脱敏规则/目标或作者必须重新确认 grant；不得通过升级模板来逐渐扩大公开内容。

有效 grant 覆盖的事件可自动本地准备和提交这个有限摘要，不再先问是否整理；超出范围仍用 §5.1。全局 enabled=false、support.submit=off、用户对当前周期的明确拒绝、事件失效或安全分类阻断优先于 grant，不能用新 mode 复活此前拒绝。历史 backlog 不因新 grant 一次性扫描上报，默认仅处理 grant 生效后新发生周期；要补报历史则单独 preview/选择。issue 已创建后发一个可配置的简短回执/放时间线；使用哪一个 Bot 报告不改变发布者或权限，也不额外调用模型来完成 POST。

**仓库选择有明确默认，绝不跟当前 shell 的 remote 漂移。** 本仓库 `package.json.repository`、`bugs.url` 与 `.github/ISSUE_TEMPLATE/bug_report.yml` 均指向 `github.com/yoyooyooo/grokbox`，将它作为已安装包内置 support 目标。安装时显式 `support.repository` 可覆盖，但批准前须只读核对 repo ID/可见性/Issues 启用状态/作者权限；远端不可验证则 blocked，不能声称凭包元数据已核实实时公开状态。开发工作区 remote 只供 `issue target inspect --from-remote` 生成待审候选，解析 HTTPS/SSH 时只保留 host+owner/repo，不输出 userinfo/token；不执行 remote、不将通知指向用户恰好正在工作的任意项目。fork/更名/仓库转移/可见性改变不继承原批准，需重新核对并确认。

grant-request 文件只表达用户请求，**不是可执行 grant**；示例为目标 schema：

```json
{
  "schemaVersion": 1,
  "repository": "yoyooyooo/grokbox",
  "incidentRules": ["host-contract-incompatible"],
  "reportProfile": "public-summary-v1",
  "operations": ["create"],
  "durationHours": 168,
  "limits": { "maxPer24Hours": 2, "maxTotal": 10 },
  "attachments": "none"
}
```

rule ID/reportProfile 必须存在于已资格化的版本化注册表；preview 解析当前安装/scope、repo ID/可见性、作者、模板/脱敏 digest 与绝对到期，生成 protected grant preview。create 必须校验该 preview digest、当前配置 revision 并实时重核，变化就拒绝要求重新确认。只有成功读回 grant 后 `support.submit=preauthorized-summary` 才可能生效；普通 config apply/import 不能自己带入 grant。示例的字段/额度不是已经给任何安装签署的许可。

**实现选定内置 Node REST adapter**，收口在 `issue-publisher.node.ts`，kernel `support-issue.ts` 是唯一发布/重试/对账程序；不是让模型生成 `curl` 或从 stdout 解析任意 shell。凭据经既有 secret resolver/用户显式选择的身份获得，GitHub 授权与 provider/Webhook 完全分开；普通通知/接收 Bot 不得到 token。无网络/无认证仍能 prepare/preview/export。本路径不依赖安装 `gh`，用户已拥有的 GitHub CLI 可作为显式手动提交指引而非自动第二 writer；未知 REST 提交不能再回退 gh 以重试。

截至本次核对的官方 [Issues REST](https://docs.github.com/en/rest/issues/issues#create-an-issue) 支持 create/get/update，create 返回 201，fine-grained 路径要求 Issues write；这不要求给程序代码 push/admin 权限。实际用户是否有目标资格要另查，不因“公开仓库”推断匿名可创建。适配器锁定经验证的 API version，严格固定 API host/仓库/路径、禁用跨主机重定向，JSON 正文在内存/受保护文件传递，不放 argv/URL query。普通用户不一定能设置 labels/assignee，默认只发已批准 title/body；标签等元数据只有权限及同意均明确才发送，不能为贴标签扩大 GitHub 权限。

程序主链：安全本地 evidence snapshot → deterministic draft/可选用户补充 → preview + content digest → exact consent 或 grant 每项校验 → 短事务预留 submissionId/额度 → 事务外一次 POST → 保存 issue number/URL/author/target/read-back → 报告结果。预留和发布由独立 support writer 执行；受控 publisher worker 只消费 approved 作业，不拥有 collector 或 Host 控制权限，可由现有服务宿主用独立受限 Scope 装配，不新建常驻 Agent。

去重独立于路由/Bot/notification：本地以 installation/scope + repo ID + incident occurrence + report schema/目的建立稳定 report/submission 身份，多个 Bot 同时提单、重复用户确认只命中同一短事务与发布记录。正文放无敏感信息的随机 report reference 供恢复查询；不能把 Bot/用户/机器身份的 hash 当匿名标识直接公开。近似标题/LLM 相似度最多提示相关 issue，不自动合并、评论别人 issue 或泄露现场去搜索。默认无网络去重搜索；获准提交后的 unknown 对账可在已批准仓库内做有限查询。

遵守 [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) 的限流和串行变更建议，区分 401/403 权限、429/Retry-After、410 禁用 Issues、422 验证/反滥用与传输未知。收到限流不自行加速/换账号。timeout、取消、5xx、201 回执无法持久化先记 unknown；未知结果不能自动第二次 POST。读取已知 number 或 report reference 可结算；搜索不到不等于未创建（可能延迟/不完整）。用户检查后确要重新尝试需新的显式重试许可并承认重复风险，预授权 grant 本身不允许重放 unknown。公共 issue 无临时回滚承诺，删除本地稿件不能撤销已披露内容。

目标命令（待实现，所有 entry 调同一程序）：

```text
grokbox ops issue prepare --incident <id> --json
grokbox ops issue preview <draft-id> --json
grokbox ops issue submit <draft-id> --expect-digest <sha> --confirm --json
grokbox ops issue submit <draft-id> --grant <grant-id> --json
grokbox ops issue reconcile <submission-id> --json
grokbox ops issue status <submission-id> --json
grokbox ops issue export <draft-id> --out <approved-local-path>
grokbox ops issue target inspect
grokbox ops issue grant preview --from <file>
grokbox ops issue grant create --from <file> --expect-preview-digest <sha> --expect-revision <revision> --confirm
grokbox ops issue grant revoke <grant-id> --confirm
```

无交互场景缺许可返回 `approval-required` 与 exact draft 引用，不能挂起无限等待或默认 yes。撤销 grant 立即阻止未发送作业，已发生/unknown 继续只读对账；恢复 backup/账号切换重新确认，旧 consent/grant 不自动复活。支持结果是 created/blocked/unknown 等真实状态，不把可疑的 Bot 回答当发布回执。grant 是程序级策略，不以同 UID 文件/任意 shell 冒充恶意进程隔离。

<a id="policy"></a>
## 6. 自动化等级与低风险资格

critical、保护受阻或需要用户决定的事件，Bot 可运行时先报告已确认的影响/缺口，再做深入诊断；诊断失败/超预算不得吞掉初始告警。模型或原生通知通道不可用则保存未交付事实，不谎称已报告。维护收据只推进同 episode/plan 的通知阶段，不把自己制造的告警重新变成一个新维护计划。

2026-09-17 修订上一版笼统的「安装默认为 off」：正常启用 grokbox 服务的新安装采用 `user` preset，默认启用已验证的轻量本地观察，并在模板配对及通知成本告知完成后生效最小提醒；仅安装 CLI、只读查询或导入模板不会暗装服务、创建活 endpoint 或花 token。未配对显示 requested/effective/blocked-unpaired，不能伪称已保护；明确 off/旧安装选择在升级时保留，不能借新默认值唤醒用户。详细默认矩阵与配置归 §6.1–6.2。

`notify`、`diagnose`、`maintain-low-risk` 是独立能力，不是从 user 角色升到 maintainer 就连带授予的权限等级。维护 grant 仍包含 installation/scope/bot、动作类、revision、有效期与预算，必须通过受信用户入口建立。模板与 preset 都不能预装有效 grant；issue 发布默认使用 exact draft consent，也可按 §5.2 单独启用有限发布 grant；两者均不包含在维护 grant 内。

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

<a id="capability-tiers"></a>
### 6.1 默认 user 与手动 maintainer 能力矩阵

这不是 RBAC 角色表。preset 仅选择观察/呈现/成本默认值，既不改变真实身份，也不授予 issue/Host/provider 权限。能力、接收对象与授权三轴分开；普通用户的通知阈值不会因为维护者想看更多日志而下降。v1 默认一个命名目标 `default`，允许显式增加多个已配对目标及有限路由；不默认把用户现场推到发布者或维护者账号。接收者成本偏好不改变其权限。

| 能力 | user（正常服务启用后的默认） | maintainer（明确选择） | 额外条件 |
|---|---|---|---|
| 轻量 source/loaded/关键用户影响与 observer freshness | 开 | 开 | 复用已有有界采样；无模型，无对外发送 |
| 无影响的升级提示、helper/契约细节、全 corpus/深 replay | 关，仅已有安全摘要 | 可选开；preset 打开已资格化的本地深观测 | 分别受 IO/存储预算，不能泄漏私有源 |
| 用户可操作异常提醒 + issue 询问 | 开，确证影响且不可自修才提醒 | 开 | 已配对/成本告知；每周期一次，去重/限流 |
| maintainer-only 变化通知 | 关 | 本地详情默认开；Bot 汇总仍显式选 | 不扩散到普通用户，不每次 diff 唤醒模型 |
| 自动模型诊断 | 关，用户请求才运行 | 仍默认关，可单独开 | 工具边界、原生运行/成本预算 |
| 主动模型/canary 探针 | 关 | 关，单独开 | 指定测试对象、凭据/花费/影响授权 |
| 低风险 Host 维护 | 关 | 仍默认关 | 独立 grant + 当前完整资格 + 安全屏障 |
| issue 草稿准备 | 先询问再本地准备 | 同左，可手动请求 | 不需 GitHub 凭据；只用安全摘要 |
| issue 创建/评论/公开附件 | 创建默认逐份确认；评论/附件另确认 | 可独立授权有限模板的自动 create，不随 preset 开启 | §5.2 发布 grant 或 exact consent；不能借维护/路由权限 |

正常采样 0 模型调用；首次简短 Webhook 提醒可能触发一次原生 Bot 推理，不宣称零 token。默认首醒工具仅有合法 claim/安全摘要与用户交付，不调 deep diagnostics、不探索仓库、不连续推理修复。内部确定性分类/草稿模板不另调用小模型。初始普通通知预算为每安装 24h 最多 2 次自动 Bot 唤醒、每发生周期一次；critical 有单独最多 1 次/24h 的保留配额并在配对时告知。无上游幂等/调用额度控制时，记录 `nativeCostBound=not_proven`，本地请求上限不冒充实际原生 token 上限。

管理员/维护者可显式调高预算或打开 digest，但也必须给出上限。预算耗尽时本地持续留证并显示 suppressed，不通过换 eventId、换 Bot 或不断升级 severity 绕过。user preset 不定时模型摘要，人工当前请求与自动唤醒的预算/回执分别计数。

<a id="configuration"></a>
### 6.2 配置：一个文件、命名预设、少量覆盖、独立授权

配置存放与 schema 唯一归 [配置 Spec §3–4](configuration-rebuild-spec.md#layout)：Box canonical 为 `${durableRoot}/config.json`，人读入口 `~/.grokbox/config.json`；本专项只占 `ops` 子树，models 独立。删除独立 ops-policy 文件与 overrides 包装：显式叶就是覆盖，未出现的叶按固定版本 preset 求值。`bindings` 存机器状态 `state/ops-bindings.json`，maintenance/issue grants 存 `state/ops-grants.json` 的独立权限区；一次性 issue consent 仍在 support 域。generic config 不能创建这些许可。所有意图 writer 用同一 ConfigChange/CAS，查询不初始化或迁移。

以下是**目标 config v2 的 ops 配置示例**（不是当前 CLI 已识别格式，省略无关可选域）。preset 未覆盖项按固定版本解析；实际 binding/grant 不在此文件，示例不含真实身份。§6.3 的示例是同一 config.ops 子树，不是另一个配置根。

```json
{
  "schemaVersion": 2,
  "ops": {
    "enabled": true,
    "preset": "user",
    "presetRevision": 1,
    "targets": { "default": { "enabled": true } },
    "routing": { "enabled": false, "defaultTarget": "default", "rules": [] },
    "monitor": { "enabled": true, "deepReplay": false, "upstreamAdvisory": false },
    "notifications": {
      "mode": "actionable-user",
      "channel": "bot-webhook",
      "maxAutomaticWakeupsPerDay": 2,
      "criticalReservePerDay": 1
    },
    "diagnostics": { "mode": "on-request" },
    "maintenance": { "mode": "off" },
    "support": {
      "offerIssue": true,
      "draft": "after-consent",
      "submit": "confirm-each",
      "repository": "yoyooyooo/grokbox",
      "attachments": "none"
    }
  }
}
```

解析顺序固定：版本化 preset → `config.ops` 中实际存在的显式叶（不再存 overrides 对象）；一次命令的 `--dry-run/--no-notify` 等限制只可收紧，不能临时绕过持久预算或授权。数组/动作清单整项替换，未知字段/拼错 key 拒绝，不静默忽略。effective capability 另与原生支持、安装运行状态、binding、scope、预算和所需授权取交集；不把这些阻断原因写回用户 desired。ops status / config get --effective 输出 requested、effective、valueSource、blockedReason、policyRevision，例如「希望通知=true，但未配对」「deepReplay=true，但 snapshot 缺失」。

首选日常操作为顶级 `grokbox config preset ops user|maintainer` 和 `grokbox config set ops.<path> …`，而不是第二配置命令族或几十个环境变量。换 preset 默认保留用户明确 override，预览显示仍覆盖哪些字段；`--reset-overrides --confirm` 才清覆盖，但绝不生成/扩大 grant。`config apply --file … --expect-revision … --confirm` 支持可重复的声明式管理。可移植 export 排除 binding/secret/grant/consent，导入不能覆盖安装身份。`config.ops.enabled=false` 是显式总开关：阻止本专项的新采样/自动外发/新自动维护，但保留未决动作的独立对账与显式人工支持查询。`config.ops.monitor.enabled=false` 只关闭 observer，区别于禁用整个专项；两者都不取消运行中用户任务，也不等于撤回 Host 补丁。

开启某能力时 preview 说明本地 IO、可能的模型调用/对外发送与影响；上调自动唤醒、启用 auto-diagnose 或 canary 均需明确确认。`maintenance.mode=low-risk` 没有 grant 时显示 blocked-no-grant；maintainer preset 不能隐式设置它。秘密通过现有 env/file/keychain secret refs 或安全交互写入，禁止 endpoint/token 在 argv、环境 dump、JSON export 或普通错误里出现。

升级保持已有 off/overrides/bindingRevision 和预算，不自动把 presetRevision 从 1 变为更激进的新版本；新的 ops 预设版本通过顶级 config preset 的显式版本预览后采用；文件 schema/root 迁移独立走 config migrate，不与预设升级混为一事。缺失配置只返回默认计划，不在 GET 写入。已有配置损坏则自动外发/新维护 fail closed，保留最后已知状态与明确 gap；不能重建默认文件来复活通知或权限。CLI/模板、配置与实际服务版本不匹配时显示 unsupported，不要求把 Host/provider 一起升级。

<a id="bot-routing"></a>
### 6.3 命名目标与渐进式分流（T54）

**一个目标是正式完整用法，不是简化版第二路径。** `routing.enabled=false` 表示关闭高级规则、将所有已获准的工作送到 `defaultTarget`，不是关闭告警；关闭告警用 `ops.notifications.mode=off`。没有额外规则就无须学习匹配 DSL。默认目标不存在/禁用/未配对时报告 blocked，不从 Bot 名字或模型目录猜一个替代者。

最小可移植偏好示例（尚未实现；配对后的真实绑定不在此 export 中）：

```json
{
  "schemaVersion": 2,
  "ops": {
    "enabled": true,
    "preset": "user",
    "presetRevision": 1,
    "targets": { "default": { "enabled": true } },
    "routing": { "enabled": false, "defaultTarget": "default", "rules": [] }
  }
}
```

用户在受信命令中执行一次 `grokbox ops targets bind default --agent <agent-id> --routine <routine-id> --confirm`，对该 Bot 的身份、实际选模/数据去向、native Webhook 和允许任务做配对；简单 `ops bind` 始终适配同一个 default target 程序。可以绑定已有任何获授权 Bot，不要求它来自官方模板；创建新 Bot/Routine 与配置模型均走已有 owners/T53，绑定绝不偷偷修改 Bot persona、其它 Routine 或模型。

目标偏好位于 `config.ops.targets`，字段为 `enabled/allowedIntents/dataPolicy/maxAutomaticWakeupsPerDay/modelChangePolicy` 及可选 desired `agentId/routineKey`；其已配对精确实例在机器状态的 `bindings[targetId]`：installation/scope、agentId、routineId/revision、endpoint secretRef、bindingRevision、已同意的模型/供应商及工具能力指纹。未填写的 allowedIntents 默认 brief-notice/diagnose-or-report/maintainer-digest；后两者仍受全局诊断 on-request/聚合开关门，不因此自动产生工作；dataPolicy 默认 safe-summary，自动/手动深入诊断需显式同意 diagnostic-summary。多个 alias 不能通过指向同一个 Bot 绕过配额；按 installation + exact agentId + routineId 规范化执行 owner 和预算。

**不在 config.ops 放 modelId、模型 API key 或另一份模型目录。** custom 模型由现有 `${durableRoot}/models.json` 的逐 Bot 分配与原生有效选择拥有；通过既有顶级 `models use <model> --for <agent>` 或用户明确操作原生设置来选择。路由只选 Bot，显示 configured/observed-effective/captured model identity 的差别；assignment 保存不是新 TURN 已采用的证明。别名 cheap/analysis 是用户命名，不保证实时价格或智能水平，系统不联网排名「最便宜模型」。

高级声明示例中的 budget 是用户显式选择的数字，配置生效前需 preview/确认；即使低层预算较高，仍不得绕过全安装上限：

```json
{
  "schemaVersion": 2,
  "ops": {
    "enabled": true,
    "preset": "maintainer",
    "presetRevision": 1,
    "notifications": { "mode": "actionable-user", "channel": "bot-webhook", "maxAutomaticWakeupsPerDay": 6, "criticalReservePerDay": 1 },
    "diagnostics": { "mode": "automatic-bounded" },
    "maintenance": { "mode": "off" },
    "targets": {
      "cheap": { "enabled": true, "allowedIntents": ["brief-notice", "maintainer-digest"], "dataPolicy": "safe-summary", "maxAutomaticWakeupsPerDay": 4, "modelChangePolicy": "require-rebind" },
      "analysis": { "enabled": true, "allowedIntents": ["diagnose-or-report"], "dataPolicy": "diagnostic-summary", "maxAutomaticWakeupsPerDay": 2, "modelChangePolicy": "require-rebind" },
      "official-backup": { "enabled": true, "allowedIntents": ["brief-notice"], "dataPolicy": "safe-summary", "maxAutomaticWakeupsPerDay": 1, "modelChangePolicy": "require-rebind" }
    },
    "routing": {
      "enabled": true,
      "defaultTarget": "cheap",
      "rules": [
        { "id": "diagnostics", "enabled": true, "when": { "intents": ["diagnose-or-report"] }, "action": { "type": "deliver", "target": "analysis" } },
        { "id": "critical-notice", "enabled": true, "when": { "intents": ["brief-notice"], "severities": ["critical"] }, "action": { "type": "deliver", "target": "cheap", "fallbackTargets": ["official-backup"] } }
      ]
    }
  }
}
```

所有 binding 均要另行建立；示例不会复制真实身份/secret。`automatic-bounded` 开关需 T47 工具与成本资格，不因路由 analysis 存在就开启。一般 warning/notice 使用 cheap；严重但只需一句话告知的问题仍可使用 cheap。是否诊断、严重程度、数据级别和维护风险是四个独立维度，severity 高不能自行提升工具权限。maintainer-digest 只有另开有限聚合策略后才产生，不能由规则自动生成定时模型任务。

匹配语义锁定为**有序首条命中**：先做全局 enabled/preset/用户影响/功能开关检查，再对有限枚举字段求 AND（同字段数组为 OR）；支持 `intents/sourceKinds/severities/audiences/incidentRules`，只有来源 adapter 与纯规则确认的字段可以参与，Payload 或 LLM 不可改 severity/受众来选昂贵 Bot。未知字段/重复 rule id/引用不存在 target/空数组/无效枚举拒绝；省略字段表示不限制，缺失事实不匹配明确条件。首条命中后检查该目标能力，不因不满足便悄悄试下一条规则；无命中走 defaultTarget，default 不满足也 blocked。`action.type=suppress` 是显式本地记录，不是换路由/自动回退；隐藏用户严重事件须在 preview 中突出并确认。

每工作阶段只产生一个 primary 目标；v1 不支持广播、任意表达式、动态模型选择或跨账号传递。最多 8 个目标、32 条规则，每条最多 2 个显式备用；备用不能相同、形成环或引用已知不兼容任务的目标。多个来源扩展用固定 adapter 注册，不允许任意远程 payload 直接提交查询表达式。

`routes validate` 检查类型/引用/明显遮蔽；`routes explain --incident <id> --intent <intent>` 只读取现有事实并输出影响门、规则路径、选中目标、模型观察、预算、blockedReason；不得创建 incident/原生查询/模型请求。`routes test --from <synthetic-cases>` 离线回放规则；`targets verify` 才显式进行只读 native 健康核验，真实 POST 永远走单独授权的 T53 invoke。

<a id="receiver-resilience"></a>
### 6.4 custom 接收者、升级交接与故障隔离（T55）

目标资格分开 `identity/routine/ownership/model-selection/tool-scope/data-consent/availability`。**必须单独证明 Webhook Routine 实际走哪个 session/选模路径**；普通聊天已使用 custom model 不证明 automation 回合也会采用。T43/T55 在原生唤醒、模型捕获与工具返回处核对；只有配置记录而无该路径证据时标 webhook-model-unqualified，不假装已经节省费用。custom 接收者必须有当前 Server 准入与对应 Host/modeld/provider 路径的资格；不能为使告警可达先自动开启 Host 或改 harness。官方目标不以「未打自定义补丁」判故障。配置模型/供应商/endpoint 的身份发生变化时，默认 `modelChangePolicy=require-rebind`；这会阻止新自动投递，不改变用户模型，也不在同 TURN 换供应商。上游同名模型的不可观测变化不能假称已被 pin，证据标为不足。

发送前使用有时效的只读目标证据，不用每个事件发一次有成本 probe。custom 目标明确依赖本次故障组件时标 `dependency-unavailable`，优先使用事先配对、允许相同 intent 和数据级别的备用；官方备用仍可能依赖相同 Host/Box，不能称跨故障域高可用。数据对另外一个模型供应商的披露必须在配对/备用预览时同意，脱敏并不代替这种同意。没有合格备用时保留 pending/undeliverable 和本地故障，不强修接收者或扩大权限。

RouteDecision 持久固定 workId、incident/episode/revision、intent/audience、policyRevision、选中 rule/target/bindingRevision、实际已观察模型指纹、最大可读 dataPolicy、reportTarget 与预算扣留。新鲜度复核可以否决旧决策，不能原地改其目标。未发送的旧决策可 supersede 并关联新决策；已发送/claimed 的工作继续按被批准的快照对账或显式撤销，配置变更不把未知旧工作当成未执行。

备用仅在**发送前已证明不可用、明确未接收，或已确定原尝试未开始处理**时推进；HTTP timeout/ACK 丢失/已接受但没回话均为 unknown，不默认扇出备用。每次实际请求与可能产生的模型运行都计入安装/目标/同 work 总预算。target circuit 只限制该目标的通知，不等于 Host mutation circuit，更不能自动清后者。

廉价 Bot 可以返回有限的 `needs-analysis` 候选，但不能直接发给另一个 Bot 或将全部上下文转发。由本地程序核对启用的诊断策略、原因、数据与预算；未开则询问用户，已开且资格满足才创建同 incident 下新的诊断 work。升级深度默认最多 1，禁止 A→B→A/互相提醒；允许新的人工请求另开范围，但不将自动循环伪装成人工。只交接安全 summary + evidence refs，不发对话历史。维护 proposal/issue submission 的唯一身份独立于 work/target，多个 Bot 的结果不能重复执行同一动作。

`reportTarget` 默认等于该工作接收者，用户在该 Bot 中看到报告；高级场景可给 routing 设置一个已配对的固定 `reportTarget` 用于集中对用户告知。分析目标先只存结构化结果，报告目标再领取限定摘要，不复制完整诊断数据。后续报告是一项新的有预算通知，不算免费；不能因为 reportTarget 不可用就未经同意改为另一会话。issue 许可记录真实受信用户/principal，不以哪个 Bot 转述的「同意」为依据。诊断可能已经完成但用户报告未知，二者独立保存。

租期/claim 绑定 work + exact target + native caller identity；只传 `--agent-id` 不能自证调用方。无可验证原生身份或同 UID 任意 shell 情况，安全承诺只限合作执行与 CLI policy，不宣称 OS 隔离；自动诊断需真实能力边界，否则仅可消费已脱敏固定摘要与报告。旧 target 的迟到结果不替换新阶段结果；认领不意味着允许读所有 incidents。

安装级每天 2+1 的 user 默认额度不因增加 Bot 而放大。目标/incident/阶段/原生实例预算与全局额度取最小值；重试、fallback、升级、集中报告均计数；同原生 Bot 多 alias 共用计数。并发 v1 每安装 1 个自动 Bot 工作，诊断仍 120s 上限；critical 可在下个调度点优先，但不取消用户/其它 Bot 的已运行任务。预算不足优先保留简短告警、推迟诊断；已耗尽不能借切目标、换 eventId 或伪造 severity 逃逸。

<a id="configuration-operations"></a>
### 6.5 配置位置、操作与变更生命期

本机根、client/Box/target scope、两份人读入口与 migration 的唯一规则归 [配置 Spec](configuration-rebuild-spec.md#layout)。本专项偏好是 config.ops，不再创建 ops-policy.json；不放 repo/.env、template Memory 或原生产品数据库。root 不从 Payload/cwd 推导，配置与执行命令都须绑定明确安装。

| 内容 | 放置与写入者 |
|---|---|
| enabled、preset、显式叶、target desired/偏好、routing、support 偏好 | config.json 的 ops 子树；同一 ConfigChange/CAS |
| bindings[targetId] 的精确身份、secretRef、模型/数据/工具同意指纹 | state/ops-bindings.json；targets bind/rebind 写，非人读配置 |
| maintenanceGrants 与 issueGrants | state/ops-grants.json 的两个权限区；受信 grant 程序写，config 不能造 approval |
| provider 模型与逐 Bot 分配 | 既有 models.json/原生选模 owner；不在 routing 再存 modelId |
| GitHub/原生 endpoint 的 secret | 既有 secret provider/file/env/keychain 支持面；配置只引用，read/show 永不返回原值 |
| work/路由决策/预算/通知/issue consent 与回执 | 既有 observations.sqlite；逻辑域限定 writer，不为每 Bot 新建 DB |

`config export` 输出可移植偏好（含逻辑 target alias，不含 Bot/endpoint/model 指纹或 grant）；在另一个安装 import 后所有别名未配对，显示 blocked，必须受信重绑。完整私有 backup 也不能自动复活授权/旧 claim。旧 ops-policy schemaVersion1 只是未发行草案，不假定生产存在；实际发现原型文件才走配置 migrator，偏好迁入 config.ops、bindings 迁入机器状态，grant 必须复核/暂停，保留 off/预算且不静默创建目标。

首次使用：创建/选择 Bot → 用既有 owner 配好所需模型（可维持官方）→ T53 配置独立 Webhook Routine → `targets bind default` 预览 scope/数据/成本 → 明确启用通知。进阶增加 cheap/analysis 等别名，再以 `config apply --file … --expect-revision … --confirm` 原子提交 target 偏好/路由；bind 仍是另外的受信原生操作，不在 config apply 中隐式创建 Bot/Routine。

配置更新的影响须预览：新增供应商/扩大 dataPolicy/增加预算/改 reportTarget/增备用都需明确确认；规则开关不放开 diagnostics 或 maintenance grant。禁用 target 立即阻止未发请求，撤销其未用 claim，保留未知在途结果；不 cancel Bot 的用户回合。删除被路由引用的 target 默认拒绝，用户先一次配置变更移除引用或显式保留 blocked。重绑更换 bindingRevision，使旧 endpoint 不再被新工作使用；disable/unbind 不自动删用户原生 Routine，清理用 T53 exact ID。

排障输出以 `ops targets show`、`config get --effective`、`ops routes explain`、`ops issue status` 展示 requested/effective/配置来源/预算/阻断层；不能用选中 expensive Bot 证明动作安全，不能用 config 保存成功证明 Webhook 可达。未来 UI 直接消费这些同源程序，不另建路由规则引擎。

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
| preset、显式 ops 偏好 | `${durableRoot}/config.json` 的 ops；统一 ConfigChange/CAS |
| 真实配对、独立授权 | state/ops-bindings.json / state/ops-grants.json；各受信 owner，generic config 无权限 |
| incident、work/route decision/delivery、目标预算、claim/升级/诊断/报告状态 | T41 同一个 observations.sqlite 的扩展事务与迁移；不另开 webhook.db/router.db |
| issue 草稿、exact-content consent、发布 grant 用量与 submission/unknown | 同一 SQLite 的 support 管理域，独立受信 support 用例写入；collector/维护 grant 不能签字；grant 本体归 ConfigurationWrite |
| 原生 Agent/Routine 配置与调度状态 | 原生接口是唯一权威；本地只存 scoped operation/provision 回执与 managed key→native ID 关联，不复制 scheduler/原生任务库 |
| 不可变 plan、operation/进度/恢复 | 现有 controller operation store 的扩展；不是把激活权交给 observation DB |
| 命令/Host/modeld 事实 | 原有 writer 不迁移；T41 只索引结果，保持 J13 与独立 guardian |

通知事务先提交再发送；网络与模型诊断不持 SQLite 写锁。跨 HSO、T41、policy、controller 的推进使用幂等引用与 CAS，承认部分提交，不宣称 Effect Scope 是跨库原子事务。过期 plan、被撤销 grant 和 tombstone 不能因备份恢复而复活；恢复后更换 observer/binding epoch，重新配对或复核后才有发送/执行资格。

下列为本专项 v1 **默认策略预算**，不是上游 SLA，也不是当前程序已实现参数；代码只在 kernel 的一个 policy owner 定义，CLI/skill 不复制常量。HSO 既有采样预算复用，不顺带改 modeld 或 T41 Server 准入预算。

| 预算 | v1 初值/处理 |
|---|---|
| source 事件合并 / metadata / hash backstop | HSO 的 250ms / 30s / 60s；启动、重连与换代强制 resync |
| envelope | 最大 8KiB；长证据本地引用，拒绝静默截断 |
| 通知在途 / 原生请求 | 每安装 1 个请求、单次 10s；所有模式通用请求上限 6 次/小时 + critical 2 次/小时，与 §6.1 preset 的日唤醒额度取更严格者；user 默认 2+1 次/24h，不因 hourly ceiling 放宽 |
| 有歧义重试 | 默认 unknown 不盲重发；启用允许重复通知后最多 3 次/条，退避 30s、120s，上限仍服从小时预算 |
| Bot 诊断 | 仅诊断被独立启用/用户请求时：每安装 1 个活动 claim，最多 2 轮 × 8 个只读操作，总 120s；user 默认 brief-notice 不进入此预算/循环 |
| 模型成本 | 默认被动监测 0 模型调用；Bot 诊断使用安装时明确批准的原生推理/消费预算，不可证明的原生 token 上限必须标 unknown，不冒充硬配额 |
| plan | TTL 15min；最多等待安全边界 10min；一次动作预算由已资格化 action 定义，默认总 120s；超过后对账，不追加 mutation |
| Host 变更 | 每安装最多 1 在途、每小时最多 1 次；同组合失败隔离，只有新证据或人工解禁才能新试 |
| 存储 | 未终结通知软目标 1000 条/16MiB；合并同周期，受保护 critical/unknown 不静默删除；达到硬存储不可用则暂停新外发/自动维护并记录 gap，已有推理不依赖本库 |
| 保留 | 已结算交付/诊断默认 14 天，幂等 tombstone 至少 30 天且覆盖 retry/恢复窗口；支持草稿默认 7 天、consent 24h，pending/unknown 发布回执受保护，清理正文不删除必须的去重状态；超过保留查询明确 gap |

Effect 固定仓库 `4.0.0-beta.107`；Node 发布下限和 Bun 锁不随本方案升级。collector、投递 lease/退避、诊断期限、资格 worker、维护调度使用各自宿主 Scope 的有界子 Fiber/队列；Fake/Live 替换 port，不复制程序。preload/Host 不导入 Effect、SQLite、Webhook 客户端、ops policy 或模型 SDK。取消、expected failure、defect 与 unknown outcome 不合并为空成功。硬崩恢复不能依赖会随父进程死亡的 Fiber。

<a id="layout"></a>
## 9. 最小目标骨架与 ports

下面是要实现的目标路径，不是当前文件已存在清单。保留三个现有 npm/workspace 边界，不新增安装包、服务框架或通用插件系统。

```text
packages/runtime-kernel/src/
  ops.ts                              # 本专项窄 DTO、纯规则及用例导出
  routines.ts                         # 通用 Agent/Routine 合同，不依赖 ops 是否启用
  ports.ts                            # 有限 NotificationTransport / OpsEvidenceRead / OpsState / IssuePublisher / AgentRoutines 能力
  internal/ops/
    policy.ts                         # grants、预算、动作准入；唯一 policy 常量
    notification.ts                   # envelope/交付/claim 状态规则
    routing.ts                        # 命名目标、顺序匹配、冻结决策、备用/升级的纯规则
    qualification.ts                  # 组合身份、覆盖与失效/等价规则
    support.ts                        # 草稿/脱敏 allowlist/同意与发布状态；不含原始日志
  internal/commands/
    ops.ts                            # claim/diagnose-plan/submit 用例；不拥有原始 signals
    support-issue.ts                   # exact consent / 有限发布 grant 的同一个发布与对账程序
    agent-routines.ts                 # CRUD/apply/provision 用例；原生任务是权威
    controller-operation.ts           # 扩展授权 provenance、统一 busy/drain、实际唯一 mutation
packages/box-runtime/src/internal/
  ops/host-seam/watch.ts               # 复用 observe writer 的长期 sensing/重同步
  ops/automation/
    notify.ts                         # outbox/目标健康/预算/交接与投递；不成为新 Agent loop
    diagnose.ts                       # 有界只读工具执行；不运行任意 shell
    qualify.ts                        # 调现有 replay/profile 规则，不执行留存 Host
  io/
    config-store.node.ts              # T57–T60 唯一人读配置 IO，不创建 ops-policy 文件
    ops-bindings.node.ts               # 实际配对机器状态
    ops-grants.node.ts                 # 受信维护/发布授权机器状态
    template-notify.node.ts            # 消费冻结的已绑定目标；文件名保留，不再限制模板 Bot
    issue-publisher.node.ts            # 已确认仓库/作者的 GitHub adapter，不由 collector 调用
    monitor-store.node.ts             # 原库迁移：outbox/inbox/诊断，不新增 DB owner
  roots/
    monitor.runtime.ts                # 既有观测宿主中组合 HSO + 通知子 Scope
    ops.runtime.ts                    # 独立 Bot/modeld 的受限计划调度；只调用唯一 controller
    controller-program.node.ts        # 原 controller Live ports/存储扩展
packages/cli/src/
  gateway-automation.ts               # 隔离已资格化原生 routine CRUD，不向内核泄漏私有 DTO
  commands/ops.ts                     # config/support/运维的薄参数/输出入口
  commands/routines.ts                # 通用 Agent Routine CLI，调用唯一 routine 程序
  commands/agents.ts                  # create/update 的 --routines-from 复用相同 apply 程序
  agent-routines.node.ts              # 本机 scoped provision 回执，不复制原生调度权威
  template-recipe.ts                  # blueprint 处理与安全导入能力校验
  skills.ts                          # 实现后注册 ops 进阶主题
skills/grokbox/ops.md                 # 实现后才进入安装包，按需加载
scripts/templates/grokbox.recipe.json # 实现后加入无绑定、无 secret 的 routine blueprint
```

NotificationTransport 的 canonical 合同描述固定已绑定目标的投递/可用回执，不接任意 URL；OpsEvidenceRead 只返回 allowlisted 快照；OpsState 通过既有 store 提供 claim/交付/support 事务但不赋予所有调用方全部写能力。IssuePublisher 消费 exact-consented 或 bounded-grant-validated 的不可变 draft，对固定仓库创建与按引用对账；CLI 内置 REST 实现，不依赖通知 Bot 拥有 GitHub token，也没有任意 HTTP/附件上传 capability。AgentRoutines 是通用原生任务的有限 port，native read/apply/enable/disable 与真实 webhook POST 的权限明确区分；shared command 不依赖 ops/维护 grant。controller 仍消费 ControlResources，不另定义第二个 Promise/Effect 控制接口。native routine 由 CLI 宿主装配，box-runtime/kernel 绝不 import CLI。

长期观测与受限维护是两个权限不同的进程角色，可以同一包发布，但 collector 无 signals。`ops.runtime.ts` 不是第二个 reconciler：它不实现注入/停止流程，只领取已批准计划并调用已有 controller。T40 负责真实安装、自启/停止；不假设 systemd 存在，不修改官方 supervisor，不让 Bot 自己 nohup 一个 loop。

<a id="surface"></a>
## 10. 用户与 Bot 的目标命令面

以下为 **T43–T56 计划新增，当前不可直接运行**。具体 JSON/schema/错误码由同一 kernel 程序导出；不存在通用 `exec` 参数。

```text
ops status                             # 只读：binding/collector/delivery/diagnosis/policy/action
ops bind / unbind                       # default 目标适配，复用 targets 同一程序
ops targets list / show / bind / disable / unbind / verify
ops routes validate / explain / test    # 只算路由，不发 Webhook
config get / set / unset / apply / validate / schema / path / export
config preset ops user|maintainer       # 唯一配置族；不签 grant；文件迁移用 config migrate
ops policy show / set / revoke          # 独立维护授权
ops issue prepare / preview / submit / reconcile / status / export
ops issue grant preview / create / revoke
                                       # 内置程序完成脱敏/确认/提交/对账；模式与权限见 §5.2
ops claim <delivery-id>                 # 真实记录/作用域/租期检查
ops diagnose <delivery-id>              # 有限只读 playbook，不接受任意 shell/URL
ops plan <delivery-id>                  # 不可变候选；尚无执行权
ops submit <plan-id>                    # 持久交接，不等待 Host 重启
ops approve <plan-id>                   # exact digest 批准，仍需安全硬门
ops outcome <plan-id>                   # 原 controller 事实
ops run                                # 显式受监管角色；status 不启动
```

T46 以实际能力探测决定蓝图安装：优先原生模板安全携带禁用的 routine 描述，导入后为本安装创建独立 endpoint 并激活；若原生模板不能保证禁用/新密钥，则不携带已激活任务，随模板发 bootstrap skill，在用户配对后通过官方接口创建。两者实现同一产品结果，不从原 Bot 复制活 endpoint、token、installId、grant 或旧投递记录。

模板入口保持小：只有收到合法 ops 触发才加载已安装版本的 `--topic ops`。本次文档不新增该主题到实际 skills 清单，避免 Bot 提前调用不存在的命令。用户报告固定说明「发现了什么、可信度/缺口、实际已做什么、为什么不能静默、需要何种决定」；无动作、等待边界、unknown 和成功分开，不把告警本身当用户新指令。

<a id="agent-routines"></a>
### 10.1 通用 Agent/Routine 管理与 create/update 组合

当前没有该能力；T53 必须交付它，而非让 E2E 或模板 bootstrap 直接改 `automation.json`。这是通用 Agent 能力，不要求启用 ops、SQLite 监测或 Host 自动维护。原生可能将 routine 正文与 automation/trigger 表达成不同对象：T43 先冻结映射、标识/修订和权限，公开 CLI 使用有限统一 DTO，不把模板 `routines[].content` 假定为完整原生任务。

目标命令如下（实现前不可运行）：

```text
grokbox agents routines list <agent>
grokbox agents routines show <agent> <routine>
grokbox agents routines apply <agent> --from <file> --expect-revision <revision> --nonce <uuid>
grokbox agents routines enable|disable|delete <agent> <routine> --expect-revision <revision> --yes
grokbox agents routines invoke <agent> <routine> --payload-file <file> --request-id <uuid> --confirm
grokbox agents routines outcome <agent> <routine> --request-id <uuid>
grokbox agents create --name <name> --routines-from <file> --nonce <uuid>
grokbox agents update <agent> --routines-from <file> --expect-routines-revision <revision> --nonce <uuid>
```

`apply` 对指定 managed keys 做 create/update，所有入口调用同一 command；省略的已有 Routine 保留，不以空数组删除别人任务。不自动 prune，删除必须指定已解析的 exact ID 并确认；更新已启用任务需要显式影响确认，默认先按原生支持能力禁用并查明是否存在运行中任务。list/show 默认安全 metadata，正文仅在显式授权读取时返回，不进入一般事件/日志。

用于测试的声明示例是 grokbox 自己的 schema，并非上游 DTO：

```json
{
  "schemaVersion": 1,
  "routines": [{
    "key": "webhook-probe",
    "name": "Webhook probe",
    "instructions": "只回报本次收到的合成 probeId，不执行外部命令或维护。",
    "trigger": { "type": "webhook" },
    "enabled": false
  }]
}
```

创建默认 disabled；Webhook 类型明确表示事件触发，不附带 cron/interval，不因为叫「定时任务」就周期性唤醒。cron/interval 属于不同 trigger，只有 T43 单独资格化才可写；未知类型只读保留不改写。模板配对复用相同 apply/enable 程序，不能建立模板私有的 CRUD 旁路。

组合操作先对整个 Agent 属性与 routine 文档做只读 validation/capability preflight，再创建 Agent；没有 routine 能力时应在创建前拒绝。创建成功而 routine 失败返回 `agentCreated=true, routineState=partial|unknown` 和 exact Agent ID/nonce/阶段，不删除 Agent、不重新 create。重复同 nonce 续做剩余阶段；同 nonce 不同文档 digest conflict。`agents update` 只变请求的字段；仅 --routines-from 也应算有效更新，不改变 Server harness/模型分配。不许承诺原生多对象原子事务，部分提交需持久回执与重入对账。

routine 引用绑定精确 Agent、managed key、原生 ID、作用域和 revision。优先用原生 CAS/幂等；如原生不提供，本地锁 + 前后读回只可声明 `externalConcurrency=unprotected`，不得冒称防住 App/其它原生 writer。外部变化/不确定所有权时停止自动写；独占的一次性 E2E 对象可按明确范围执行并披露限制。模板导入新建独立绑定，不能复制 endpoint secret。Routine 更新导致 endpoint/身份变化时先使旧 binding 失效，再经配对 owner 核验；不把旧 URL 默默留给投递器。

`invoke` 是真实 HTTP POST 到经原生接口确认的目标 Webhook，不允许给任意 URL，不可退化为 sendPrompt、直接插队或只调用内部 handler。它会唤醒 Bot/可能产生原生推理费用，所以有显式 --confirm、目标与请求预算；普通 read/apply 不隐式测试。payload 来源文件有大小/schema/编码门，requestId 贯穿 native 接收、run、报告证据；上游不提供关联时明确 not_proven，不用相近时间猜因果。端点含 secret 时内部安全解析，只在普通输出给 redacted metadata，不能把原始 URL 放 argv/日志。

<a id="routine-e2e"></a>
### 10.2 可重复的 Agent → Routine → Webhook → Bot E2E

验收必须经过实际发布 Node CLI：能力预检 → 用稳定 nonce 创建一次性、未分配 custom model 的 Bot → 原生创建 disabled Webhook Routine → 读回 exact ID/trigger/revision → 显式 enable → 调用 invoke 发真实 HTTP 合成 probeId → 查原生 run/收到的 probeId/用户报告 → 更新同一 Routine 的测试指令/修订 → 再 POST 新 probeId 并证明使用新版本 → disable → 核对不再可触发 → 安全清理本测试拥有的 Routine/Bot。

create --routines-from 与先创建后 apply 两种入口都要测；update --routines-from 复用相同程序，并验证 Agent 名称/模型/归属/其它 Routine 不被改写。routine 创建成功不等于已暴露/可请求，HTTP accepted 不等于 Bot 已运行，Bot echo 不等于 App 已读；每层独立证据。普通监控预设关闭了哪些能力，也要验证不会影响专门授权的 test invoke。

默认自动测试用 Fake native、临时真实 HTTP/SQLite 与 disposable 进程；原生 lane 须显式授权测试 Box/Bot、请求次数、费用和清理范围。T55 另加两种不同模型的 disposable 接收 Bot 与可选官方备用，实际验证所捕获选模、模型更换需重绑、按 intent 分流、ACK 丢失不广播及总额度不随 Bot 数放大；通用 T53 的默认官方测试 lane 保持独立。原生测试不得自动启用 Host 维护或向公共仓库创建 issue；支持流程的提交默认用 Fake IssuePublisher，真实 issue 仅在单独指定的测试仓库与 exact draft 同意下验证。

setup/trigger/update/teardown 均有回执。超时先查本次资源/运行，不盲目再创建 Bot/Routine/发送同消息；禁用不意味着已经取消运行中的任务。只在本测试回合及子任务已经结束、所有权明确时删除；失败保留可定位的 cleanup_required，不全局 kill、按名字批量删或删除用户生产 Bot。取消/硬崩后凭 scoped provision receipt 续做清理，而不是假设 finally 一定执行。

<a id="tickets"></a>
## 11. 施工顺序与证明

AH-99/AH-100 已并入 [配置重建 T57–T60](../tickets/README.md#configuration-rebuild)：作为本表配置/持久接线的共同前置，而非额外 ops 文件。T51/T54 纯规则、T43/T53 原生合同可并行；T45/T46/T52/T55/T56 的 production config 接线须等待统一 schema/writer 可用。公开前缀改为 ops/models/config，领域行为和安全门不变。配置底座实现不等于全部运维功能完成。

| 阶段 | Ticket | 可独立交付的退出 |
|---|---|---|
| 合同与上游验证 | T43 | 原生 Webhook/任务与 trigger 映射、版本化 adapter；为 T53 提供 CRUD/修订/关联事实 |
| 默认与可选配置 | T51 | user/maintainer preset、requested/effective、独立成本/权限开关与升级保留 |
| 命名目标与路由 | T54 | 单目标默认、多 Bot 明确分流、private bindings、离线路由解释 |
| 接收者与交接 | T55 | custom 模型/依赖资格、固定决策、预算/备用/一层分析升级/集中报告 |
| CLI 发布自动化 | T56 | 内置 REST、exact consent 一次完成及可选有限摘要 grant、唯一 submission |
| 通用原生任务 CLI | T53 | Agent create/update + 同一 Routine apply、真实 Webhook invoke/outcome、重入/清理 |
| 连续事实 | T44 | HSO → T41 采样/失效/incident，只读权限闭合 |
| 可靠唤醒 | T45 | T54 冻结目标的 outbox → Native Webhook → claim/报告回执；T55 闭合 custom/交接 |
| 可分发模板 | T46 | 复用 T53 的禁用蓝图/配对，T51 默认提醒与克隆隔离；不依赖自动诊断开启 |
| 用户支持闭环 | T52 | 默认简短通知→脱敏稿→exact consent；T56 内置提交/对账，并独立开放有限发布 grant |
| 自动排障 | T47 | 受限工具、有限诊断、报告/候选分流，无运行中维护 |
| 低风险证明 | T48 | 全切片/依赖覆盖、等价规则、预授权 profile 发布、stale 拒绝 |
| 唯一受限执行 | T49 | 同 controller 的统一 drain、持久 handoff、policy apply/退出、恢复和验证 |
| 持久运行与验收 | T50 | 显式安装/权限隔离、故障演练、原生用户旅程、签署范围与退场 |

依赖：T43 与 T51 的纯合同/配置规则可并行；T53 仅依 T43 的原生合同，不依赖 ops 上线。T44/T45 依 T43/T51，允许 Fake 来源先做；T46 依 T43/T45/T51/T53。T52 可在 T44/T45/T51 后用 Fake Bot/support port 实施，普通用户通知→草稿→确认不依赖 T47 深诊断或 T48/T49 自动维护。T47 依 T44–T46 与 T51，T48 在 T43/T44/T51 后离线并行；T49 依 T48、T47 handoff 和 T51 grant，并复用 T28/T40。

新增依赖：T54 只依 T51 配置与 T43/T53 的原生 port 合同，可与 T45 实现并行；T55 依 T54/T45/T53，将 T47 当可选升级消费者，不阻塞单目标 brief。T56 依 T52/T51 和包内 support 目标，不依赖多 Bot 或自动诊断。目标/路由 schema 必须先冻结，不能先做一个模板专用 sender 再保留它作第二路径。

T50 分 lane 验收：user 基础支持为 T43–T46/T51–T54 的单目标加 T56 confirm-each；custom/多目标加 T55，诊断加 T47，维护加 T48/T49；有限发布 grant 是 T56 的独立 opt-in lane。默认 user 不等待所有高级 lane。任何票不要求 T40/T41 整票先 Done；新 T54–T56 不重写历史票的关闭状态。

测试目标由各票定义，默认 Fake upstream/clock/通知与 disposable 本地进程；公共 CI 不执行私有 Host 或真实模型。新增 `verify-runtime-rebuild` 的 `template-ops` 组只在有对应测试后注册，必须区分 offline/source/packed/native。上线需独立复核以下反例：错 scope/克隆 token、重复乱序/ACK 丢失、Bot 崩溃后复领、锚点不变但语义坏、helper-only 变化、A→B→A、maintenance Bot 自占 busy、新任务撞上 drain、取消后的未知 signal、退出失败、通知成本耗尽、observer/DB/Box 离线。

先冻结 T51/T54 的单一配置与 target schema，交付 T53 通用 Agent/Routine 与 default target 纵切；同步推进 T52/T56 的内置授权提交，再逐类开放 custom/多目标/诊断/发布 grant 与维护。不能用全仓测试绿代替 native endpoint/任务/SendToUser/进程切换证明。每次验收声明固定构建、已启用动作类、安装范围、证据缺口与撤销路径；不在公共文档存现场 secret、真实 Bot 标识或原生私有源码。

## 12. 参考与失效条件

Node 对 fs.watch 的 inode/rename 限制支持「事件 + backstop」的设计，不证明上游发布原子性：[Node fs caveats](https://nodejs.org/api/fs.html#caveats)。Webhook 的认证、及时接收后处理、delivery ID 等通用工程参考：[GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) 与 [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。这些不是 Grok Bot 的协议文档；不照搬其 header、超时或自动重投语义。

GitHub 创建/更新 issue 的公开接口、权限与结果语义以 [GitHub Issues REST](https://docs.github.com/en/rest/issues/issues) 为准；内置 publisher 默认无需 gh，显式手动路径可参考 [gh issue create](https://cli.github.com/manual/gh_issue_create) 的 body-file/repo 参数，但未知自动提交不得切换工具重复尝试。安全信息的私密报告参考 [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) 与本仓库 SECURITY.md。确认对外发布与未知结果对账是本产品约束，不假设 GitHub 提供原生幂等写入。

原生 routine/模板复制行为、Payload 投影/认证、Host/component/recipe、modeld wire、工具权限、存储 schema、preset 默认/成本、目标模型/路由/备用、issue 目标/公开性/模板/授权或用户 scope 改变时，复核本 Spec 对应资格而不是复用旧绿灯。实现事实继续由 source/tests 与限定 live 收据拥有；本页只拥有此专项的施工合同。
