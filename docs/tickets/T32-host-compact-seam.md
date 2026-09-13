# T32 qualification — Host compact 在 managed STEP 等待点的调用接缝

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## 当前资格增量（2026-09-12，先读本节）

下文旧 2026-09-10 行号/接点结论保留为历史证据，不作为当前 release profile。owner 已授权真实 Host 切换/re-adopt 与有限 CLI e2e，当前模型使用 `ccs-sub2api-xai/grok-4.6`，不再调用已无额度的 luna。

本轮实际读取当前 Host **`307de3990394efc6b9a868537bab8504fceec3cc898cdd2ad91de68830f2f8dd`**，发现旧 agent-id patch 的 `modelId` 字面片段已经改为 Host 自有 `modelId / executorProfile` 分支。实现改为在 mainSessionOptions 开头只插入 Agent/TURN 身份，保留原生选择；新增两个 ordinary/executor fixture 先红后绿。其余精确 slices 在此 SHA 上唯一匹配，转换后语法有效。

- 当前 transformed SHA：`0f3e5e9665adccd80bab219ad93727347300914f96c52c5fc67925b0b5431f32`。
- AST 选择真实 `handleSummarization` 及真实同步 state mutators，在无 Host 启动/外网/产品存储能力的 VM 执行；root/privacy/provider/blob/metrics 是 owned fixture。成功：provider=1、blob=4、clear=1、append=2、archive=1；生成等待中取消与 root 换代两反例：provider 已开始1，但 blob/root/archive 写入均0。所有等待释放并结算，Host 原文件未改。
- native core SHA：`94aa52129230679f3a7386aae260955784c67610cff39614ac8657ae8f7a1415`。机器内可重放脚本：`PRIVATE_EVIDENCE`；私有原生源码不进入公共仓库。
- 这补充当前 profile 的局部 native 接受/取消资格，**不证明全部 callback alias、pending-background 收口、完整 native loop 或真实 overflow 恢复**。不能把 guard facade 的证明泛化为任意 Host ABI。
- SDK pipeline 回归同时抓到 Compact 后原 tools/options 丢失：kernel 现只用 Host 新 messages，保留原已受理 STEP 的 tools/options，并核对 profile/ABI、重算 snapshot digest。正/反向 SDK body 用例已通过。

已执行的真实 profile publication、re-adopt、独立模型凭据切换及尚未闭合的 e2e 统一记在 [readiness](../maintainers/t32-live-enable-readiness.md)。本页不是生产总验收，T32/T35 不因局部 native 资格或模型 smoke 自动 Done。

---

## 历史资格（2026-09-10，不覆盖上述当前增量）

**2026-09-12 当前资格状态：未通过。** 下文保留早期固定版本的诊断与条件性资格，不是最新 Host 的 GO。当前 source-pin 测试期望 `2ede71e2…`，现场实际为 `307de399…`，该红项未放宽。工作树已有注册前移、managed 摘要协调/原生 retry 控制与 delegate 生命周期修复；最新范围和隔离证明见 [T35](T35-host-compact-wait-point.md)，发布/模型可用性见 [readiness](../maintainers/t32-live-enable-readiness.md)。Owner 已允许必要重新领养；仍需针对实际版本验证摘要 mutator、迟到回调及 root 接受合同，不能用旧行号、方法名或 owned fixture 代替。下文的“尚未实现”“不得移动注册”等仅解释旧基线，不再构成当前施工约束。

**2026-09-10：conditional GO for offline implementation；不是可直接启用的runtime capability。** 主票：[T32](T32-runtime-confirmed-compact.md)。源码基线 `pre-publication-revision`。H表示 `/home/box/sand-host/host-main.cjs` 的1-based行，SHA256 **`f5cc35b57135ddbb5e32bbfa8e3bdcbdc9d6a88540043059feb8049280df2740`**；换SHA须重资格，不能只沿用名字。

结论分三层：

