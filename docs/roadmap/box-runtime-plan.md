# Box-runtime 实施方案

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

本文是 box-runtime **策略、Phases 0–4 与产品出口的 Current Home**。具体模块树、内部 ports、执行合同、退场清单与必需证明统一由 [单轨重建实施规格](box-runtime-impl-spec.md) 拥有；实现者按该规格和 T20–T33 施工，不从本文另造布局。票据只承载切片与交付证据。

产品义务遵循[产品合同 §12](../product-contract.md#12-box-local-model-runtime)，运行时边界遵循[设计](../box-runtime.md)与[架构 §17](../architecture.md#17-box-local-model-runtime)，重副作用遵循 [Effect 标准](../effect-box-runtime.md)。本文描述待建链条；源码与可执行测试拥有当前实现真相，不以计划存在证明交付。

## 2026-09-12 当前交付路线覆盖

本文保留架构策略和Phase 0–4，不再以旧“立即切片”重做已有代码。当前用户裁决是Server归属优先、只改Host、不改App、同原生Box会话可逆切官方/自定义模型；完整合同与依赖以[实施Spec S0](box-runtime-impl-spec.md#server-authority-rollout)为准。

沿同一票号序列新增[T37归属准入](../tickets/T37-server-ownership-admission.md)、[T38身份writer/test2](../tickets/T38-identity-write-alignment.md)、[T39原生往返](../tickets/T39-native-model-roundtrip.md)、[T40持久发布](../tickets/T40-persistent-release-and-rollback.md)。T24负责选择，T26/T32/T35/T36各交本域证据；T40服务隔离可与T39并行，最终发布才合取。test2已是冲突样本，不再沿用历史heavy canary授权；旧文档片段/测试计数均不能替代新门。

## 2026-09-18 单盒连续性北极星与完整实施路线

[Spec S13](box-runtime-impl-spec.md#continuity-north-star)是本轮替身/交接主线：及时发现Box归属丢失，默认暂停Routine并通知，按档位保全、尽力保真构造真实新Box状态，新Bot按职责接活，机械迁移关系并让旧Bot辅助指路，监控旧DM/群聊/任务结果入站至收敛，再按可证条件退役。不强求逐字一致，不把全关系完成作为上线门；unknown副作用只锁相关职责。

完整阶段已冻结为M0合同/资格→M1保护/快照/官方duplicate→M2唯一当前状态与clone→M3并行替身交接→M4旧入站收敛与退役→M5成套日用验收。M2b初始指令/临时spawn复用公共能力并独立交付，不要求先建完整通用平台。[CONT-00–11](../tickets/README.md#ownership-continuity)覆盖全部接受范围，不仅第一实验。单Bot保持长期Memory身份和唯一当前上下文；不做多session或跨机器。本轮是完整规划，现有实现/历史探针不能提升为现场闭环完成。

## 当前基线

本轮单轨重建基线为 `pre-publication-revision`；运行时代码仍为 `pre-publication-revision` 的状态，包含 `pre-publication-revision` 安全修复。下面列的是保留的产品性质/研究素材，不要求保留 POC 的内部接口或实现路径。

保留以下已有能力：

- T10/T11 的 per-agent managed opt-in、未覆盖 Bot 的 exact `originalSession` passthrough，以及 wrap 后的关联可见错误；不静默回官方。
- 当前 AI SDK OpenAI Chat/Responses 路径、受控 CCS canary，以及 T12 官方 renewer 传递与未覆盖产品能力的既有验证。它们不证明所有 Host/backend 版本均兼容。
- CCS-safe text、SendToUser bubble、tool stdout fold；Host 提供已选择、已 compact 的 `getExecutor` 上下文。不 prepend `store.db`，live 不设置 `GROKBOX_LIVE_PROMPT_*_CAP`。
- Unix chunk framing、Effect listen/sweep/stop 外壳、provider overflow **观察**、超限 envelope 可见拒绝；不默认截取近窗。
- A1 默认 prompt census、A2 provider 错误正文日志、A4 无 STEP 的 lastHandle replay 已在源码关闭。错误出口保持本地白名单，不恢复正文诊断。

继续处理以下缺口：

- **A3 follow-up（A3fu）仍为 P1**：`role=tool` continuation 已修，但 decoder 接受的 `user.content` tool-result 在 live codec 中仍丢失。
- A5 首次出门前的 binding revision、同 TURN 的 TTL/重启边界及服务 main fallback 尚未闭合。
- A6 默认原始 Host 输出文件、A7 固定 1500/8000 字符截断及正文关键词过滤尚在。
- A8 Host consumer 仍等全量 terminal；A9 Effect acquire/interrupt/finalizer 尚需收口。累计 1024 STEP 容量、EOF 补成功、fixture usage 不能成为长期运行合同。
- provider error 已不含正文，但缺少可用的本地请求关联；candidate classifier 不能驱动 compact。T13、T15、T16、T14b 依本计划交付。

源码修复不等于运行中旧进程、既有 fd 或遗留文件已处理。部署与 live 验证须另行授权；test1 保持未赋值，不扩大 canary。

## 架构与所有权

**Host 负责 Agent 产品；Host compatibility leaf 与 provider codec 完成双向归一化；grokbox 内核负责每个逻辑 STEP 的唯一准入与执行生命周期；CLI/WebUI 只调用共同用例。**

Host → Provider 保真传递 Host 已选择的上下文；Provider → Host 将模型输出重整为原有 PromptSession、session/executor 与 `fullStream` 合同，让 Host 继续管理会话、store、工具与 SendToUser。为这两个方向保留必要的 codec/normalizer 抽象，不把“薄接缝”解释成只转发 prompt 或最终文本。见 [ADR D1](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d1--bidirectional-normalization)。

```text
Grok Bot Host
  queue / Agent loop / root / selected context / compact
  tools / SendToUser / Transcript / Memory / Gateway publish
    │
    ▼
Host compatibility leaf（preload / 默认两处薄切片 / 同步 session ABI）
    │ Host identity + TURN + STEP + expected selection + ContextSnapshot
    ▼
grokbox admission / lifecycle kernel（runtime-kernel；modeld 是 transport/root）
    ├─ canonical configuration / activation authority
    ├─ turn binding / STEP-attempt ledger / limits / cancellation
    ├─ ModelBackend port ── AI SDK / Fake / 经准入的 pi、Cursor adapters
    └─ bounded inference events / safe observations
    │
    └─ provider events / outcome → Host normalizer → 原 PromptSession/fullStream
                                                    → Host 会话/store/工具/SendToUser

CLI ──────────┐
本盒 WebUI API ├─ shared config / control / observation use cases
              └─ canonical writers + confirmed coordinator + safe read models
```

- **Host 唯一拥有**：Agent loop、工具授权/执行、身份与 root assembly、上下文选择与 compact materialization、Memory/Transcript writer、SendToUser、官方 renewal 协议、Gateway publish。
- **grokbox 内核拥有**：per-agent admission、不可变模型绑定、credential 身份复核、输入验证/保真编码、provider invocation、输出归一化及流/取消/终态/unknown/退休。它交还 Host-compatible 结果，不接管 Host session/store writer。
- **grokbox 控制面拥有**：配置发布、兼容性验证与批准记录、获授权采用的 lease/artifact/guardian/信号/等待/commit/recovery。保留同一 coordinator，不增加第二个 Host process-mutation writer；CLI/UI 的配置保存仍进入共同用例。
- **客户端拥有**：用户意图、草稿和观察投影，不拥有模型绑定、运行状态或发布事实。事件与 status 是证据，不是恢复命令或配置权威。

维持一个 published `grokbox` 包；实施规格锁定新增私有 `runtime-kernel`，既有 `box-runtime` 承载薄 Host leaf、adapters 与 roots，CLI 只路由。按真实信任/生命周期隔离代码，不另增包家族或每 helper Service。POC 内部 API、旧 wire、dual tracks 与 compat shims 直接退场，不包住旧程序冒充新边界。Host compact 决定当前上下文窗口，长期事实由 Host-owned Memory 蒸馏承载；不以 store.db 历史补写抵消 compact，live caps 始终 unset。

## 执行顺序与共同门禁

```text
Phase 0：T20 最小骨架切割 → T21 输入保真（T22 raw fd 独立）
  → Phase 1：早期 T27 facets → DI / binding / Effect root / Host 真流 / Controller（默认主链止于此）
       ├→ Phase 2：命令边界/CAS 预置；浏览器 MVP deferred（非 T28 后默认施工）
       ├→ Phase 3：T16 backend qualification + implementation（不依赖 T29）
       └→ Phase 4：已确认 overflow 的 Host compact + 深层诊断
```

先完成 T20 的最小实体切割/import 门禁，紧随 T21 的 A3fu/A7；不把骨架扩成阻塞保真的全量平台重写，A6/T22 独立收尾。T27 最小 facets 在 Phase 1 最早交付，随后 T23–T26 接通 DI、binding、Effect root/A9 和 A8 真流，T28 闭合统一 Controller。各票依赖和退场截止见[实施规格 S8](box-runtime-impl-spec.md#tickets)。未齐能力显式拒绝，禁止旧内核兜底；中间单轨版本不部署。Phase 2–4 分别满足自己的依赖后推进，**不把 T29/WebUI 接在 T28 后面当默认主链**；Phase 4 **不等待所有 T16 backend 或完整 WebUI**。

按消融判断切片是否必要：D = 可诊断/可观测性，S = live STEP 稳定与安全，H = Host harness 变动下的可维护性。删除后损害任一轴的归一化、准入、流或资源边界应保留；不推动这些性质、也非当前产品出口必需的工件族、Service 层、全量退休/图表证明延后。不为“防过度设计”删掉核心合同，也不以完整架构外形作为首切前置。见 [ADR D12](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d12--ablation-guided-scope)。

每个切片接回唯一生产路径，记录具体性质、依赖现实、未证明项与退出条件。使用声明的 Bun `1.3.14` 作为 package manager 与本地 `bun test` / `bun run` / `bun scripts/*`，加上 frozen lock 和项目 typecheck/相关测试；生产 Host/modeld/CLI runtime/runtime-kernel 仍只用 Node-portable API。既有质量门失败须显式处理，不用局部 green 宣称整个 phase 完成。默认测试不得访问现役 Host、真实 credential 或 provider；需要时使用合成 Host、mock fetch、隔离文件/transport 与 disposable process。真实 canary、采用和 provider spend 另行授权。

## Phase 0：默认安全与输入保真

先按 T20 切出唯一 kernel/Host/adapters 树并撤销旧推理入口；保留 Host 产品 seam，不保留 POC 内部兼容面。紧接 T21 完成 A3fu/A7，不需要额外 Host patch 或 compact。A6/T22 可并行或随后完成，不作为保真及后续内核切片前置：

1. **A3fu：完整传递工具结果。** 同时处理 tool-role、user-contained 与混合 text/tool-result 内容。保留工具相关性、结果与错误事实，以 CCS-safe 文本编码；不能静默丢失结果，不能补一个 Human user 来通过测试。无法安全表达的输入在 provider effect 前明确拒绝。
2. **A7：去掉隐式选择策略。** 取消默认 1500/8000 字符截断及按 `SAND_HIDDEN`/`ack-redrive` 等正文词删除整行的规则。只有 profile 已验证的结构/provenance 才能标识控制消息；无法证明时不得把普通用户文本判为噪声。Host-selected 内容保真，超出明确安全预算可见拒绝，不自行缩窗。
3. **A6：关闭默认 raw Host sink。** 独立移除临时 supervisor 默认向 `/tmp/sand-host-adopt.err` 捕获 stdout/stderr 的行为，优先恢复默认 ignore；保留 T12 renewer allowlist 与传递。不为这个修复先建设诊断产品，也不以源码变更擅自清理运行中 fd 或遗留文件。

**出口**：

- T20 的包/目录/exports/import/退场门禁通过；未完成能力显式 not_ready，不假称 serving。默认路径无 prompt/error/Host-raw 正文 dump；A1/A2 安全回归保持。
- actual Chat 与 Responses 编码请求都保留 tool-role、`user.content` 混合 text/tool-result 及长结果尾部；无额外 Human user，无 raw `role=tool`。A3fu/A7 可先独立验收，A6 未完成不阻塞该出口；Phase 0 全部完成仍须关闭默认 raw sink。
- 用户引用控制词不会丢句；无 STEP 在已完成工具 STEP 之后仍拒绝，零旧工具 replay、零额外 dispatch。
- 不 re-adopt，不改变官方 renewal、非目标 Bot 路由或 Host compact。A8/A9 归 Phase 1，不计入本阶段完成声明。

## Phase 1：准入、Host 接缝与 Effect 生命周期内核

### 1.1 建立 RouteBinding 与薄模型选择字段

先在现有 session ABI 的构造入参/本地状态上携带少量有界字段：agentId、TURN、modelId 与 `selectionRevision`，让 `getModelId()`、STEP submit 与返回结果一致。复用现有有界配置读取和纯选择计算，不先建设 HostRouteProjection 文件族、额外发布器或修订数据库。完整 provider admission、canonical activation 和 credential 仍归 modeld；Host 不取得 secret 或自行访问 provider。见 [ADR D5](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d5--thin-host-visible-selection)。

`selectionRevision` 标识某 Bot 的有效选择，覆盖 opt-in、backend/model、endpoint、credential reference 身份、capabilities/限制及所需 codec。它不是全局配置时间戳、Host epoch 或 service generation；其它 Bot 的保存不应使已接受的 binding 失效。`configRevision` 只用于有第二 writer 后的防覆盖/CAS，不作为本切片的文件体系或服务前置。

按以下规则执行：

1. 首次 STEP 携 expected selection，modeld 从 canonical 配置验证 per-agent opt-in 与同一选择；在 request-specific credential/provider effect 前拒绝不一致。服务不以 `assignments.main` 为未覆盖 Bot 回退。
2. 通过后建立不可变 **RouteBinding**，包含有效选择、Host/TURN/service 关联与服务内 credential fingerprint。后续 STEP 借用该 binding，不重新选模型。
3. 普通配置更新影响下个新 TURN。deactivation、Host generation 变化、credential 身份不匹配仍可拒绝继续；不得换账号/endpoint 完成旧 turn。
4. TTL/服务重启后保留已证明 binding，或明确拒绝旧 TURN；不能用新 STEP 重新握手后静默 re-pin。新 TURN 可以握手新服务代。

保留一个窄配置读/改/保存入口、schema/gate 与基本原子发布，先按单 writer 路径推进，不声称它具有并发写保证。WebUI 或其它真实第二 writer 出现时，再在同一入口补足短锁、重读与 expected revision 检查；不要为尚未出现的并发先设计通用事务/CAS 服务。RouteBinding 的出门前核对现在就做，不能随 CAS 一起延期。

### 1.2 建立 ContextSnapshot 与 Host compatibility leaf

**ContextSnapshot** 只含 Host 已选择的当前输入：resolved root/system、selected messages、tool schema/相关性、generation constraints，以及 snapshot revision/digest。普通 messages/tools/options 数据不携带可执行函数、SDK session 或 credential。

建立两个方向的归一化链：

- **Host → Provider**：Host ABI decode → canonical snapshot validation → provider-specific encode。保真保留 Host-selected 内容，包括 user-contained tool-result；不静默截断、不重选历史。CCS codec 保持 text + SendToUser bubble + tool stdout fold，其它 adapter 只采用已验证的自身编码规则。
- **Provider → Host**：provider stream/result decode → canonical events/outcome → 原 PromptSession/session/executor/`fullStream` 形状。保持同步返回 handle、独立 response/usage、modelId 对齐、Array state/messages、工具 id 相关及 finish/response 一致性；由 Host 继续 append 会话、写 store、执行工具与 SendToUser。不以一个最终 string 或自建会话仓库替代原合同。

每个支持的 Host profile 必须证明 required root 的来源和恰好一次出现；只允许 profile 明确证明的空 root。无法判断 root 是否已在 executor state 中时标 unsupported/unproven，不静默当作没有。`rootPromptMessagesJson`、`sessionOptions`、`getExecutor` 私有形状仅留在 compatibility leaf，不进入 kernel/UI 合同；不得从 store.db 或多个隐式来源拼出另一份 root/history。

优先保留 CJS preload 和当前两处薄切片；**切片数量不是永久硬禁令**。当额外 Host patch 的稳定性或能力收益明显大于新增耦合时，允许扩展：明确目标 Host 版本、所需事实、影响范围与失效/退出路径，验证双向归一化、未覆盖 Bot 与恢复边界，并通过精确 profile 审查。当前代码仍按两处 profile 验证，扩展必须同时更新相关 schema/validator/contract tests，不能跳过现有 gate。见 [ADR D2](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d2--evidence-bounded-host-patch-surface)。

保留 source/anchor/transformed SHA 与 compile 校验；先用已有 source/profile、bridge digest、ABI/wire 特征固定兼容性，再按实际 Host/launch 变化补所需 supervisor/renewal 证据，不先铺满工件矩阵。候选生成、验证、批准与获授权采用分开；只匹配锚点不等于批准。

所需 root、turn-close 或 compact 事实不可得时，不编造数据或绕 gate；按收益/耦合规则评估额外 patch，未获证明和批准前停止受影响能力。未知组合在尚可返回 `originalSession` 时遵守 T11；已经 wrap 的 managed STEP 只拒绝/可见失败，出门后不 official replay。

### 1.3 建立 Effect DI 与 ModelBackend port

**本阶段即用当前 AI SDK adapter + Fake 建立共同 DI 合同。** Phase 3 只新增合格实现，不再次设计 admission 或另一套 registry。

| 能力 | 合同与 owner |
|---|---|
| 配置/保存 | runtime 用例拥有 parser、引用与 desired gate；Effect 能力提供所需 IO。第二 writer 出现后在同一入口补轻量防覆盖，不为每个文件锁建立 Service。 |
| Activation authority | 内核读取 committed/pending/disabled/unavailable 事实；control owner 写入。provider adapter 不获得签字/进程权限。 |
| Credential/auth | service/backend 内部 scoped access 与身份/fingerprint 校验；secret 不进入 pin DTO、IPC、日志或 UI。 |
| **ModelBackend** | 接受已 admitted 的单次推理输入，产出 typed failure 与 bounded inference events；不执行工具、不写 Host 数据。 |
| Observation/control facade | runtime owners 提供安全观察与 operation receipt，CLI/API 复用。Layer 只选择实现，不决定产品状态。 |

Effect Service 就是 canonical Port，精确落点/操作见[实施规格 S3](box-runtime-impl-spec.md#ports)；不复制同义 Promise Port 与 Service，不保留 ModeldDriver/As1 的兼容包装。Fake/Live Layers 替换能力，不替换业务程序。纯 hash/parser/codec 保持 TS，Promise/iterator facade 只用于 Node、Host、HTTP 边界。沿用 `effect@4.0.0-beta.107`，不顺带升级。

```text
grokbox process root Scope
  ├─ owned listener / accepted clients / authorized backend resources
  ├─ config / authority / credential capabilities
  ├─ turn binding owner
  ├─ STEP-attempt Scope：admit → credential → provider stream → terminal/unknown
  └─ bounded housekeeping / observation

confirmed coordinator operation Scope
  └─ lease / artifacts / guardian parent handle / signals / waits / receipts
```

每个真实进程/命令一个运行根，不在每个 Bot/request 创建 Runtime；官方 Host/preload 保持 **Effect-free、SDK-free**。turn 共享资源不受首个 STEP 的取消意外支配。Layer 构造/readiness 不隐式发模型请求；backend 启动/认证资源有明确权限与 owner。

在 Phase 1 接入/扩展长寿命 Effect root 时，**同一生命周期切片闭合 A9**：acquire 与 finalizer 注册成对、partial acquire 可收尾、启动失败/abort/stop 对称释放 Scope 与 listeners。这是低成本的必要边界，不因外层仍有 Promise facade 而略过，也不要求为此重写所有纯逻辑。停止服务先拒绝新工作，再有界取消/drain，释放 owned resources；不等待不合作的外部 driver 永远结束，保留 unknown。不要把旧 Promise/timer 编排包一层 Effect 就宣布完成。见 [ADR D8](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d8--effect-root-and-resource-ownership)。

控制面按 T28 将保留的安全性质重建成一个 Effect Controller operation program，旧 coordinator/inject/manual 执行器退场；独立 guardian 保留，不改成随父进程死亡的 Fiber。**J13 保持 Host append / watchdog compact**，不借本阶段改 journal placement 或新增 terminal-report IPC。

### 1.4 接通流、终态与安全退休

每个逻辑 STEP 只有一个 admission/dispatch owner，当前默认一个 attempt。adapter 不自行 retry、failover 或换模型；T14b 的恢复例外由 Phase 4 的明确 attempt 协议控制。

**Provider 支持流式输出时，在 Phase 1 完成 A8 真流与 Host `fullStream` consumer。** 官方 Host 的 Transcript/SendToUser 消费链是 stream-oriented，不能将它视为仅 TTFT 美化而后移。Provider 只能 batch 时明确披露 buffered 能力，仍归一化为原 Host handle/fullStream 合同，不伪造 provider streaming。见 [ADR D7](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d7--true-streaming-in-phase-1)。

- 接通 provider → canonical events → Unix → Host normalizer/consumer。为 active concurrency、全链路 bytes/parts、背压和慢 reader 设界；wire terminal 只带终态/usage，不再重复运输全文。Host response/usage 完成不依赖 UI reader。
- 保留 text/reasoning、tool-call 相关性与完整终态。区分 stop、tool-calls、length、error、cancel、unknown；EOF 缺 terminal 不补成功。验证工具参数/并行策略后才按 Host 合同放行；reader replay 不变成再次执行工具。
- usage 未提供则 unavailable；若 Host ABI 必须接收数字，兼容投影不得被当成真实计量。当前 fixture 数字不能进入预算/费用承诺。
- 分开 envelope bytes、encoded request bytes、system/messages/tools 大小、可信 token limit 与 response reserve。传输上限不是 context window；字符数不是精确 tokens。预算未知如实标识，不能按模型名猜窗口。
- 分开 request timeout、turn binding 寿命、短期 replay 与 refusal/tombstone 退休。保留重复 STEP 拒绝与跨服务代 fencing，不随机逐出旧 id 后重投。建立合法 closed-turn/epoch 退休规则；缺少可靠关闭边界时保守拒绝并披露容量，不能承诺无限期精确去重。

每次 wire 变更只留下一个当前版本，旧 bridge/protocol 明确拒绝；不保留临时旧 codec、协商降级或双 server。新 bundle/profile 与调用方整体通过离线证明、获授权后采用；具体 v3/v4 切换见[实施规格 S4/S6](box-runtime-impl-spec.md#wire)，文档本身不授权 live cutover。

### 1.5 早期交付 T13 最小 facets 与安全 correlation

从 Phase 1 开始明确并实现这组最小语义，可与 RouteBinding 分切片并行；不等可写 UI 或深层诊断才补。优先复用现有 `model_step_terminal` 的 Host/Bot/TURN/STEP tuple，在 kernel 已校验的边界补必要 ServiceEpoch、selection/binding 关联、phase/dispatch state 与 gap，不先建完整 trace graph。provider 错误只给本地枚举，不从 error body 信任关联字段、不恢复正文、不按时间最近邻猜因果。

在共同 status/observation 用例中立即分开：

- bridge/activation evidence；
- modeld readiness；
- controller liveness；
- mutation permission/inhibit；
- operation recovery；
- Host delivery observation。

当前代接缝证据完整、没有实际未决 operation，但遗留 circuit 仍 open 时，表达“接缝有证据、后续变更受限、controller 存活未证明”；不清 circuit、不涂全绿。实际 journal pending/invalid/unavailable 仍为 recovery/unknown，不被旧 attestation 覆盖。T27 用单一新 DTO 表达 facets/reasons，不再保留 `watchdog.state=degraded` 的旧聚合兼容解释；circuit 自身事实不删除。前端不得自行改义。

### Phase 1 出口

1. 首次 STEP 的选择竞态（同 modelId 改 endpoint/ref、移除覆盖等）在错误 credential/provider effect 前拒绝；其它 Bot 配置变化不误失效当前 binding，T10 exact passthrough 保持。
2. 长工具空档、首 STEP 取消、TTL、service restart、重复 STEP 不导致旧 TURN 换 binding 或重复 dispatch。
3. 两个自行编写、state/root/reader 顺序不同的 Host-shaped adapters 复用同一内核；输入保真，返回对象满足原 PromptSession/session/fullStream，required root 缺失拒绝、出现时恰好一次。额外 patch 若采用，须有收益/耦合、精确 profile 与双向合同证明；实际 preload 保持 Effect/SDK-free。
4. 在支持 streaming 的 Provider 上，terminal 被 barrier 阻住时 Host reader 已见首 chunk，且 Host 消费链能继续处理 Transcript/SendToUser；慢/晚 reader 不阻塞 completion，取消/断线无迟到成功或额外工具。buffered Provider 不冒称真流，EOF 与 usage unknown 如实表达。
5. 长寿命 root 的 partial acquire/失败/中断/stop 无 orphan listener、socket、Fiber 或 backend process；只释放 owned resource。
6. 达到容量上限时明确拒绝且可观察，旧身份不可重投；不把完整历史退休体系设为 RouteBinding 首切门槛。声明持续运行超过当前 1024 STEP 限额前，再提供合法退休、旧 id 拒绝与有界 soak 证据，不承诺无限精确去重。
7. 薄模型选择字段、safe correlation 与 T13 最小 facets 早期交付且可由 CLI/API 同义消费；日志缺失/截断不冒充“没有调用”。第二 writer 尚未引入时，WebUI CAS 不是本阶段出口。

## Phase 2：共享命令边界与 WebUI MVP（T15 / T29，默认主链外）

**2026-09-12范围更新：** T41持续观测、SQLite与incident在浏览器之前交付，[Spec S0.1.4](box-runtime-impl-spec.md#continuous-observation)拥有数据/权限合同。未来页面与交互详细要求已归[future/webui-console](future/webui-console.md)，本节保留策略与接口边界，不维护第二份UI排期。新增一个有实际管理职责的DB，不等于引入SQLite配置/执行SSoT。

### 2.1 固定 SoT 与有限命令面

在盒内提供 loopback API/VNC 运维 console。canonical models/desired、control artifacts 与 Host 产品 stores 继续拥有事实；status/events 是观察，browser cache 是投影。API 不直写文件、不读 Host SQLite/ABI，也不通过 daemon/SSH/generic exec 转发 runtime mutation。

固定 **同盒** roster 来源与 runtime root，不混用任意 current Profile 的 Bot 与本机 assignments。稳定 agentId 用于提交；身份不确定则阻止写入。catalog GET 只提供安全选项、配置状态与能力披露，不返回 secret、任意 apiKeyRef 路径、带凭据 URL 或原 `models.json` 全对象。

引入 WebUI 这个第二 writer 时，在 Phase 1 的窄配置入口补**最小防覆盖闭环**：短锁 → 重读 canonical models/desired → `configRevision`/expected revision 检查 → 同一 parser/业务 gate → unique staging 与原子发布 → source receipt。CLI 与 API 都走此入口；不同进程/同进程并发及旧 revision 冲突必须被覆盖，不只串行浏览器内部请求。不增加通用事务服务、多文件版本族或第二配置 SoT；若此前已出现真实并发 writer，按同一条件提前补此闭环。见 [ADR D6](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d6--simple-anti-overwrite-at-the-second-writer)。

保存失败保留真实 partial/unknown，不用旧 JSON 回写伪造回滚；客户端保留草稿并重读，不自动覆盖。UI 复用 Phase 1 早期交付的 T13 最小 facets，不临时解释健康语义。CLI/API 共用以下 typed use cases：

| 能力 | 行为 |
|---|---|
| 读 runtime/roster/catalog/evidence | 有界只读快照，保留 source、observedAt、stale/unknown/partial/gap；合并重复采样，不按每个组件重复重 IO。 |
| 保存 Bot 模型选择 | 明确 agentId + expected revision，走共同 CAS；返回 source receipt，不宣称当前 turn 已切换。 |
| Prepare | ensure modeld、写 desired、一次已允许的 reconcile；不隐式 apply、发 canary 或调用 provider 检查。 |
| Preview / confirmed apply | 只读 preview；一次明确确认后调用既有 coordinator，执行前重验目标与权限。 |
| 读 operation receipt / 最近事件 | 用原 operation identity 对账，保留 partial/recovery-required/unknown；不是新执行队列。 |

GET 不调用 start/watchdog tick、不 compact 日志、不修复、不解析模型 credential 或产生模型花费。

### 2.2 明确授权、操作与进程 lifetime

首次开放 API 前建立独立 console 会话认证、精确 Host/Origin 校验、CSRF/跨站 WebSocket 防护、请求大小/速率界与安全内容渲染。浏览器认证不复用 provider/Gateway/daemon/Sandbox credential，不在 URL/argv 传秘密；不暴露 raw exec/RPC、任意路径/Profile 或 credential editor。

prepare 与 apply 分开。CLI 沿用 `runtime re-adopt --confirm`；WebUI 的一次确认调用同一受控本地用例，不增加独立 mutator。确认绑定本盒目标、desired/profile/Host/config 修订及短有效期；变化后重读/重确认。一次授权对应唯一 operation identity；双击、重连、ack 丢失先查询原操作，不再次 dispatch。`ok:true`/exit 0 不抹掉 recovery-required；没有回执不等于没有执行。

长期runtime/monitor/control root持有资源与操作，console HTTP仅持有请求等待/订阅；collector不随console退出而消失。只停止自己启动的 modeld，复用服务视为 borrowed resource。浏览器关闭不停止服务、不取消已授权操作；console 退出不等于恢复官方 Host。crash/restart 从 canonical journal/receipt 观察 unknown，不从 cache/outbox 自动重放。confirmed apply 的共享 owner、lease、guardian 与收尾证明先于开放写权限，不要求先重建全部无关控制面。

### 2.3 未来页面与数据边界

页面范围、URL状态、快照→订阅、草稿/冲突和真实浏览器验收统一见[Web UI未来合同](future/webui-console.md)：单Box概览/能力、Bot详情、事件/incident和操作结果。harness只读；supported/desired/effective、saved/actual TURN分开。原版App消息/Working不被自建Web UI取代。

未覆盖Bot不继承main；逐Bot回官方最终依T24 reset能力开放，不把当前route限制固定为未来产品规则，也不偷做全局deactivate→reset→activate。第二writer防覆盖仍在同一ConfigurationWrite。

旧“MVP不使用SQLite/全部可丢弃索引”已由[Spec S0.1.4](box-runtime-impl-spec.md#continuous-observation)细化：T41在UI前保存观测、变化、incident及通知回执；current projection可重建，历史/ack不能假称随时可丢。浏览器/API不能直接写库，DB不能恢复配置/pin/准入或成为自动任务outbox；J13与Host stores不搬迁。长期图表、额外渠道、多盒等放[future](future/README.md)，不进入首版。

### Phase 2 出口

- CLI/API 同义、两个 writer 不丢更新；错 Profile/错盒/过期 revision 不写入。
- auth/Origin/CSRF 拒绝与 GET 零写/零信号/零 spend 有测试；响应、日志、缓存和导出均无凭据/原始 provider 正文。
- preview drift、双击、断线、ack 丢失、reload 不重复 apply、不误停 borrowed modeld、不伪造成功。
- saved、ready、last observed、delivered分开，unknown/stale保留；每个按钮只按其当前用例的真实资格开放，不将旧reset限制当永久规则。
- 可先交付安全只读 console；可写选择、可靠切换、confirmed apply 分别通过相应门禁后开放。

## Phase 3：准入并实现额外 ModelBackend（T16）

复用 Phase 1 已完成的 Effect DI、ModelBackend port、binding、ledger 与 events。逐个处理 **pi JSON-RPC** 和 **Cursor SDK** 候选，不以扩展 backend 为由增加第二 Agent loop。

1. 钉住 Pi 的实际 RPC 协议/版本、Cursor 的具体 SDK/package 与本地/云端执行面；按真实合同实现，不从名称推导 Codex app-server 方法或 JSON-RPC 2.0。
2. 准入前证明一次推理可接收明确 snapshot/tools/options，不自行执行工具、加载另一个 root/Memory/history、自动 compact、重试/failover 或创建/修改仓库。不能满足则标 unsupported/deferred，不强行返回最终 string 伪装兼容。
3. backend session id 只是私有资源身份，不替代 Host TURN/STEP。默认不复用带隐藏会话状态的 session；复用前证明精确设置/重置、无重复历史、跨 Bot 隔离、取消/重启不续跑未知请求。连接资源由 service Scope 拥有。
4. backend 选择采用有限、版本化配置，不动态加载任意模块/command。区分 backend kind、provider API mode、上游 model 与 auth 类型；只按必要差异扩展同一 catalog schema，不将 HTTP endpoint/apiKeyRef 假设强加非 HTTP backend，不改变 T10 opt-in。
5. 维护共同 conformance 用例：工具调用/参数关联、vision 与不支持内容、serial/parallel policy、stream/cancel、auth 身份、context-limit 证据、usage availability。接口相同不表示能力相同，未证明能力明确拒绝。

**出口**：每个准入 adapter 经同一 production kernel 的 Fake/Live graph 通过合同、状态隔离、取消/资源关闭与零工具执行证明；CLI/WebUI 不出现 backend 私有状态或第二配置规则。transport/SDK 验证不隐式获得 live spend 权限；一个候选受阻不阻塞其余主链。

## Phase 4：本地上下文维护、溢出兜底与深层诊断

**2026-09-17当前目标：** [Spec S12](box-runtime-impl-spec.md#context-maintenance)/[CTX-00–CTX-04](../tickets/README.md#context-maintenance)拥有默认主动compact；M0先验证真实Pi core公共组件、必要最小补丁/受控提取，不是只借鉴后从头写算法。旧失败长会话的下一条普通输入必须先按本地工作预算检查/维护，再处理该消息一次；不等待真实上游拒绝、成功usage或新建会话。Host仍拥有材料/root/checkpoint，kernel拥有统一维护程序；先交付有界安全点阻塞维护，后台预生成不是前置。源码与新配置/命令仍待实现，规划不等于上线。

### 4.1 T14b / T32：保留一次受控失败恢复

本阶段依赖 Phase 1 的 binding/lifecycle/error 合同、已验证 Host compact seam，以及另行授权获取的 provider-specific 样本。**不依赖完成所有 T16 backend 或完整 WebUI。**

`overflowCandidate` 只用于观察，不能直接授权 retry。由当前 attempt 的 typed backend outcome、有限分类、完整关联及非冲突证据确认 **context overflow**。auth、429、generic 400/500、HTTP payload too-large、timeout/断线/unknown 均不授予失败恢复compact/重试；不能从普通 `model_error` 或 durable 日志行重建恢复命令。新的普通输入仍可因独立本地预算证据触发S12主动维护，不能把“错误不授权恢复”误读为“失败会话永远不能compact”。

执行唯一恢复链：

```text
已确认 context overflow + 原 attempt 已终止 + 无已放行工具/用户交付
  → 请求 Host 自有 compact（同 TURN/binding、有来源的目标预算）
  → 取得新的 Host-selected ContextSnapshot
  → 重新验证 binding / snapshot / authority
  → 至多一个 recovery attempt
  → 正常 terminal 或可见失败
```

无法证明没有已放行副作用时禁止自动恢复。使用本机 attempt identity 保留原 Host TURN/STEP 关联、更新 snapshot hash，并在同一 ledger 限制一次预算；不新造 Host invocationId、不清旧记录绕过去重。重复 compact completion/重连不再 dispatch。

Host维护不可用、取消、候选无改善/不符合预算、或一次retry后失败时明确结束，不循环重发业务。摘要与合法root接受使用S12同一有界维护程序，不另建provider侧历史或备用summarizer；长期Memory仍归Host。用户错误保持固定可见白名单。样本不足或 seam 未证明时维持 open/unavailable；需要额外 patch 时遵守收益/耦合审查与精确批准，不以恢复需求绕过 gate。见 [ADR D11](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md#d11--confirmed-overflow-host-recovery)。

### 4.2 完成 T13 深层诊断

沿 Phase 1 的 facets 补安全 active/terminal 关联、source-emitted 时间/usage availability、事件 retention/cursor/gap 与 operation 恢复证据。源身份、范围、代与序列未对齐时不推导完整时间线、错误率或 publication backlog。

只在可靠只读能力存在时观察 Host transcript/publish watermark；Gateway PID、模型 finish、Host normalize 均不等于 SendToUser 已执行或 App 已显示。缺能力显示 not_observed。publish pending 不触发模型重投、SendToUser 重放或 re-adopt，绝不写 Host 发布游标。

兼容性持续观察与 mutation 分开：检测 Host/bridge/launch 合同变化，产出 changed/missing/unproven 事实；重新验证和显式批准后才能采用，不把现有含 TERM 的 helper 直接放进 timer。后续获授权的 adopted Host 验证同时覆盖 managed canary、未覆盖 Bot、create-bot/privacy 与官方 renewal。

**出口**：S12本地窗口与旧会话下一输入的CTX矩阵必须通过，即使Fake provider从不报overflow也先主动维护；另保留confirmed overflow → 同一Host维护 → 新snapshot → 一次retry的离线闭环，其它错误本身不授予恢复。重复/取消/无改善均有停止证明。T13 不清 circuit、不隐藏 pending/unknown，不把采样、缓存或模型终态升级为 Host delivery 权威。

## 票据与实施对应

当前序列以[Ticket索引](../tickets/README.md)为准。T41是Web UI之前的持续观测/SQLite/incident，不接管T37安全准入；T40收长期运行最低闭环，T29未来仅消费。以下历史Phase映射不新增第二排期。

本轮执行采用 **T20–T33 新票据**，不重用旧 T2/T4 的交付意义。A3fu/A5–A10 仅用于追踪原 finding；历史 done 仍为 done，旧 open 产品票作范围索引。唯一详细依赖与证明映射见[实施规格 S8/S9](box-runtime-impl-spec.md#tickets)和[票据索引](../tickets/README.md)。

| 策略范围 | 实施票据 | 阶段 |
|---|---|---|
| 骨架切割、保真、独立 raw-fd 修复 | T20 / T21 / T22 | 0 |
| ModelBackend DI、RouteBinding/STEP、A9 root、A8 Host 流 | T23 / T24 / T25 / T26 | 1 |
| T13 最小 facets、统一 Controller 与整合出口 | T27（尽早）/ T28 | 1 |
| T15 共同用例、第二 writer CAS；浏览器 MVP deferred | T29 | 2 deferred |
| T16 pi/Cursor 独立资格与 adapter | T30 / T31 | 3 |
| Pi组件复用资格、本地窗口/主动维护、旧会话下一消息 | CTX-00–CTX-04，Spec S12 | 4 当前规划 |
| 进程内pi-ai替换模型传输的离线资格 | PI-AI-01，Spec S6.2.1；不是T30 RPC或CTX前置 | 独立候选 |
| T14b confirmed-overflow 兜底、T13 深层证据 | T32 / T33（Host安全基础T35） | 4 |

T10–T12 与 A1/A2/A4 的产品性质全程回归；已完成 POC ticket 不是保留旧实现的理由。

## 非目标与禁止事项

- 不重建 Host loop/tools/root/compact/Memory/Transcript/SendToUser/官方 renewal/publish，不 prepend store.db，不设置默认 live 近窗 caps。
- 不将已知拒绝的 Responses raw `role=tool` 恢复为 CCS 通用路径，不用正文关键词、40ms 延迟或无 STEP replay 充当协议。
- 不建第二 admission/reconciler、`effectMode`、SDK 内部 Agent loop/隐式 retry；不把 Scope 当跨文件事务或 crash recovery。
- 不引入SQLite配置/身份/执行权威、UI assignment table、自动任务/控制outbox、通用provider/插件平台或新npm包家族。T41允许本域观测/incident/通知回执，不因此获得模型/Host写权限；纯shadow不双真实dispatch。
- 不在 Host/preload 加 Effect/SDK，不改变 J13/独立 guardian 的边界；不未经收益/耦合审查增加 Host patch，也不把“两刀”当成永久硬禁令。未证明能力停止受影响路径，不猜接口。
- 不先建设模型选择投影文件族、第二 writer 尚未出现的复杂 CAS/事务层或无 D/S/H 收益的架构外形；必要双向 codec、Phase 1 真流和 A9 资源边界不属于可删装饰。
- 不以 UI 超时、缺事件、candidate overflow 或 publish pending 自动重发/compact/re-adopt；不自动关 circuit、批准未知 profile 或转发远程 runtime mutation。
- 不以本计划或 offline green 授权 live spend、re-adopt、test1 opt-in、遗留数据清理或已部署能力声明。

## 立即执行的两个切片

先读[单轨重建实施规格](box-runtime-impl-spec.md)，它是施工依据；不要从本策略文档重新推导 ports/布局，也不把 owner 决策另挂成补丁附录。

1. **[T20 骨架切割](../tickets/T20-runtime-layout-cut.md)**：直接建立唯一目标 package/module/import 树，撤旧推理入口与 compat shims，建立结构/pack/proof gate。未齐能力显式拒绝，不包 POC 兜底，不部署中间状态。
2. **[T21 codec 保真](../tickets/T21-runtime-codec-fidelity.md)**：在新 owner 落点修 A3fu/A7，用真实 SDK 编码的 Chat/Responses body 与负对照验收。T22/A6 独立穿插，不 gate 保真。

随后按规格先交付 T27 最小 facets，再接 T23–T26 DI/binding/Effect root/真流与 T28 Controller；所有必需 proof、退场与 Astra 复审完整后才关闭 Phase 1。T29 不在 T28 后的默认主链上。WebUI、额外 backend、T14b 按自己的依赖推进，后者不等待所有 backend。本文维护策略，规格维护施工合同，票据维护证据，不另起日期版实施路线。
