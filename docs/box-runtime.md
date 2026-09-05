# Box-local model runtime

本文是 Grok Bot **模型替换运行时**的设计 Current Home：接缝、注入、modeld、配置和失败语义。它描述已接受的**未来完成态**，不是当前源码已实现清单。

产品命令、本机边界、envelope 和可见错误义务见 [产品合同 §12](product-contract.md)。模块与 composition roots 见 [架构 §17](architecture.md)。交付进度只在本地 Issue tracker。源码和可执行测试拥有当前实现真相。

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

生产接缝是 `createCursorSandInference.createSession` 上的 PromptSession adapter。

```text
App / Gateway / Host queue
  -> createSession
  -> hook
       非 route 或非 ordinary main -> originalSession（官方）
       route 且 ordinary main     -> ManagedPromptSession
  -> modeld（provider effect 前检查 committed attestation + envelope）
  -> Host tool loop / SendToUser / Transcript
```

Host 内 hook **不读** `models.json`，**不读** attestation 文件。`activate --mode route` 必须已有有效 `assignments.main`（全盒默认）。

现役 `createSession` 的 `sessionOptions` **没有** agent id。按 Bot 分流是核心能力，因此 PatchProfile 除 `return session` 外还有 **第二精确切片**：在 `runTurn` 构造 `mainSessionOptions` 时写入 `agentId: host.getConversationId()`（owning agent id）。仍是 NODE_OPTIONS 内存 transform，不写官方磁盘。modeld 用 `assignments.agents[agentId] ?? assignments.main`。没有覆盖不是回官方。

protobuf sidecar 与全 backend MITM 不是 P1 路径；未被证伪，失败后再决策，不双轨。

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
- **短效**：socket/锁/本次注入 operation 用 `$XDG_RUNTIME_DIR/grokbox/`，fallback `~/.grokbox/run/`。
- 不新建独立 npm package；一个源码模块、多个 entry。
- PatchProfile 含两处精确切片：`createSession` 的 hook，以及 `mainSessionOptions.agentId`。任一处锚点不唯一即拒绝。

Launch context：从已验证 generation 捕获 allowlist 字段，禁止复制完整 `/proc/environ`。

---

## 5. 模型运行时

- `/workspace/.grokbox/box-runtime/models.json`；`apiKeyRef` 仅为 `env:<NAME>` 或 `file:/absolute/path`（`file:` 也放长效树下的 `secrets/`，不进 git）。
- `assignments.main` 是全盒默认；`assignments.agents.<id>` 按 Bot 覆盖。键用稳定 agent id；CLI 在盒内解析名字。省略 `--for` 的 `models use` 改默认。其它 Host 调用面（summary/computer/…）仍是覆盖地图，不是 SlotRegistry。
- turn 钉住该 Bot 的 immutable resolved-config **和 credential fingerprint**，直到 terminal 或 idle TTL；不在 turn 内 refresh/换账户。改 Jerry 不影响 Tom 正在跑的回合。
- modeld 有 generation-scoped 内存 registry（id → fingerprint + state + terminal）。`status` 不对账续传正文。disconnect → abort + unknown。duplicate submit 不重新 dispatch。
- 体验不降级：优先让 Host 既有 retry/checkpoint 工作。不另建第二套消息队列。
- MVP envelope 见产品合同 §12：文本、工具、视觉（模型声明才送；否则可见告警）、并行不得丢 id。
- 可见告警最终由 Host 写入 Transcript（`SendToUser` 或等价），runtime 不私写产品库。

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

managed 一旦对供应商出门，失败不得静默回官方或换 provider。

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

H3 与 I1 需要另一次明确授权。现役 Host 注入前必须有 H1/H2 离线证据。

---

## 8. 自动 / Agent CLI / 人

机器优先。人的入口只有未来盒内 WebUI，映射同一 use case。

**Watchdog 自动（无对应 mutation 命令）**

- 读磁盘 SHA；变化则写合同切片快照
- 作废旧 attestation；未知 SHA 不注入 + circuit-open
- 注入中 SHA 变了则 abort 并按已有路径恢复
- 注入结束普查：恰好 1 wrapper + 1 supervisor + 1 Host
- 停掉我们记下身份的临时 supervisor / 到期 guardian；对不上身份则停手
- `stale-patched`：对签过字且身份仍过的那一个 Host PID 发一次 SIGTERM，让官方用当前磁盘拉未补丁进程；失败一次即 degraded
- 有界 ndjson（`/workspace/.grokbox/box-runtime/log/events.ndjson`，白名单字段）

认不出的多余进程 **不自动杀**。

**Agent CLI（盒内，JSON）**

- 写 desired：`activate` / `deactivate` / `models *`
- 只读：`status`（含 census、diskSha、driftedSlices、circuit、lastHeal）、`log`、`contracts`（切片 SHA/drift，默认无正文）
- `status` / `log` / `contracts` 不 repair
- 禁止：`inject` / `heal` / `kill` / 手动 snapshot

**人 / 另一次授权**

- 切片 drift 后写新 PatchProfile
- 现役 identity/route 注入
- `recovery-required`（误写磁盘、双链清不掉）：官方渠道换 Host；grokbox 不修官方文件
- 未来 WebUI：给人配模型、看状态，背后仍是上述 use case

`deactivate` 是 Agent 的唯一大回滚：desired=disabled，回到单一未补丁官方链。实施打错和生产失效同一条路。

---

## 9. 明确非目标

- 不把 runtime 实现或 Host dump 提交进本仓库
- 不做 RoutePolicy 引擎、不做「有的 Bot 继续官方」的混合路由（另一次产品决定）
- 不把整份 `host-main.cjs` 当滚动备份，不从快照还原官方 Host，不按 diff 自动猜补丁
- 首期 WebUI（盒内 VNC UI 是后续客户端）
- 不把 watchdog 并进 `daemon serve` 或 jobs
- 不把完整 Pi/Cursor agent 伪装成一次 PromptSession
- 不宣称 billing verified、零窗口、fresh recreate 自动恢复

后续变化直接改本 Current Home 与产品/架构义务，不再维持平行提案。