1. **Host core可直接调用，限定分支不必等待main STEP完成。** 已用原生方法切片+Fake依赖证明：H:600440–600447的原生等待表达式保持pending时，真实`handleSummarization`可以接受summary、写owned假blob/archive并重写root，返回后main仍pending。
2. **当前managed seam没有暴露该能力。** 现有createSession两slice既没有当前`stateHandler`，也没有runStep-scoped delegate；不能写`host.compact()`、从日志触发，或假定拿到任意session就能调用。D2批准的注册/释放接线仍须实现。
3. **不等于完整恢复已通过。** 固定方法的条件性wait-graph资格，不是live Host、真实summary provider、完整v4/kernel/pack e2e或运行中heap证明。下面的D2、state保真、provider资格及T32现有验收仍是enable gate。

## 1. 选定调用：直接借当前Host owner，不排新action

Host构造同一orchestrator并交给各action handler（H:619624–619675）；main路径在`AbstractUserMessageActionHandler.runStep`持有`this.orchestrator`、active `ctx/stateHandler/rootPromptExecutor/requestContext`。需要的是这个**活的实例和当前窗口**，不是新建orchestrator/summarizer、再次getExecutor或重新从store恢复。

以下是**待接线的调用形状**，不是已安装API；参数均由原生作用域捕获，不能从provider body接收：

```ts
await this.orchestrator.handleSummarization(
  ctx, stateHandler, rootPromptExecutor,
  this.interactionListener, this.config, requestContext,
  {
    backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
    forceExternalModel: true,
    triggerReason: "input_token_limit_error",
    currentInvocationId: invocationId,
    resourceAccessor: this.resourceAccessor,
  },
);
```

这复用Host自己的input-limit分支形状（H:600941–600979），**不**调用该分支的外层retry loop。无`fullSummarization:true`强制改策略，也不传tools/extraT去启用self-summary。Host选择分区、summary carrier、保留尾部、archive和后续prompt assembly；grokbox不做near-window、不prepend历史，CAP在产品里保持unset。

- core入口/选择：H:596479–596525；新摘要provider await：H:596623–596721。
- 等待、archive与root替换：H:596740–597026，特别是H:596840（await生成）、596873–596904（blob/archive→clear/append）。返回值为Host redacted summary字符串或undefined，**不是snapshot/成功资格对象**。
- 新输入必须从这次调用结束后的**同一个active root**取Host状态，经已有受审codec生成新snapshot；原生侧可用既有`fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)`还原自己的包装（H:593664–593713），不得在kernel仿制私有serde。支持的Host metadata不能丢；不重新调用getExecutor替代原实例。
- core会写archive blobs并更新RAM builder；它不调用`onStateUpdate`发布整个conversation root。后续Host checkpoint仍是持久化owner（H:591134–591246、619736–619761）。**core return≠root已durable**，无需为了取resume snapshot等待本STEP最终checkpoint；也不能以RAM成功宣称重启恢复成功。

### 注册位置、身份与寿命（D2待实现范围）

**注册窗口选H:600437–600447的main `runStep`等待前**：工具/初始background准备已完成，`responseSummaryLaunch`已经安装，即将await主stream。不要在createSession时注册永久“compact全局服务”。closure读取已有的`stepClosed`（H:600448–600467退出时置true）作为有效性条件，并在H:600694–600699的整个runStep finally释放注册，防止异常、取消或过期复用；可将disposer加入既有`env_2`资源栈复用finally，而非复制一套生命周期。

注册的最小语义是“当前tuple可消费一次的closure”；具体symbol/schema在实现中按D2定稿，**本页没有导出可调用的新函数名**。注册记录绑定：

