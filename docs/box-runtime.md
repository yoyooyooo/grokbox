# Box-local model runtime

本文是 Grok Bot **模型替换运行时**的设计 Current Home：接缝、注入、modeld、配置和失败语义。它描述已接受的**未来完成态**，不是当前源码已实现清单。

产品命令、本机边界、envelope 和可见错误义务见 [产品合同 §12](product-contract.md)。模块与 composition roots 见 [架构 §17](architecture.md)。重副作用与渐进迁移遵循 [Effect 标准](effect-box-runtime.md)。交付进度只在本地 Issue tracker。源码和可执行测试拥有当前实现真相。

本仓库是公开、自包含的控制面。上游 Host 研究材料若存在于 maintainer 私有环境，只作证据输入，不是本仓库实现权威，也不得把私有 dump 提交进 git。

## Freshness

Host bundle SHA、PromptSession/`SendToUser` 合同、官方 wrapper/supervisor、或 `~/.grokbox/runtime/` CLI 安装布局变化后必须重审本文。

---

## 1. 结果

用户继续在原 Grok Bot App 中工作。ordinary main 的模型由盒内配置替换，且 **每个 Bot 可以覆盖默认模型**。Host 继续拥有排队、工具授权与执行、Transcript、Memory、`SendToUser`。

不允许：第二套 Agent loop、全 backend MITM、永久改官方磁盘 bundle、经 daemon/SSH 转发 runtime mutation、managed 失败后静默回官方。

控制面是 **Agent-first**：CLI 给盒内 Agent 设 desired、读 JSON 观察。人用的只有未来盒内 WebUI（同一 use case）。不要为「人手别误点」藏命令；也不要为 Agent 增加第二 writer（inject/heal/kill）。

首期是 **main-only、hybrid、availability-first**：官方 relaunch 会打开未补丁窗口；窗口必须可测量；不得宣称 strict 或零窗口。

---

## 2. 接缝

生产接缝是 `createCursorSandInference.createSession` 上的 Host session adapter。现役 Host 立刻调用 `session.getModelId()` 再 `session.getExecutor(state).stream(ctx, invocationId, tools, options)`。`stream` 必须同步返回 `{ fullStream, response, usage, extendedUsage }` 及 Host 所需 promise，不得把整个对象做成 Promise，也不得把 `fullStream` tee 给 response/usage 等待者。成功和失败的 `response` 都要有可 `.trim()` 的 `modelId` 和 `messages` 数组；`usage` 为 Host camelCase `{ promptTokens, completionTokens, totalTokens }`；executor 的 `getMessages()` / `getState()` 必须返回 Array。identity 仍按对象身份交还 `originalSession`，不得包一层。

```text
App / Gateway / Host queue
  -> createSession
  -> hook
       非 route 或非 ordinary main -> originalSession（官方）
       route 且 ordinary main     -> Host-shaped session
                                     getModelId / getExecutor / getExecutorWithoutResolvedModelTracking
  -> modeld（provider effect 前检查 committed attestation + envelope）
  -> Host tool loop / SendToUser / Transcript
```

Host 内 hook **不读** `models.json`，**不读** attestation 文件。`activate --mode route` 必须已有有效 `assignments.main`（全盒默认）。

现役 `createSession` 的 `sessionOptions` **没有** agent id，也 **没有** invocation id。按 Bot 分流和 turn 相关是核心能力，因此 PatchProfile 除 `return session` 外还有 **第二精确切片**（仍只两刀，不加第三刀）：在 `runTurn` 构造 `mainSessionOptions` 时写入 `agentId: host.getConversationId()` 与 `invocationId: inferenceRequestId`。仍是 NODE_OPTIONS 内存 transform，不写官方磁盘。modeld 用 `assignments.agents[agentId] ?? assignments.main`。缺少 invocationId 不得发明第二相关 id，route 显式失败。没有覆盖不是回官方。

protobuf sidecar 与全 backend MITM 不是 P1 路径；未被证伪，失败后再决策，不双轨。

### 当前离线 envelope / stream 合同

