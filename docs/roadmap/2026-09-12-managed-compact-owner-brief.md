# 自定义模型路径 × Host Compact — 业主审阅稿

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**状态：** 规划/口径稳稿（2026-09-12）。**不是**实现完成声明，**不是** GATE 授权，**不开**实现 lane。  
**配套技术详稿：** [2026-09-12-managed-compact-path.md](./2026-09-12-managed-compact-path.md)  
**继任交接：** [2026-09-12-orchestrator-handoff.md](./2026-09-12-orchestrator-handoff.md)  
**活证/诊断回执（机内）：** `PRIVATE_EVIDENCE`、`PRIVATE_EVIDENCE`

---

## 1. 上层目标（先对齐这个）

一个 bot 切到背后的**自定义模型**之后：

1. 该 bot 的 session 消息，都流入这只自定义模型（Host 选好的窗口透传进去）。
2. 遇到需要压缩时，**压缩交接仍挂在这条会话/STEP 上**；压完用**同一只自定义模型**继续往后走（attempt1）。
3. 这是产品连续性目标。**不是**「必须把摘要模型也改成同一只自定义模型」。

---

## 2. 下层手段（另算，可复用可打补丁）

Host 原有 Compact 上下游：

- **能复用就复用**（分区、归档、改写 Host root、同连接 CF、官方专用 summarizer 等）。
- **复用不了**，仍在 Host **原本 Compact 相关接点**打补丁。
- **不要**另起一套 grokbox 近窗裁剪 / 第二套摘要器 / 把 `store.db` 历史塞进 live prompt。

一句话：Host Compact 是**手段**；自定义模型会话不断档才是**目的**。

---

## 3. 当前链路长什么样（已接线 vs 未证活）

```text
Host 窗口
  → harness=box 的 create-session 包装
  → modeld 自定义模型 run-step（attempt0）
  → 确认 structured overflow
  → 同连接 compact-request
  → Host requestHostCompact（需 D2 slot 就绪）
  → Host handleSummarization（专用官方 external summarizer）
  → resume-step → 同一自定义模型 attempt1
```

| 段 | 现状 |
|---|---|
| 消息进自定义模型 | tip 已有；live 需 `harness=box`（L2c 粘住已证） |
| overflow 分类器 | tip 已有；L5 活证打出过 `context_length_exceeded` |
| 同连接 CF 桥 | tip 已有；默认 GATE off |
| Host Compact 核心 | **复用** Host；摘要走官方专用模型，**不**绕回忙着的 managed STEP |
| compact → resume 活证 | **notProven**（L5 硬 blocker） |

**刻意没切到自定义模型的：** Compact 里真正写摘要的那一下。原因：主 STEP 正等 compact，摘要若再进同一忙 STEP，wait-graph 会死锁。

---

## 4. 现在卡在哪（背景 → 遭遇）

### 4.1 已扫清的前置

- L2 / L2c：`profile.harness` 粘住；test2 可稳定 `box` + managed STEP。
- Living Host（本稿撰写时）**3675514** grokbox-attested；compact bind 在；GATE/canary **unset**。
- L5：GATE-on 窗口下 journal 到 structured `overflow_candidate`，说明**触发器**工作。

### 4.2 硬 blocker

失败类：`host_cf_disconnect_after_structured_overflow` / dig 后的  
`slot_unready_or_blocked_before_fast_overflow`（主）+ `compact_wait_expires_while_host_summarize`（次）。

活现象：

- ~80ms 断连：slot 还没挂上，或 background summary 占着 → blocked → `compact_rejected`
- ~5s：slot 已活，Host 在 summarize，但 modeld 的 `COMPACT_WAIT_MS`（5s）等不到 resume

### 4.3 根因（直白）

**wait-point** = Host 这一步里「允许挂上 compact slot」的时刻。

当前 Host `runStep` 顺序（活磁盘）大致是：

1. 记下 STEP id  
2. **先开** `executeToolStream`（自定义模型开始跑）  
3. 可能 await background summary  
4. 才 `let stepClosed`  
5. **这时才** D2 compact-register  

自定义模型窗口往往比 Host 窗口小 → **第一次请求就 overflow**。请求来时 slot 常还不存在 → 和「快 canary」是同一类赛跑，不是 canary 特例。

Compact **不是**「模型自己同步砍上下文」；是同连接声明 → Host 在 wait-point 接任务 → 交回 resume。但也**不是**「先申报、改天再压」——modeld 在同连接上有时限地等回执。

---

## 5. 后续思路（选项与推荐）

本稿**不授权**下列任一项；供审阅拍板。

| 选项 | 做什么 | 代价 | 与上层目标 |
|---|---|---|---|
| **A. 改 wait-point（推荐）** | register 提前到 `executeToolStream` 之前（或收窄：slot 前不 await approaching-limit summary）→ 新 Host 资格 + packed re-adopt | 补丁面/回归最大 | 对准真实自定义模型首请求 overflow |
| **B. 观察切片** | journal `requestHostCompact` kind/reason + re-adopt + 一次 GATE | 多一轮 adopt；不产生 resume | 只为钉 unready vs blocked；不能当收口 |
| **C. 接受快 canary 证不了** | 保持现 insert；等「慢溢出」 | 最便宜 | **放弃**上层目标里最常见的首请求 overflow 连续性 |

**推荐顺序：** A 为主产品杠杆；B 仅在你要先多一层活标签时；C 明确降级，不作为连续性策略。

**A 之后才：** 一次 GATE-on（test2 / 必要时新探针 bot）journal overflow → compact-request → resume；再恢复 GATE unset。默认 off 不变。

---

## 6. 明确不做

- 发明 grokbox 并行摘要器 / 近窗 CAP / 往 live prompt 塞 `store.db`
- 把 Host 专用 summarizer 路由进正在忙的 managed STEP
- 用 Host 外层 input-limit 重试或排队 summarizeAction 冒充 T32 恢复
- 把 `overflow_candidate`、5s 超时、消息数骤降当成「已 compact 成功」
- 未审阅授权前开实现 lane / 盲开 GATE / 为缺 hook 而 unload（bind 已在）
- 为调「漂亮」去优化 canary bot 本身（canary 只是探针；必要时可新建探针 bot）

---

## 7. 和周边文档的关系

| 文档 | 角色 |
|---|---|
| **本页** | 业主口径 + 背景 + 后续思路（审阅入口） |
| [managed-compact-path](./2026-09-12-managed-compact-path.md) | 英文技术详稿：桥接表 / reuse vs patch / 选项 |
| [T32-runtime-confirmed-compact](../tickets/T32-runtime-confirmed-compact.md) | 实现票 |
| [T32-host-compact-seam](../tickets/T32-host-compact-seam.md) | Host seam 资格 |
| [t32-live-enable-readiness](../maintainers/t32-live-enable-readiness.md) | GATE / canary 就绪（默认 off） |

---

## 8. 请你审阅时重点看的三句

1. 上层目标是否就是「自定义模型会话连续，压完还用同一只」？  
2. 摘要阶段继续用 Host 官方专用模型、不进自定义模型，是否接受？  
3. 是否授权以 **wait-point（register 提前）** 为下一实现主线（另开 lane），还是先观察 / 先停？

审阅结论请直接回本对话；通过后再开实现，不在本页默认开工。

## Freshness

失效条件：wait-point / background 补丁合入并活证 resume；Living Host `runStep` 顺序相对 `2ede71e2…` 漂移；产品改判摘要也必须走自定义模型；或明确接受 C 并改写上层目标。