- 原STEP = 本次已生成的`invocationId`（H:600237–600240）。不得再次调用`getInvocationId(ctx)`获取“同一个”id；该函数每次调用generator（H:542422–542432）。
- 原TURN = `ctx.get(requestIdKey)`，与主session捕获的`inferenceRequestId`核对；TURN同时进入这两个requestId key（H:752475、752578–752590）和现有main options薄补丁。不能以STEP或spanId代替。
- Agent = 当前config `conversationGroupId`，对应`host.getConversationId()`，不拿`conversationId`（transcript id）混用（H:750783–750795）；再与managed捕获的agentId核对。
- loaded Host generation/compile/profile由既有preload/HostBinding绑定；binding、ServiceEpoch、selection来自当前连接的既有admission，不接受provider自报。closure持有原ctx/root/stateHandler，不序列化这些对象。

原生STEP可能在delegate登记前就收到快速overflow；此时只可返回 **capability_not_ready/unavailable**，不得排Host action等“将来出现”的能力。进入/退出各await后重核对slot、tuple、ctx signal、`stateHandler.lastStepInvocationId`。只有Host-facing response/usage/extendedUsage及fullStream仍未结算、无放行内容/工具时才进入该窗口；尤其不能提前结算extendedUsage让`responseSummaryLaunch`并发开启另一summary。

D2最小patch职责：main runStep等待点注册 + 全退出路径释放/失效；Host core不复制、不重写，helper只保存有界的一次性能力。若需要扩大位置/语义，另交精确证据与批准。现有profile validator仍只接受两slice，须随批准更新schema/validator/tests；不能绕校验。runtime仍是字面唯一anchor/source SHA/transformed SHA，**不加AST/模糊识别到hot path**。

## 2. 为什么这条路可走；哪些路会挂

| 位置 / 依赖 | 固定源码事实 | T32裁决 |
|---|---|---|
| **主等待：H:600440–600447** | `Promise.all`等待response、extendedUsage、usage、invocationId、消费fullStream、responseSummaryLaunch；下层H:593079–593086启动managed stream | v4 control reader须在此等待尚未完成时调用delegate；compact-request不能变成assistant/error/finish事件 |
| **排队action：H:619751–619800** | runStream先await当前handler，再peek/pop下一action；`SummarizeActionHandler.handle`另在H:604536–604619 | **不能使用queued summarizeAction**：STEP等compact，队列等handler，handler等STEP。新TURN抢占/额外send也不是同STEP恢复 |
| **native错误retry：H:600821–600990** | `InputTokenLimitError`只按instanceof命中（H:519455–519457）；外层最多5轮，每轮重新进入runStep，后者重新取STEP id | 不能把provider字符串改名或抛这个错误来“免费接通T32”；它结束原handle、采用另一retry层和新STEP，而非原ledger两attempt |
| **summary provider：H:752774–752788、750884–750887、518376–518453** | 专用external summary session无managed agentId；调用`getExecutor([system,user])`后`stream(ctx, undefined, undefined, {maxTokens:…})`，完整消费它自己的stream/response | 必须保留该Host-owned dedicated external路径。若profile将它重新route到当前managed STEP/同一busy执行器，资格失效；不得为避免此事另建summarizer |
| **existing background：H:596549–596604、596840** | 即使forceExternal=true，合法prefix的已有Promise仍会复用，包括self。force标志只决定新建时的选择 | 初版接缝保守拒绝任何非空pending/background状态；不清掉别人工作。probe证实force-external仍等既有self Promise、external新调用0。依赖当前STEP时会形成等待环；现有busy拒绝也可能失败，不能宣称必然可重入 |
| **summary lifecycle：H:743164–743224、750856–750889** | 本profile的ForwardingInteractionListener经Noop送summaryStarted/Completed，仅同步通知watchdog reset；不排main action、不等待App读回 | 这条通知不形成STEP依赖环；不泛化到其它interactionListener。变化后重资格；UI通知不等于摘要完成或已送用户 |
| **资源等待：H:596499、596640–596643、596775–596825、596873–596896** | project context、todo/blob读、可选preCompact hook、archive写、可选named-agent文档刷新都能await | 不是所有长等待都是死锁。默认Host config关闭executeHook且未设置named-document callback（H:619611–619616、750759–750887）；运行时若开启未资格化hook/callback/锁链则unavailable，不能偷偷关闭Host能力 |
| **checkpoint：H:591134–591145** | computeNewStructure先等previousPending；发布还经blob flush/Host checkpoint | 不把“等这个STEP结束才发布”的回调塞进compact路径。若要求额外持久化，其等待链须单独证明；本最小路径只读post-compact RAM snapshot |
| **取消/超时：H:596840–596904、751518–751546** | core在await生成后没有统一caller-signal commit fence；当前stream deadline可取消TURN。切片probe里依赖晚完成后仍写archive | 取消/过期/断线后必须禁resume/attempt1并失效delegate；如Host工作尚未静止，结果记unknown/may-have-compacted。Promise.race、finally或关闭socket不是Host回滚证明 |