- `envelope.ts` 是 provider-neutral、仅内存的转换边界：version=1，messages/tools/options。executor 的数组 state（或 `{messages:[]}`）及 append 输入被快照，getter 返回独立数组；每次 stream 的规范化 envelope 深冻结。模型回复不自动 append 回 state，不执行工具，不另写 Transcript/Memory。
- 支持 system/user/assistant/tool 历史、text/reasoning、tool-call/tool-result blocks；工具 id/name/JSON args/result 原样关联，不做 provider 特定改名或 assistant-last 改写。历史 tool result 必须有匹配 call。旧内部 `toolCalls` 与 content blocks 合并一次；最终 Host response 只用 content blocks，finish.response 与 response promise 一致。
- 工具可为数组或普通 name-keyed 对象（非 Map 实例）；只投影 name/description 和 `parameters.jsonSchema` / `inputSchema` / `schema` 的 object-root JSON Schema，不调用 execute。支持 temperature/topP/maxTokens/seed/stopSequences/parallelToolCalls/toolChoice；context 只取取消信号，不作为模型 payload。未知内容、附件形状、opaque/redacted wrapper、错误 schema/options、超限 envelope 显式失败，不静默丢弃或通用解封。
- image 的 URL/data/mimeType 只在声明 vision 的测试 driver 上保留，不自动下载。生产 stub 无 vision；不支持时在 driver effect 前给出固定可见 assistant 文本和 error terminal，由 Host 决定实际投递，不调用 Gateway/`SendToUser`。envelope 上限 64 KiB；当前 IPC frame 仍为 16 KiB，超过传输上限也可见失败。
- `createStreamingPromptSession` 同步返回 handle，内部 eager single producer；response/usage 独立于 delivery。每个 fullStream reader 有自己的 replay cursor，晚订阅不抢走其他 reader 的 parts；关闭一个等待中的 reader 只结束它自己，不取消其他 reader 或模型调用。生产 payload 默认限 4096 parts / 1 MiB；取消即结算一个 abort terminal，不等待卡住的 producer return；后到 parts/terminal 丢弃。缺 terminal、坏帧/参数片段、冲突 tool id 与 producer exception 为脱敏可见 error，而非空成功。
- tool-start/delta/complete 在同一 id 上关联，interleaved ids 不混线；同内容 complete 重复只投影一次，冲突重复拒绝。serial-only 时 executable calls 留到完成门禁后再放行；意外并行用 error.toolCallIds 披露拒绝的 ids，不造空名字的假可执行 tool calls。
- seam 按 STEP 槽位一 invocation 一次 dispatch/terminal：同一 TURN 的后续 STEP 不占用前一槽；迟到的 STEP-1 abort 不取消 STEP-2。重复相同 STEP+输入返回无副作用 idle handle，不重放工具；同 STEP 改 payload 可见 conflict。disconnect 先记 unknown 再取消，并阻止未发出的迟到调用。只有 Host 显式提供下一段历史、tool result 和新 invocation 才进入下一模型步，不新增模型/工具循环。事件只存 bounded ids/count/class，不存 envelope/body。

**证据上限分开**：scripted driver 测试确实在 terminal 尚未提供时收到首 chunk，并证明 response 可先结算、Host UI fork 随后接入，以及取消/工具向量/重复调用不重复 dispatch。生产 `createModeldRouteDriver` 仍是固定 text stub 的 **response-only** IPC（Host-facing fullStream 为空）；它经下述单一 modeld admission 内核校验 envelope 与 generation/activation，仍不是 token transport 或 provider SDK。离线首 chunk 与 response-only 两种通过都不证明 live Host 各种订阅顺序、真实 first-token latency、provider vision、计费 usage 或实际工具/Transcript/Memory 写入。

---

## 3. 命名

| 词 | 含义 |
|---|---|
| watchdog | 盒内长期 reconciler；内含唯一正常 process-mutation coordinator |
| guardian | 一次注入的短命 deadman；唯一例外：对精确 frozen wrapper 幂等 `SIGCONT` |
| modeld | 推理进程：配置、一个 driver、credential、invocation registry |
| desired route | operator 要求主对话走配置模型 |
| window-open | 需要补丁但这一代 Host 尚未证明有钩子 |
| committed attestation | watchdog 已核对这一代 PID/start/SHA/mode |
| W1 | 钩子还不在；拦不住 `createSession` |
| W2 | 钩子在、尚未签字；modeld 可出门前等待 |
| direct-launch | 携带已审 preload env 的 supervisor **直接生出** Host（Unix 父子） |
| transient-adopt | 临时 supervisor 生出 detached identity Host；新的未 preload 官方 supervisor **逻辑收养**同一孤儿 |
| logical adoption | supervisor 以 gateway pid / 存活身份承认 Host，**不** re-parent；不是 boot 持久化，也不是 PPID 证据 |

