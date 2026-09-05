# Box-local model runtime

本文是 Grok Bot **模型替换运行时**的设计 Current Home：接缝、注入、modeld、配置和失败语义。它描述已接受的**未来完成态**，不是当前源码已实现清单。

产品命令、本机边界、envelope 和可见错误义务见 [产品合同 §12](product-contract.md)。模块与 composition roots 见 [架构 §17](architecture.md)。交付进度只在本地 Issue tracker。源码和可执行测试拥有当前实现真相。

本仓库是公开、自包含的控制面。上游 Host 研究材料若存在于 maintainer 私有环境，只作证据输入，不是本仓库实现权威，也不得把私有 dump 提交进 git。

## Freshness

Host bundle SHA、PromptSession/`SendToUser` 合同、官方 wrapper/supervisor、或 `~/.grokbox/runtime/` CLI 安装布局变化后必须重审本文。

---

## 1. 结果

用户继续在原 Grok Bot App 中工作。ordinary main 的模型可由盒内 `assignments.main` 替换。Host 继续拥有排队、工具授权与执行、Transcript、Memory、`SendToUser`。

不允许：第二套 Agent loop、全 backend MITM、永久改官方磁盘 bundle、经 daemon/SSH 转发 runtime mutation、managed 失败后静默回官方。

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

Host 内 hook **不读** `models.json`，**不读** attestation 文件。`activate --mode route` 必须已有有效 `assignments.main`。

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
- 配置与 release 在 `~/.grokbox/box-runtime/`，不得占用 CLI 安装目录 `~/.grokbox/runtime/`。
- 不新建独立 npm package；一个源码模块、多个 entry。

Launch context：从已验证 generation 捕获 allowlist 字段，禁止复制完整 `/proc/environ`。

---

## 5. 模型运行时

- `~/.grokbox/box-runtime/models.json`；`apiKeyRef` 仅为 `env:<NAME>` 或 `file:/absolute/path`。
- 只实现 `assignments.main`。其它 Host 调用面是覆盖地图，不是 SlotRegistry。
- turn 钉住 immutable resolved-config **和 credential fingerprint**，直到 terminal 或 idle TTL；不在 turn 内 refresh/换账户。
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

## 6. 证据分层

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

## 7. 明确非目标

- 不把 runtime 实现加回 sibling `grok-bot`
- 不做 RoutePolicy 引擎、per-agent 路由、首期 WebUI（盒内 VNC UI 是后续客户端）
- 不把 watchdog 并进 `daemon serve` 或 jobs
- 不把完整 Pi/Cursor agent 伪装成一次 PromptSession
- 不宣称 billing verified、零窗口、fresh recreate 自动恢复

后续变化直接改本 Current Home 与产品/架构义务，不再维持平行提案。