**限定分支的wait graph：** main Host STEP → managed结果；modeld暂停attempt间恢复 → 当前Host closure；closure →独立external summary与Host资源；资源不依赖main结果。因此无该环。把closure换成queued action、同STEP self summary、或会等待main完成的hook/flush，就重新引入环。

还有两个语义陷阱：

- `WaitForCompletion`可以接受`hadError`的非abort Host fallback（H:596845–596860）；truthy返回值不是模型摘要成功。保留Host选择，披露fallback/unknown，独立验证snapshot变化/合法性/新模型预算；无改善、不适配或无法核对就不resume，不能以更短字节数冒充token合格。
- 一次Host compact invocation可能包含Host内部summary generation重试（H:518361、518636–518858）；“最多两次模型调用”只指**目标managed STEP的attempt0/1**，不是所有summary HTTP总和。summary成本/取消/期限须单列观察，不能另开无界时间窗。

## 3. blocked / unavailable 条件

缺少确切loaded profile/合法tuple/active root或system；delegate缺失/未ready/重复/退出；ctx取消、deadline不足、已放行文本/思考内容/工具；attempt0未终止或未确认释放其资源；root/selection/authority/binding变化；pending summary非空；external summary被managed捕获或其依赖不可用；未审preCompact/named-document/interaction/锁链；非法或缺metadata的state；无改善/预算不可判定/仍超限；未知compact完成——均无第二attempt。compact未开始的拒绝为0 invocation；已开始才失败的情况不能谎报0effect。

[前向state修正规格](../maintainers/managed-context-continuity.md)的F1/F2、错误制品一致性是此profile兼容性的实际门槛：当前source的singleton executor、丢summary metadata、invalid getter问题尚未修，core可调用不能豁免它们。不要求先完成其所有Memory产品验收、T29/T30/T31或HSO；只关闭本compact路径实际依赖的state/制品负例。

### Provider qualification 的边界

`PRIVATE_EVIDENCE`是source-family研究，不是当前CCS部署证明；它记录source/image/passthrough规则差异、message-only与code被剥掉等情形。其“medium message fallback”和按response.id关联的建议**不是D11授权**。

T32最小资格从被证明的结构化`context_length_exceeded|context_too_large`错误位置、对应HTTP/SSE surface、可信本地当前attempt关联开始；HTTP200的SSE失败不因此成功。auth/429/413/HTTP payload/output length/断线/unknown等冲突证据优先拒绝，即使另有overflow字样。缺code/仅message/candidate先保持unqualified，除非另有provider-specific非冲突资格；不从普通日志、provider自报id或API任意echo字段生成命令。当前CCS live mapping未核对，不能标已启用；本轮也不为此spend。

## 4. v4与实现验收落点