---

## 4. Host 补丁

- 精确 source SHA、唯一 anchor、transformed SHA；任一不符则不注入，恢复官方链。
- 不写 `/home/box/sand-host`、官方 wrapper 或 supervisor。
- preload 不启动 CLI/watchdog/modeld，不持有 provider key。
- observe / identity 不依赖 modeld；route 才把门禁放到 modeld handshake 与 attestation admission。
- hook 缺失：observe/identity 回 `originalSession` 并 degraded；route 显式失败。
- 单正常 mutation writer = coordinator。guardian 不得 start/kill/改配置/重试注入。
- 未知 bundle 不猜 anchor。coverage 与 watchdog.state 分开：`coverage=window-open`，`watchdog.state=degraded`，`reason=unsupported_bundle`。
- 未补丁窗口只保证测得到 duration；无可信 turn 信号时 `affectedInvocations=unknown`。
- **长效根** `/workspace/.grokbox/box-runtime/`：配置、PatchProfile、合同切片、事件日志（云电脑重置后仍在）。不得占用 CLI 安装目录 `~/.grokbox/runtime/`。
- **短效**：盒本地 live state 固定 `~/.grokbox/run/`（`attestation.json`、operation journal/lock、preload/launch markers、`modeld.sock`）。不读 `XDG_RUNTIME_DIR`。显式 `ephemeralRoot` 只用于测试/合成隔离。daemon/Profile socket 仍走现有 XDG 合同，不是这棵树。
- 不新建独立 npm package；一个源码模块、多个 entry。
- PatchProfile 含两处精确切片：`createSession` 的 hook，以及 `mainSessionOptions.agentId` 与同一切片上的 `invocationId`。任一处锚点不唯一即拒绝。

Launch context：从已验证 generation 捕获 allowlist 字段，禁止复制完整 `/proc/environ`。只许 `identityLaunchFields` / 固定 allowlist，不得整份克隆 supervisor 环境。

H3 有两条互斥启动策略（非公开，不是 CLI；身份注入 ≠ route）：

- **direct-launch / direct-overlay：** 当前 supervisor 已能把 allowlist launch env 交给下一次**它所生的** Host。成功事实是唯一官方链且 `host.ppid === supervisor.pid`。不要为了收养去放宽这条直接链证明。
- **transient-adopt：** 当前官方 supervisor **不是** direct-overlay。经单独授权的 coordinator 才可以：对精确 wrapper `SIGSTOP`；对精确旧官方 supervisor 与旧 Host 身份核对后 `SIGTERM`；用 allowlist env 让**操作拥有的**临时 supervisor 生出 detached identity Host；对该临时 supervisor `SIGTERM`（Host 必须作为孤儿存活）；`SIGCONT` wrapper；**新的未 preload 官方 supervisor 逻辑收养同一个 Host**。成功事实不是 PPID：唯一 wrapper+supervisor+Host、supervisor 仍是 wrapper 之子、`gateway.json.pid` 与 Host 一致、Host 稳定身份（pid/uid/start/exe/cmdline）跨 handoff 不变、**最终 Host PPID 不是新 supervisor**、临时 supervisor 已消失、新 supervisor 无 preload、磁盘 SHA 不变、committed attestation 含 `launchMode: "transient-adopt"`。有界稳定期内不得出现双 Host/双 supervisor。
- 现役官方 `sand-supervisor` 不是 `direct-overlay`。只有精确版本/能力审查通过后才是 `transient-adopt-candidate`。Live adapter 仅在 unique chain + reviewed SHA + candidate 预检通过后进入 transient-adopt；预检失败零信号。

Guardian 只对精确 frozen wrapper 幂等 `SIGCONT`；不得 start/kill/改配置/重试注入。禁止对官方 wrapper/supervisor/Host 回退 `SIGKILL`。coordinator 在已授权 H3 中可以对**精确**旧官方 supervisor 与**精确**操作拥有的临时 supervisor 做身份核对后的 `SIGTERM`。

官方 relaunch 仍打开未补丁窗口（hybrid）。transient-adopt **不是** boot env D，也不把 preload 写进官方磁盘或 wrapper。

