# Box-runtime 实施方案

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

本文是 box-runtime **后续实施顺序、合同与验收出口的唯一 Current Home**。按本文推进，票据只承载对应范围与交付证据，不维护另一套路线。

产品义务遵循[产品合同 §12](../product-contract.md#12-box-local-model-runtime)，运行时边界遵循[设计](../box-runtime.md)与[架构 §17](../architecture.md#17-box-local-model-runtime)，重副作用遵循 [Effect 标准](../effect-box-runtime.md)。本文描述待建链条；源码与可执行测试拥有当前实现真相，不以计划存在证明交付。

## 当前基线

实施基线为 `pre-publication-revision`，包含 `pre-publication-revision` 的安全修复。

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

**Host 负责 Agent 产品；Host compatibility leaf 只做版本适配；grokbox 内核负责每个逻辑 STEP 的唯一准入与执行生命周期；CLI/WebUI 只调用共同用例。**

```text
Grok Bot Host
  queue / Agent loop / root / selected context / compact
  tools / SendToUser / Transcript / Memory / Gateway publish
    │
    ▼
Host compatibility leaf（preload / 两处精确切片 / 同步 session ABI）
    │ Host identity + TURN + STEP + expected selection + ContextSnapshot
    ▼
grokbox admission / lifecycle kernel（modeld / box-runtime）
    ├─ canonical configuration / activation authority
    ├─ turn binding / STEP-attempt ledger / limits / cancellation
    ├─ ModelBackend port ── AI SDK / Fake / 经准入的 pi、Cursor adapters
    └─ bounded inference events / safe observations
    │
    └─ Host-facing stream / outcome → Host 执行工具与产品交付

CLI ──────────┐
本盒 WebUI API ├─ shared config / control / observation use cases
              └─ canonical writers + confirmed coordinator + safe read models
```

- **Host 唯一拥有**：Agent loop、工具授权/执行、身份与 root assembly、上下文选择与 compact materialization、Memory/Transcript writer、SendToUser、官方 renewal 协议、Gateway publish。
- **grokbox 内核拥有**：per-agent admission、不可变模型绑定、credential 身份复核、输入验证/保真编码、provider invocation、流/取消/终态/unknown/退休。
- **grokbox 控制面拥有**：配置发布、兼容性验证与批准记录、获授权采用的 lease/artifact/guardian/信号/等待/commit/recovery。保留同一 coordinator，不增加第二 writer。
- **客户端拥有**：用户意图、草稿和观察投影，不拥有模型绑定、运行状态或发布事实。事件与 status 是证据，不是恢复命令或配置权威。

保持现有 private workspaces 与一个 published `grokbox` 包。按变化、信任与生命周期边界隔离代码，不为每个名词生成新包或 Service。

## 执行顺序与共同门禁

```text
Phase 0：默认安全与输入保真
  → Phase 1：binding / Host leaf / Effect DI / lifecycle / stream
       ├→ Phase 2：共享命令边界上的 WebUI MVP
       ├→ Phase 3：T16 backend qualification + implementation
       └→ Phase 4：已确认 overflow 的 Host compact + 深层诊断
```

Phase 2–4 分别满足自己的依赖后推进。T13 最小状态语义从 Phase 1 开始，先于可写 WebUI；Phase 4 **不等待所有 T16 backend 完成**。安全只读 console 可提前准备，不把全量控制面重构设为只读前置条件。

每个切片接回唯一生产路径，记录具体性质、依赖现实、未证明项与退出条件。使用声明的 Bun `1.3.14`、frozen lock 和项目 typecheck/相关测试；既有质量门失败须显式处理，不用局部 green 宣称整个 phase 完成。默认测试不得访问现役 Host、真实 credential 或 provider；需要时使用合成 Host、mock fetch、隔离文件/transport 与 disposable process。真实 canary、采用和 provider spend 另行授权。

## Phase 0：默认安全与输入保真

保持现有两处 Host seam 不变，完成三个局部修复，不引入新 hook 或 compact：

1. **A6：关闭默认 raw Host sink。** 移除临时 supervisor 默认向 `/tmp/sand-host-adopt.err` 捕获 stdout/stderr 的行为；保留 T12 renewer allowlist 与传递。确需诊断时使用独立 opt-in、受保护、有界的能力，不把原始输出捕获作为产品启动依赖。
2. **A3fu：完整传递工具结果。** 同时处理 tool-role、user-contained 与混合 text/tool-result 内容。保留工具相关性、结果与错误事实，以 CCS-safe 文本编码；不能静默丢失结果，不能补一个 Human user 来通过测试。无法安全表达的输入在 provider effect 前明确拒绝。
3. **A7：去掉隐式选择策略。** 取消默认 1500/8000 字符截断及按 `SAND_HIDDEN`/`ack-redrive` 等正文词删除整行的规则。只有 profile 已验证的结构/provenance 才能标识控制消息；无法证明时不得把普通用户文本判为噪声。Host-selected 内容保真，超出明确安全预算可见拒绝，不自行缩窗。

**出口**：

- 默认路径无 prompt/error/Host-raw 正文 dump；A1/A2 的安全回归保持通过。
- actual Chat 与 Responses 编码请求都保留两种工具结果形状及长结果尾部；无额外 Human user，无 raw `role=tool`。
- 用户引用控制词不会丢句；无 STEP 在已完成工具 STEP 之后仍拒绝，零旧工具 replay、零额外 dispatch。
- 不 re-adopt，不改变官方 renewal、非目标 Bot 路由或 Host compact。A8/A9 归 Phase 1，不计入本阶段完成声明。

## Phase 1：准入、Host 接缝与 Effect 生命周期内核

### 1.1 建立 RouteBinding 与共享配置发布

区分两个修订：

- **`configRevision`**：canonical 配置的 CAS 标识，供 CLI/UI 防止读改写丢更新。
- **`selectionRevision`**：某 Bot 有效选择的标识，覆盖 opt-in、backend/model、endpoint、credential reference 身份、capabilities/限制与所需 codec。它不是 Host epoch、service generation 或时间戳。其它 Bot 的无关配置变化不使已接受的 binding 失效。

配置 writer 发布最小无秘密 **HostRouteProjection**，供同步 `getModelId()` 读取 agent/modelId/selectionRevision。Host 不解析完整 provider catalog，不取得 secret 或 canonical activation 文件。projection 是派生读模型，不增加配置权威。

按以下规则执行：

1. 首次 STEP 携 expected selection，modeld 从 canonical 配置验证 per-agent opt-in 与同一选择；在 request-specific credential/provider effect 前拒绝不一致。服务不以 `assignments.main` 为未覆盖 Bot 回退。
2. 通过后建立不可变 **RouteBinding**，包含有效选择、Host/TURN/service 关联与服务内 credential fingerprint。后续 STEP 借用该 binding，不重新选模型。
3. 普通配置更新影响下个新 TURN。deactivation、Host generation 变化、credential 身份不匹配仍可拒绝继续；不得换账号/endpoint 完成旧 turn。
4. TTL/服务重启后保留已证明 binding，或明确拒绝旧 TURN；不能用新 STEP 重新握手后静默 re-pin。新 TURN 可以握手新服务代。

CLI/UI 共用一次配置 mutation 程序：短锁 → 重读 models/desired → expected revision 与业务 gate → unique protected staging → read-back/sync/rename → source receipt。现有 CLI writer 同步接入，不只给 UI 加锁。配置/projection 多文件发布不宣称原子事务；失败返回真实 partial/pending，读端错配拒绝，不回写旧文件伪造回滚。不同客户端冲突保留意图并重读，不自动覆盖。

### 1.2 建立 ContextSnapshot 与 Host compatibility leaf

**ContextSnapshot** 只含 Host 已选择的当前输入：resolved root/system、selected messages、tool schema/相关性、generation constraints，以及 snapshot revision/digest。普通 messages/tools/options 数据不携带可执行函数、SDK session 或 credential。

把转换隔离为三段：Host ABI decode → canonical snapshot validation → provider-specific encode。内核决定“能否送、如何保真编码”，不决定“留哪段历史”。CCS codec 保持 text + SendToUser bubble + tool stdout fold；其它 adapter 只在验证自己的能力后编码，不继承未证明的 endpoint workaround。

每个支持的 Host profile 必须证明 required root 的来源和恰好一次出现；只允许 profile 明确证明的空 root。无法判断 root 是否已在 executor state 中时标 unsupported/unproven，不静默当作没有。`rootPromptMessagesJson`、`sessionOptions`、`getExecutor` 私有形状仅留在 compatibility leaf，不进入 kernel/UI 合同；不得从 store.db 或多个隐式来源拼出另一份 root/history。

保留 CJS preload、两处精确切片、source/anchor/transformed SHA 与 compile 校验。兼容性集合绑定 Host source/profile、bridge artifact digest、Host ABI、wire/codec/features，并包含适用的 supervisor/launch/官方 renewal 能力证据。先观察、生成候选、验证、批准，再经显式授权采用；只匹配锚点不等于批准。

所需 root、turn-close 或 compact 事实若无法从已批准 seam 取得，停止受影响能力并记录缺口；本计划不授权第三处 monkey-patch。未知组合在尚可返回 `originalSession` 时遵守 T11；已经 wrap 的 managed STEP 只拒绝/可见失败，出门后不 official replay。

### 1.3 建立 Effect DI 与 ModelBackend port

**本阶段即用当前 AI SDK adapter + Fake 建立共同 DI 合同。** Phase 3 只新增合格实现，不再次设计 admission 或另一套 registry。

| 能力 | 合同与 owner |
|---|---|
| 配置/发布 | runtime 用例拥有 parser、CAS、引用与 desired gate；Effect 能力提供受控文件/锁/发布 IO。 |
| Activation authority | 内核读取 committed/pending/disabled/unavailable 事实；control owner 写入。provider adapter 不获得签字/进程权限。 |
| Credential/auth | service/backend 内部 scoped access 与身份/fingerprint 校验；secret 不进入 pin DTO、IPC、日志或 UI。 |
| **ModelBackend** | 接受已 admitted 的单次推理输入，产出 typed failure 与 bounded inference events；不执行工具、不写 Host 数据。 |
| Observation/control facade | runtime owners 提供安全观察与 operation receipt，CLI/API 复用。Layer 只选择实现，不决定产品状态。 |

Effect Service 可以直接作为 canonical Port；不复制同义 Promise Port 与 Service。Fake/Live Layers 替换能力，不替换业务程序。纯 hash/parser/codec 保持 TS，Promise/iterator facade 只用于 Node、Host、HTTP 边界。沿用 `effect@4.0.0-beta.107`，不顺带升级。

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

在新长期 root 启用前闭合 **A9**：acquire 与 finalizer 注册成对、partial acquire 可收尾、启动失败/abort/stop 对称释放 Scope 与 listeners。停止服务先拒绝新工作，再有界取消/drain，释放 owned resources；不等待不合作的外部 driver 永远结束，保留 unknown。不要把旧 Promise/timer 编排包一层 Effect 就宣布完成。

控制面沿既有 coordinator 渐进收口重 IO 与 operation lifetime；独立 guardian 保留，不改成随父进程死亡的 Fiber。**J13 保持 Host append / watchdog compact**，不借本阶段改 journal placement 或新增 terminal-report IPC。

### 1.4 接通流、终态与安全退休

每个逻辑 STEP 只有一个 admission/dispatch owner，当前默认一个 attempt。adapter 不自行 retry、failover 或换模型；T14b 的恢复例外由 Phase 4 的明确 attempt 协议控制。

- 接通 provider → canonical events → Unix → Host consumer，修复 **A8**。为 active concurrency、全链路 bytes/parts、背压和慢 reader 设界；terminal 只带终态/usage，不再重复运输全文。response/usage 完成不依赖 UI reader。
- 保留 text/reasoning、tool-call 相关性与完整终态。区分 stop、tool-calls、length、error、cancel、unknown；EOF 缺 terminal 不补成功。验证工具参数/并行策略后才按 Host 合同放行；reader replay 不变成再次执行工具。
- usage 未提供则 unavailable；若 Host ABI 必须接收数字，兼容投影不得被当成真实计量。当前 fixture 数字不能进入预算/费用承诺。
- 分开 envelope bytes、encoded request bytes、system/messages/tools 大小、可信 token limit 与 response reserve。传输上限不是 context window；字符数不是精确 tokens。预算未知如实标识，不能按模型名猜窗口。
- 分开 request timeout、turn binding 寿命、短期 replay 与 refusal/tombstone 退休。保留重复 STEP 拒绝与跨服务代 fencing，不随机逐出旧 id 后重投。建立合法 closed-turn/epoch 退休规则；缺少可靠关闭边界时保守拒绝并披露容量，不能承诺无限期精确去重。

临时旧 wire codec 只接同一内核，不双 dispatch。无法携带 revision/features 的旧 bridge 不宣称具有新保护；完成协商与获授权迁移、确认旧客户端退休后移除兼容路径。

### 1.5 建立安全 correlation 与 T13 最小状态语义

从 kernel 已校验的上下文生成 HostEpoch、Bot、TURN、STEP、ServiceEpoch、selection/binding revision，或可在安全 DTO 中关联的 opaque request reference；记录 phase、dispatch state、观察时间与 evidence gap。provider 错误仅提供本地枚举，不从 error body 信任关联字段、不恢复 bodySnippet，也不按时间最近邻猜因果。

在共同 status/observation 用例中分开：

- bridge/activation evidence；
- modeld readiness；
- controller liveness；
- mutation permission/inhibit；
- operation recovery；
- Host delivery observation。

当前代接缝证据完整、没有实际未决 operation，但遗留 circuit 仍 open 时，表达“接缝有证据、后续变更受限、controller 存活未证明”；不清 circuit、不涂全绿。实际 journal pending/invalid/unavailable 仍为 recovery/unknown，不被旧 attestation 覆盖。为兼容旧 CLI，可暂留 `watchdog.state=degraded`，同时提供上述 facets/reasons，明确它不是 heartbeat。前端不得自行改义。

### Phase 1 出口

1. 首次选择竞态、同 modelId 改 endpoint/ref、移除覆盖、不同 Bot 并发更新均不产生错误 credential/provider effect；T10 exact passthrough 保持。
2. 长工具空档、首 STEP 取消、TTL、service restart、重复 STEP 不导致旧 TURN 换 binding 或重复 dispatch。
3. 两个自行编写、state/root/reader 顺序不同的 Host-shaped adapters 复用同一内核；required root 缺失拒绝，root 恰好一次；实际 preload bundle 和 import-time 行为保持 Effect/SDK-free。
4. terminal 被 barrier 阻住时 Host reader 已见首 chunk；慢/晚 reader 不阻塞 completion；取消/断线无迟到成功或额外工具；EOF 与 usage unknown 如实表达。
5. partial acquire/失败/中断/stop 无 orphan listener、socket、Fiber 或 backend process；只释放 owned resource。
6. 越过当前累计 1024 STEP 的合法退休/有界运行测试通过，且旧身份仍不可重投，才能声明长期 lifecycle 完成。未达到时仅交付明确限额的局部能力。
7. shared CAS、safe correlation 与 T13 facets 可由 CLI/API 同义消费；日志缺失/截断不冒充“没有调用”。

## Phase 2：共享用例上的 WebUI MVP（T15）

### 2.1 固定 SoT 与有限命令面

在盒内提供 loopback API/VNC 运维 console。canonical models/desired、control artifacts 与 Host 产品 stores 继续拥有事实；status/events 是观察，browser cache 是投影。API 不直写文件、不读 Host SQLite/ABI，也不通过 daemon/SSH/generic exec 转发 runtime mutation。

固定 **同盒** roster 来源与 runtime root，不混用任意 current Profile 的 Bot 与本机 assignments。稳定 agentId 用于提交；身份不确定则阻止写入。catalog GET 只提供安全选项、配置状态与能力披露，不返回 secret、任意 apiKeyRef 路径、带凭据 URL 或原 `models.json` 全对象。

CLI/API 共用 Phase 1 的 typed use cases：

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

console/control process root 持有长期资源与操作，HTTP 只持有等待/订阅。只停止自己启动的 modeld，复用服务视为 borrowed resource。浏览器关闭不停止服务、不取消已授权操作；console 退出不等于恢复官方 Host。crash/restart 从 canonical journal/receipt 观察 unknown，不从 cache/outbox 自动重放。confirmed apply 的共享 owner、lease、guardian 与收尾证明先于开放写权限，不要求先重建全部无关控制面。

### 2.3 交付三个表面

- **Overview**：状态、prepare、需要时的一次 confirmed apply，保留 blocked/recovery-required/unknown。
- **Bots/detail**：同盒 roster、配置选择、Host running 状态、最近有证据的模型使用；编辑已配置模型。
- **Runtime evidence**：兼容性、coverage、mutation inhibit、operation、最近安全事件；不冒充完整 trace、精确费用或 App 交付证明。

UI 分开 draft → saving → saved-awaiting-use 与 observed usage。URL 拥有 Bot/tab/filter，query 拥有远程投影和 freshness，组件拥有草稿；事件只触发失效/安全投影，不另建 assignment writer。

未覆盖 Bot 显示官方，不继承 main；route 下 reset 目前拒绝，MVP 明确禁用该操作，不偷偷 `deactivate→reset→activate`。可靠运行中切换以 RouteBinding 出口为准，不以一次 `isRunning=false` 采样消除竞态。

**MVP 不使用 SQLite**，不含 catalog/secret CRUD、chat composer、长期图表。以后有真实查询需求才增加可丢弃的 UX index：只 ingest 安全投影，单向派生，绑定 source revision/epoch，损坏时降级到 canonical 快照；不能恢复配置/pin、驱动 admission 或保存自动命令 outbox。来源已淘汰的事件不能承诺重建，cache 不是审计权威。

### Phase 2 出口

- CLI/API 同义、两个 writer 不丢更新；错 Profile/错盒/过期 revision 不写入。
- auth/Origin/CSRF 拒绝与 GET 零写/零信号/零 spend 有测试；响应、日志、缓存和导出均无凭据/原始 provider 正文。
- preview drift、双击、断线、ack 丢失、reload 不重复 apply、不误停 borrowed modeld、不伪造成功。
- saved、ready、last observed、delivered 在页面与恢复路径上分开；unknown/stale 保留，reset 限制明确。
- 可先交付安全只读 console；可写选择、可靠切换、confirmed apply 分别通过相应门禁后开放。

## Phase 3：准入并实现额外 ModelBackend（T16）

复用 Phase 1 已完成的 Effect DI、ModelBackend port、binding、ledger 与 events。逐个处理 **pi JSON-RPC** 和 **Cursor SDK** 候选，不以扩展 backend 为由增加第二 Agent loop。

1. 钉住 Pi 的实际 RPC 协议/版本、Cursor 的具体 SDK/package 与本地/云端执行面；按真实合同实现，不从名称推导 Codex app-server 方法或 JSON-RPC 2.0。
2. 准入前证明一次推理可接收明确 snapshot/tools/options，不自行执行工具、加载另一个 root/Memory/history、自动 compact、重试/failover 或创建/修改仓库。不能满足则标 unsupported/deferred，不强行返回最终 string 伪装兼容。
3. backend session id 只是私有资源身份，不替代 Host TURN/STEP。默认不复用带隐藏会话状态的 session；复用前证明精确设置/重置、无重复历史、跨 Bot 隔离、取消/重启不续跑未知请求。连接资源由 service Scope 拥有。
4. backend 选择采用有限、版本化配置，不动态加载任意模块/command。区分 backend kind、provider API mode、上游 model 与 auth 类型；只按必要差异扩展同一 catalog schema，不将 HTTP endpoint/apiKeyRef 假设强加非 HTTP backend，不改变 T10 opt-in。
5. 维护共同 conformance 用例：工具调用/参数关联、vision 与不支持内容、serial/parallel policy、stream/cancel、auth 身份、context-limit 证据、usage availability。接口相同不表示能力相同，未证明能力明确拒绝。

**出口**：每个准入 adapter 经同一 production kernel 的 Fake/Live graph 通过合同、状态隔离、取消/资源关闭与零工具执行证明；CLI/WebUI 不出现 backend 私有状态或第二配置规则。transport/SDK 验证不隐式获得 live spend 权限；一个候选受阻不阻塞其余主链。

## Phase 4：已确认 overflow 的 Host compact 与深层诊断

### 4.1 实现 T14b 的一次受控恢复

本阶段依赖 Phase 1 的 binding/lifecycle/error 合同、已验证 Host compact seam，以及另行授权获取的 provider-specific 样本。**不依赖完成所有 T16 backend 或完整 WebUI。**

`overflowCandidate` 只用于观察，不能直接授权 retry。由当前 attempt 的 typed backend outcome、有限分类、完整关联及非冲突证据确认 **context overflow**。auth、429、generic 400/500、HTTP payload too-large、timeout/断线/unknown 均不触发 compact；不能从普通 `model_error` 或 durable 日志行重建恢复命令。

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

Host compact 不可用、取消、snapshot 无变化/仍超限、或一次 retry 后失败时立即结束；不循环、不用 grokbox summarizer 补位。用户错误保持固定可见白名单。样本不足或 seam 未证明时维持 open/unavailable，不扩大 hook 面。

### 4.2 完成 T13 深层诊断

沿 Phase 1 的 facets 补安全 active/terminal 关联、source-emitted 时间/usage availability、事件 retention/cursor/gap 与 operation 恢复证据。源身份、范围、代与序列未对齐时不推导完整时间线、错误率或 publication backlog。

只在可靠只读能力存在时观察 Host transcript/publish watermark；Gateway PID、模型 finish、Host normalize 均不等于 SendToUser 已执行或 App 已显示。缺能力显示 not_observed。publish pending 不触发模型重投、SendToUser 重放或 re-adopt，绝不写 Host 发布游标。

兼容性持续观察与 mutation 分开：检测 Host/bridge/launch 合同变化，产出 changed/missing/unproven 事实；重新验证和显式批准后才能采用，不把现有含 TERM 的 helper 直接放进 timer。后续获授权的 adopted Host 验证同时覆盖 managed canary、未覆盖 Bot、create-bot/privacy 与官方 renewal。

**出口**：confirmed overflow → Host compact → 新 snapshot → 一次 retry 有离线闭环；所有其它错误零 compact；重复/取消/无改善均有停止证明。T13 不清 circuit、不隐藏 pending/unknown，不把采样、缓存或模型终态升级为 Host delivery 权威。

## 票据与实施对应

A3fu/A5–A10 是本计划复用的缺口标签，不增加一套票据系统。实施与验收按以下映射归档；阶段完成以出口证据为准。

| 工作 | 当前范围 / 目标 | 阶段 |
|---|---|---|
| T10–T12、A1/A2/A4 | 保留 selective passthrough、可见错误、官方能力与已关闭安全路径的回归 | 全程 |
| A6 / A3fu / A7 | 默认 raw sink、user-contained 工具结果、输入截断/关键词过滤 | 0 |
| A5 | RouteBinding、两种 revision、首次/续步/TTL/重启与 opt-in | 1 |
| [T5b](../tickets/T5b-s2-streaming-ipc.md) / A8 | framing 已有；完成 Host consumer、背压与终态合同 | 1 |
| A9 / E3 | scoped acquire、admission/credential/stream/stop lifetime | 1 |
| [T13](../tickets/T13-status-honesty-after-adopt.md) | 最小 shared status facets 先交付；深层恢复/发布诊断后补 | 1 → 2 → 4 |
| [T14](../tickets/T14-managed-context-compact-on-model-switch.md) / A10 | enums-only observation 已有；补可信本地关联及分类证据 | 1 → 4 |
| [T15](../tickets/T15-webui-ops-config-storage.md) | shared CAS/use cases、local command boundary、WebUI MVP | 1 → 2 |
| [T16](../tickets/T16-model-backend-adapters-pi-cursor.md) | DI 已在 Phase 1；逐个准入和实现 pi/Cursor backend | 3 |
| [T14b](../tickets/T14b-host-reuse-compact-on-confirmed-overflow.md) | confirmed context overflow 的 Host compact 与一次恢复 | 4 |

## 非目标与禁止事项

- 不重建 Host loop/tools/root/compact/Memory/Transcript/SendToUser/官方 renewal/publish，不 prepend store.db，不设置默认 live 近窗 caps。
- 不将已知拒绝的 Responses raw `role=tool` 恢复为 CCS 通用路径，不用正文关键词、40ms 延迟或无 STEP replay 充当协议。
- 不建第二 admission/reconciler、`effectMode`、SDK 内部 Agent loop/隐式 retry；不把 Scope 当跨文件事务或 crash recovery。
- 不引入 authoritative SQLite、UI assignment table、自动 outbox、通用 provider/插件平台或新 npm 包家族；纯 shadow 仅比较映射/投影，不双真实 dispatch。
- 不在 Host/preload 加 Effect/SDK，不改变两刀/J13/独立 guardian 的边界；缺能力停止受影响路径，不猜接口。
- 不以 UI 超时、缺事件、candidate overflow 或 publish pending 自动重发/compact/re-adopt；不自动关 circuit、批准未知 profile 或转发远程 runtime mutation。
- 不以本计划或 offline green 授权 live spend、re-adopt、test1 opt-in、遗留数据清理或已部署能力声明。

## 立即执行的两个切片

1. **Phase 0 安全与输入保真**：按 A6 → A3fu → A7 完成默认 raw sink 与 codec 小闭环，补 actual Chat/Responses 编码、长工具结果、控制词引用及无 STEP 回归。只改相应 helper/codec 与测试，不加 Host hook、不 re-adopt；完成 Phase 0 出口。
2. **Phase 1 首个内核切片：RouteBinding**：建立 config/selection revision 与共同发布接缝，让 Host projection → submit → canonical admission 在首次 credential/provider effect 前一致；同 TURN 保持 binding，TTL/restart 拒绝或保留证据，不 main fallback。以现有 AI SDK/Fake 接入共同 Effect 能力边界，先证明配置与生命周期竞态，不先实现 Pi/Cursor 或 compact。

随后按 Phase 1 剩余出口接通 stream、退休、安全 correlation 与 T13 facets，再逐项开放客户端能力。Host ABI、配置/wire schema、backend 能力、Effect pin 或验收结论变化时更新本文及对应产品/架构合同，不另起日期版方案。