维持 [T32/S6.3](../roadmap/box-runtime-impl-spec.md#recovery-diagnostics) 的既定形状，不另设RPC/controller：

- 当前transport是**length-framed Unix stream**，不是Gateway HTTP。v3 client只写初始frame（`host/modeld-client.node.ts:80–186`）；server拒绝同帧多余字节和后续data（`modeld/server.node.ts:142–153,185–236`）。当前不能回传resume。
- v4原连接接收一个typed compact-request，并由当前client控制路径处理；不能等待Host terminal之后才分发。Host adapter通过上述approved closure取得新snapshot，再写同连接resume-step；server必须在等Host期间继续接收这一限定frame，不能让frame reader等住自身的STEP完成。
- attempt0先终止并证实quiescence，再调用Host；**保留原STEP occupancy/ledger**，但不持有会阻塞Host调用/接收resume的synchronized锁或旧producer资源。不能重新调用普通runStep清ledger/换STEP来制造attempt1。取消只停止后续effect，Host compact的外部结果可能仍unknown。
- tuple/nonce/期限/一次性消费、新snapshot、相同binding/selection再校验、唯一Host terminal遵循主票；失败未结算给Host之前不得形成本地error text。v4一次性替换所有caller/profile，旧v3拒绝0effect，无双版本降级。

实施必须新增以下红→绿用例到主票既定kernel/wire/bridge tests（**本轮尚未实现/运行**）：

1. production v4+kernel+approved Host delegate fixture：held main Promise.all尚pending，attempt0已终止、text/reasoning/tools=0 →直接core一个调用→post-root snapshot→同STEP attempt1→唯一terminal。独立确认原生summary使用dedicated session，不经过modeld main lease。
2. queued action、existing self/background、before-ready、额外hook等负例：在有界期限内unavailable，而不是把测试等超时算通过；明确0 invocation/0 resume/0 attempt1适用阶段。强制把direct delegate改成queued实现的mutant必须红。
3. duplicate/旧tuple/过期/重连/晚completion、取消发生在core前/生成中/接受后：取消后0 resume/attempt1，Host已写/未知完成单独报告，不伪造rollback。
4. root summary metadata/Host-selected tail保真、同根窗口回读、无变化/超预算/invalid getter；真实构建preload不能拿旧dist替代。失去metadata、错误当text或错误root的mutant必须红。
5. actual SDK HTTP/SSE fake验证provider classifier：401+overflow、429/413/output length、message-only/假response.id/错误字段echo均0 compact；summary fallback与summary内部重试计数不得偷算成managed attempt。
6. 保留主票既有codec/binding/lifecycle/stream/status/layout/Node20 pack、v3拒绝及Astra恢复authority复审。当前资格不能代替这些可执行检查。

## 5. 本轮证据与Go/No-go

本机 `PRIVATE_EVIDENCE`：静态TypeScript5.9.3解析，诊断0；VM只执行固定AST的orchestrator、main runStep的Promise.all表达式、runStream方法、Forwarding/Noop listener和原生disposable helpers。provider、privacy serde、store、资源、metrics/project policy为Fake，main结果为可控Deferred；**未import/start Host程序，未实现v4**。初次selector误匹配model-only等待点，已保留原结果但不计main资格；最终按owner=runStep唯一匹配H:600440–600447后重跑。

最终7个有界case：direct core在main pending期间完成；queued action在handler完成前不peek；force-external仍等pending self；preCompact hook可阻塞；caller取消后的迟到生成仍可写archive；Wait可接受hadError fallback；无system在summary前拒绝。所有人工held Promise释放并await；Node20进程退出0、stderr空，real network0；存储写入均Fake。它们证明限定等待关系及反例，**不证明所有真实资源都会完成**。

**给inv-pi：可以开始本页限定接缝的离线实现与T32原验收，不必继续泛搜“有没有compact方法”。** 这不是无条件GO：D2新增注册/释放patch须先明确批准；当前state/制品问题、exact bridge+v4、provider资格与上述负例完成前不能启用恢复。若执行任务尚未包含D2批准，则该patch子步blocked，kernel/Fake/codec等独立工作可继续；不要把本收据充当额外patch或live授权。

本轮仅交文档/资格。默认zero truncation、CAP unset、Host context assembly、confirmed-only、一回恢复、同TURN/STEP/账号模型绑定均未放宽；不重开历史context-loss A，不写runtime feature，不TERM/adopt、不live spend。