---

## 5. 模型运行时

- `/workspace/.grokbox/box-runtime/models.json`；`apiKeyRef` 仅为 `env:<NAME>` 或 `file:/absolute/path`（`file:` 也放长效树下的 `secrets/`，不进 git）。
- `assignments.main` 是全盒默认；`assignments.agents.<id>` 按 Bot 覆盖。键用稳定 agent id；CLI 在盒内解析名字。省略 `--for` 的 `models use` 改默认。其它 Host 调用面（summary/computer/…）仍是覆盖地图，不是 SlotRegistry。本 slice 的 route 只承认 `stub/echo`；非 stub 赋值在 models/CLI 与 stub modeld/seam 双层 fail-closed。
- turn 钉住该 Bot 的 immutable resolved-config **和 credential fingerprint**，直到 terminal 或 idle TTL；不在 turn 内 refresh/换账户。改 Jerry 不影响 Tom 正在跑的回合。
- modeld 有 generation-scoped 内存 registry（id → fingerprint + state + terminal）。`status` 不对账续传正文。disconnect → abort + unknown。duplicate submit 不重新 dispatch。
- 体验不降级：优先让 Host 既有 retry/checkpoint 工作。不另建第二套消息队列。
- MVP envelope 见产品合同 §12：文本、工具、视觉（模型声明才送；否则可见告警）、并行不得丢 id。
- 可见告警最终由 Host 写入 Transcript（`SendToUser` 或等价），runtime 不私写产品库。

### 当前 Unix admission / pin 合流（S5）

`Host seam → modeld.sock → createModeld → admitted stub driver` 是一条路径。`modeld-ipc.ts` 只负责有界协议/连接，删去独立 stub registry；`modeld.ts` 独占 admission、pin、重复/取消/过期及 effect，fake 测试替换同一内核的 ports/driver，不另造 offline admission。CLI 默认只有无 credential、无网络的 `stub/echo`；带 fake driver 的 Unix 测试不构成生产 provider allowlist。

- `modeld-binding.ts` 从已 pin 的 compile receipt、operationId 和稳定进程身份构造 Host binding。`generationId` 散列 PID/start + operationId + 全部 compile 字段；`activationId` 指本次 adopt operationId，**不是** desired 文件的修订号；`sourceSha` 是 compiled source SHA；`identitySha` 散列 PID/UID/start/exe/cmdline（不含收养时变化的 PPID/ancestry，不传 raw argv）。preload 用自身身份与已读 profile 传入这些不可变事实，hook 不读配置/attestation、不做 live census。
- `modeld-store.ts` 在服务内以有界 no-follow regular-file reader 读取 desired、canonical attestation 和 operation journal，双读不一致只等待、不 admit。route 必须具有 S2 compile receipt；transient-adopt 还要求同 operation/compile/稳定身份的 `attested` journal，临时 supervisor 已释放。legacy/坏/uncertain 证据不被 health 成功替代；正常未签完可在预算内等待。不存在“把 committed 布尔设成 true”或使用 caller 自报身份作为权威的路径。
- effect 前先比对 binding，再解析该 Bot 的 `assignments.agents[id] ?? main`；配置快照含 model/provider/endpoint/apiKeyRef/capabilities/dataTypes，深冻结后才允许 fingerprint await。credential hook 前及 driver effect 前重新核对 canonical authority。stub 完全不调用 credential hook；fake hook 只交回 64 字符十六进制 fingerprint，既不把 secret 放入 pin 返回值/IPC，也不实现真实 provider/file-secret 安全边界。旧 `createFileEnvSecretResolver` 未被接线；不得作为 M3 的 credential 验收证据。
- PatchProfile 注入的 `sessionOptions.invocationId` 是 TURN。Host `stream` 的 invocationId 是 STEP。seam 按 `(hostGenerationId, STEP)` 占槽，向 modeld submit 分传 `turnId=TURN`、`invocationId=STEP`，不另发明 Host id。省略或非法 STEP 显式拒绝，不回退 TURN。内核按 generation + Bot + turn 共享正在使用的 pin，最后一个使用者 terminal/取消/过期后释放。重复 invocation 用完整 binding/ids/envelope hash 校验，在配置变化后也不重新选模型/dispatch；改变 payload 明确 conflict。终态结果只保留到 TTL，过期变成 refusal tombstone，不以缓存丢失为由再 dispatch。
- 默认 admission 预算 **500 ms**，工作/终态保留 TTL **30 s**，ledger 上限 **1024**。过期释放 pin/response，但 bounded tombstone 留到 canonical Host generation 替换或服务重启；同代满额明确 `capacity`，不驱逐旧 id 后偷偷重跑。观察到新 canonical generation 时取消旧工作、清除旧 pins/ledger，旧 Host 不能借新代继续调用。
- v2 health 只证明服务/协议 readiness，返回独立 `serverGeneration`；submit 不再接受 caller 指定 modelId 或旧 ids-only 请求。每个新 invocation 握手一次，已用 invocation 保留原 fence；服务重启后旧包拒绝，新 invocation 可新握手。disconnect、客户端掉线、取消/timeout 后标 unknown 并 abort，迟到 port/driver 完成不产生新 effect/成功；不盲目重试、不静默回官方。内存 ledger 不提供跨重启续传或跨客户端强制重握的 exactly-once 保证。
- Unix frame 仍 **16 KiB**、一连接一请求、最多 **64** 活跃客户端；idle/partial client **1 s** 超时。stop 先取消内核、destroy 所有活跃 socket，再等 server close，不等待卡住的 driver。可连接但不答 health/旧协议的 socket 仍视为竞争 owner；普通文件不当 stale socket 删除。stop 的 bound 不等于外部 driver 一定配合物理取消，更不是 live Host 的恢复 SLA。

这些结论来自 `modeld.test.ts`、`modeld-confluence.test.ts`、实际 CLI + Unix/socket + fake canonical files；未读取现役 Host，未产生 provider credential/network effect。身份/receipt 校验不是对恶意同 UID 客户端的 peer authentication；double read 是时点证据，不是跨文件事务或对同 UID 写入者的原子隔离。G1/G2/M3/07 仍需独立授权。

### 窗口（W1 / W2）

```text
W1 无钩子
  只能压短窗口（注入前尽量空闲）
  已出门的官方流不中途改接自定义

W2 有钩子未签字
  modeld 出门前有界等待 committed（预算 = 该次注入/恢复）
  等到 → 自定义
  超时熔断 → 恢复健康链
  本句极端可用官方接住，且必须可见说明
  后续句继续抢自定义；官方不升格为默认
```

managed 一旦对供应商出门，失败不得静默回官方或换 provider。上面的 last-resort 是完成态设计：当前 S5 timeout 只返回脱敏可见 managed error，没有 official fallback 执行器。

---

## 6. 合同切片快照

目的：官方 Host 更新后知道 **刀口和合同漂了没有**，不是备份/还原官方 bundle。快照 **不进 git、不进 npm pack**，也不自动生成新补丁。

### 存什么

只存合同切片，默认不缓存 28MB 整包：

```text
/workspace/.grokbox/box-runtime/contracts/
  HEAD                         当前已观察的 sourceSha（一行）
  generations/<sourceSha>/
    meta.json                  sourceSha、bytes、hostVersion、observedAt、切片 SHA、相对上一份的 drift、可选 matchedProfileId
    slices/
      create-session
      session-options
      agent-id
      prompt-session            锚点能命中才写
```

目录 `0700`，文件 `0600`。`meta.json` 不含 env、token、prompt、PID 身份权威。

整包只读拷到 `/tmp` 仅用于离线重做 profile，用完丢弃。不滚动保存整文件。

保留最近 **5** 个不同 sourceSha。删除时跳过当前 live SHA，以及「最后一份曾匹配过 PatchProfile 的 SHA」。

### 何时写

只在只读观察到 **整文件 SHA ≠ HEAD** 时写新 generation（含第一次看见 Host）。不在每次 turn、每次 `status`、或 SIGSTOP 临界区写。官方文件读失败则不写，coverage=`unknown`。

```text
observe live sourceSha
if sha == HEAD: return
extract slices → atomic write generations/<sha>/
HEAD = sha
if no PatchProfile matches: coverage=window-open, reason=unsupported_bundle, 报告哪些切片 drift
prune to 5
```

未知 bundle 仍先拒绝注入。快照只给人/Agent 审下一份 PatchProfile。

---

## 7. 证据分层

| 标签 | 含义 |
|---|---|
| Rejected | 该事实断言被证据否定 |
| 不采用 | 架构选择，未必证伪 |
| Offline / Live-transient / Unproven | 证据强度 |

已否定：用 `SAND_BACKEND_URL` / `SAND_AGENT_MODEL` 切普通 Cursor 额度；Box Secrets 当 Host boot env；本地 hook 替代 remote worker。

全 backend MITM：**不采用**。窄 protobuf sidecar：**P1 不采用**。

实验梯子（Host 与 Model 独立；仅集成绑在一起）：

```text
H1 exact transform    M1 PromptSession 合同（含 Host retry 行为）
H2 guardian 故障注入  M2 fake 工具循环
H3 live identity      M3 真 provider + 假 Host
I1 ordinary-main canary（H3+M3）
I2 relaunch / window duration
```

H3 与 I1 需要另一次明确授权。现役 Host 注入前必须有 H1/H2 离线证据。H3 成功证据随策略而变：direct-launch 用父子链；transient-adopt 用逻辑收养，不得把 `host.ppid === supervisor.pid` 定义成「已被收养」。H3 仍是 hybrid / live-transient；**不是** product boot env D（控制面把精确 env 写入 `start-sand-box` 并跨 recreate 保持仍未证明）。

---

## 8. 自动 / Agent CLI / 人

机器优先。人的入口只有未来盒内 WebUI，映射同一 use case。

**Watchdog 自动（无对应 mutation 命令）**

- 读磁盘 SHA；变化则写合同切片快照
- 作废旧 attestation；未知 SHA 不注入 + circuit-open
- 注入中 SHA 变了则 abort 并按已有路径恢复
- 注入结束普查：恰好 1 wrapper + 1 supervisor + 1 Host，且满足当前策略拓扑（supervisor-born direct-child **或** logically adopted singleton）
- 停掉我们记下身份的临时 supervisor / 到期 guardian；对不上身份则停手
- `stale-patched`：对签过字且身份仍过的那一个 Host PID 发一次 SIGTERM，让官方用当前磁盘拉未补丁进程；失败一次即 degraded
- 有界 ndjson（`/workspace/.grokbox/box-runtime/log/events.ndjson`，白名单字段）

认不出的多余进程 **不自动杀**。

**Agent CLI（盒内，JSON）**

- 写 desired：`activate` / `deactivate` / `models *`
- 离线审 profile：`profile write --from <host-bundle>`（显式绝对路径、只读输入 → 两处精确切片及 source/transformed SHA 校验 → 原子发布长效 `profiles/reviewed.json`；不保留整包副本，不 inject / 不 TERM / 不 re-adopt）
- 只读：`status`（含 census、diskSha、driftedSlices、circuit、lastHeal）、`log`、`contracts`（切片 SHA/drift，默认无正文）
- `status` / `log` / `contracts` 不 repair
- 进程入口：`modeld run` / `watchdog run`
- 显式确认一次：`re-adopt --confirm`（**唯一**带 live adopt 权限的公开档 / sole live writer；匹配身份 + `diskSha` + reviewed profile 是 no-op；所有权精确但 `diskSha` 过期才允许一次 stale → official → transient-adopt；已经是 route 且所有权与 `diskSha` 仍匹配、只是 reviewed profile SHA 变了时，确认后可再 refresh 一次。缺 `--confirm` 的 watchdog 对后者保持零信号 `route_mismatch`。不是循环，也不替代 watchdog）。**No live unless authorized。**
- 本 slice route 只承认 `stub/echo`（models/CLI fail-closed；stub modeld/seam 再拒非 stub；无真实 provider admit list）
- 短效 live state 默认 `~/.grokbox/run/`（见 §4）
- 所有权与新鲜度分开：canonical attestation 对上唯一 grokbox-touched Host 身份和单例拓扑即为 `origin=grokbox-attested`；`attestation.diskSha === liveDiskSha()` 才是当前代。SHA 过期报 `reason=stale_attestation`，desired 为 identity/route 时 `coverage=window-open`。身份/普查/gateway/拓扑/attestation 对不上仍是 unattested/ambiguous，零信号 recovery-required
- 禁止：`inject` / `heal` / `kill` / 手动 snapshot
- identity/route 接管与 refresh 的首信号 admission：共享 coordinator 在任何旧 Host 信号及 guardian 启动前，校验下一份 profile 的两刀重放/source/transformed SHA、当前源、canonical ownership/严格拓扑、gateway PID、未决 journal、launch capability；route 还要求 stub main assignment 与 modeld readiness。缺少 source/capability 事实不授权 mutation。launch preparation 先于 STOP/TERM，operation lock 内在首信号前再核对。identity stale refresh 与 route profile/mode refresh 走同一 admission/budget 路径，保留原始 generation key；匹配目标仍零信号 no-op。公开 manual root 不接受 legacy witness。

`profile write` 在 `0700` 的 `profiles/` 内使用每次独有、独占创建的 `0600` `.reviewed-*.tmp`：只写 profile JSON，校验读回并 sync 文件后 rename 为 `reviewed.json`。并发成功 writer 以最后一次 rename 为准；reader 只见完整旧版或新版，不见半份 JSON。输入不得与输出同文件（包括 symlink/hardlink 别名）；读取和发布前核对源文件身份、大小与时间戳，检测到变化即拒绝。失败/中断可遗留未发布的 protected staging，canonical reader 忽略它；不自动删除 staging 或已有 legacy 整包副本，清理由 operator 另行决定。这里不承诺掉电后的目录元数据持久性或防御同 UID 恶意文件系统替换。

生成 profile 只证明这些显式切片可重放且 hashes 一致，不自动批准未知补丁，不替代人工审查或后续 live 授权。首信号 gate 复用 H3 的现有 launch-strategy/capability 判定，不把离线通过或当前 capability signature 当成具体 live supervisor 版本已经审阅或 H3 已执行。

**实际 compile → 最终 receipt（transient-adopt）**

- manual/H3 adopt 将已准入的 profile 序列化为独占创建、读回并 sync 的 `0600` 短效 `state/launch-profiles/<uuid>.json`；目录 `0700`。preload 不再重开可变的 `profiles/reviewed.json`。并发 authoring 留给下一次显式请求，不在一次 refresh 中追逐多个目标。不保留 Host 整包；不自动清理 snapshot 或失败 staging。
- preload 仅在实际 transformed `_compile` 返回后原子发布 marker：operationId、PID、进程自行读取的 Linux start ticks，以及 `compile.{profileId,profileSha256,sourceSha256,transformedSha256}`。profile hash 是实际读取的 JSON bytes（包括换行）；source/transformed hashes 来自实际 transform。marker 的 `modeld:false` 保持不变：它不是 modeld readiness 证明。
- 同一 operation 对照准入目标、marker 与新 Host 的 PID/start，核对 handoff；route 在提交前、读回后及 coordinator 最终回执前另行探测 modeld。attestation 的 profile/hash 来自匹配的 compile receipt，不来自之后重新 author 的目标。storage port 只落盘，不拥有签字语义。
- attestation/journal/coordinator JSON 均 protected staging → 文件 sync → rename。journal 先写未决 `commit-attestation`，canonical attestation 精确读回后才可写 `attested`，随后再读回核对。`committedAttestation` 是实际读回的制品；CLI 只公开 mode/PID/start/SHA/operationId/compile/时间，不输出原始进程 argv。它可与 `recovery-required` 同时存在，表示“已提交，但最终健康或收尾未完成”，不是整体成功。
- deactivate→adopt 是一个逻辑 attempt：原始 key 与已发生的 `signaled` 不因后半段拒绝、落盘异常或 modeld 掉线丢失。`injected:true` 只表示本次 adopt operation 曾完整提交；随后 coordinator 收尾失败仍报 recovery-required。不恢复旧 attestation 来伪造回滚；`commit-attestation` / `recovery-required` journal 不自动结清重试。

以上由 fake processes + 隔离真实文件、disposable Node preload/adopt helper 验证；只证明一次新 generation，不是 live Host/provider 证明；modeld generation-admission 的独立离线证据见 §5。read-back/readiness 是时点证据，不承诺返回后的持续存活、掉电目录持久性或防御同 UID 恶意替换。desired disabled 不是恢复完成的证据；当前观察按下面的 desired/actual 分离，不由这份 receipt 偷偷执行恢复。

**只读 desired/actual 观察**

- `status.activation` 分别给出 `desired`、`actual`、`reconcile`、`reason`。缺 desired 文件使用显式披露的默认 disabled；坏文件则 desired=null / unknown，不替换为成功的默认配置。只要 Host 仍 patched，disabled 就是 pending / `rollback_pending`；即使确认 manual root，本 slice 也不新增自动恢复信号。真正的恢复仍需同一 coordinator 的另行授权执行路径。
- `host.origin` 是所有权观察，不是 mutation 授权；`host.topology` 独立核对 direct/adopted，后者还需要 gateway PID。`coverage=attested` 描述当前同代 attestation，不能当成 disabled 已完成；未决/坏 journal、错误拓扑、route profile/assignment 不符或 modeld 未 ready 不能得到 route-ready。旧 attestation 的 window 不移植给另一代 Host；duration 仅是匹配当前代的已提交 handoff 记录，不是实时窗口年龄。
- `coordinator` 读取实际 `state/coordinator.json` 的 circuit、mutationCount、lastAttemptKey/circuitReason；缺失或损坏不伪造 closed/0。`lastHeal` 是有界事件快照中最后一条可验证的 heal 记录，不是恢复动作。持久 metadata 不是 heartbeat：watchdog 无存活探针时为 unknown，已知 circuit-open / 未决状态可报 degraded，不能凭旧 attestation 宣称 running。
- `evidence`、`coordinator.state`、`operation.state`、`contracts.state` 区分 present / missing / invalid / unavailable；多记录快照还可为 partial。provided 表示调用者提供的测试/读端口事实。未知 drift 是 null；只有实际 generation metadata 的空 drift 才是 []。`contracts.sourceSha` 将 drift 绑定到已观察的磁盘代，而不是盲用旧 HEAD。
- `contracts` 只读取 canonical HEAD 与最多 32 个 generation 的 `meta.json`，返回每代 state/metadata（sourceSha、sliceHashes、driftedSlices、时间/大小），报告 truncated/invalidEntries；不读取切片正文、不 snapshot/prune，不接受 HEAD traversal 或 symlink 制品。常规 metadata 读取上限 128 KiB。
- `log` 是最多 512 条、1 MiB 文件上限的 schema-only 快照，返回 state/events/truncated；坏行用 `{invalid:true}`，未知或越界文件不冒充正常空日志。**`log --follow` 当前明确 invalid_usage / exit 2**；不会输出一次成功快照假装持续监听。reader 不加锁、不 compact、不修复。
- `models.assignmentState` 只验证本地 assignment 引用；`models check` 明确 `checked:["schema"]` / `serviceReadiness:"not_checked"`，不证明 provider 可用，也不增加 agent name→id 解析或 credential/provider 调用。

status/log/contracts 只读，缺树仍缺树；这些未知语义和 before/after 文件证明来自 offline/fake harness，不构成 live readiness 或自动 writer 权限。

**人 / 另一次授权**

- 切片 drift 后写新 PatchProfile
- 现役 identity/route 注入
- `recovery-required`（误写磁盘、双链清不掉）：官方渠道换 Host；grokbox 不修官方文件
- 未来 WebUI：给人配模型、看状态，背后仍是上述 use case

`deactivate` 是 Agent 的唯一大回滚意图入口：写 desired=disabled；接受的恢复目标是单一未补丁官方链。写入回执不等于目标已达成，须由 actual/topology 与获授权的执行回执证明；实施打错和生产失效仍走同一条路。

---

## 9. 明确非目标

- 不把 runtime 实现或 Host dump 提交进本仓库
- 不做 RoutePolicy 引擎、不做「有的 Bot 继续官方」的混合路由（另一次产品决定）
- 不把整份 `host-main.cjs` 当滚动备份，不从快照还原官方 Host，不按 diff 自动猜补丁
- 首期 WebUI（盒内 VNC UI 是后续客户端）
- 不把 watchdog 并进 `daemon serve` 或 jobs
- 不把完整 Pi/Cursor agent 伪装成一次 PromptSession
- 不宣称 billing verified、零窗口、fresh recreate 自动恢复
- 不宣称 product boot env D：没有受支持的产品控制面把精确 preload 写入 `start-sand-box`、跨 image recreate 保持、或保证 runtime 在第一代 Host 前就绪。transient-adopt 只是一代进程内的 hybrid 窗口，不是 D

后续变化直接改本 Current Home 与产品/架构义务，不再维持平行提案。
