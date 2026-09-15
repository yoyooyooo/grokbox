# 运行结果与 App 警告观测

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

当前用途：生产 grok-4.6 的 CLI 自测试闭环。合同归 [产品合同 §7.3/§7.4](../product-contract.md) 与 [Spec S0.4.1](../roadmap/box-runtime-impl-spec.md)，Host 流合同归 [T26](../tickets/T26-runtime-host-fullstream.md)，发布事实归 [readiness](t32-live-enable-readiness.md)。本页是观测入口/含义，不另定义执行器、重试器或任务数据库。投影实现是 `packages/cli/src/outcome.ts`；`SEND_OUTCOME_STATES` 或 nonce-first join 变更时重审本页。

## 三类证据不能互相替代

| 表面 | 实际 owner / 生命周期 | 能证明什么 |
|---|---|---|
| `Gateway.getTrays` / `tray` 事件 | 当前 Host `TrayManager` 的内存列表，非 SQLite 任务表。当前源码最多20条 tray、每条最多20个发生时间；会去重、dismiss、evict、新发送清理、重启丢失 | App 当前警告及推送/移除；空列表不能证明成功，不能回查已丢失告警 |
| `Gateway.getAgentTranscriptTail` | 当前目标的 display transcript，明确 nonce、requestId、entry | 用户输入被记录、SendToUser 内容被记录；进度/ack 也在这里，不等于最终业务结果或整个 run 完成 |
| `run/log/events.ndjson` | grokbox Host/modeld 的既有本机持久日志，投影有界，读取可能 truncated | 同一 Agent/TURN/STEP 的准入、推理、Host拒绝/终态；不直接证明用户已读或最终业务成功 |

2026-09-12 对 Host source `307de399…` 检查：trays-service 的 `TrayManager` 只有数组/EventEmitter/去重/上限逻辑；Gateway `getTrays` 委托其 list，Host通过 singular `tray` channel 发布事件。这不否定 App 自己可能有缓存，但本功能不依赖未知客户端存储。源码变化时重审 API、事件形状及生命周期。

## 金丝雀路径（唯一）

Agent 只打这两条。主句柄是 send 回执里的 `clientNonce`。不要用 `alerts list --nonce`（该旗标不存在），也不要发明 `correlationId`。

```sh
grokbox send <agent-id> --text '<text>' --json
# 记下 data.clientNonce。data.accepted / data.status=accepted 只表示已入队，不是回复成功。

grokbox history outcome <agent-id> --nonce <clientNonce> --runtime [--wait-ms 60000] --json
```

`--runtime` 把本机 journal 当作失败权威。查询顶层 `ok:true` 只表示查询成功，必须读 `data.state`。**outcome 无 `accepted` 成功词**；旧 `acceptedObserved` 已改为 `echoObserved`。`data.requestId` 在早期 admit 失败时可为 null，这不表示没发出去。

| `data.state` | 含义 |
|---|---|
| `recorded` | 仅有 user echo 或 journal bind，无终态证据。等待中。不是成功。 |
| `failed` | 命中 durable 拒绝 / 相关 terminal error / 相关 live tray。空 `alerts` 不得改回 `recorded`。 |
| `progress` | 有 delivery，`--expect-text` 未匹配 |
| `delivered` | 有同请求 send-message |
| `expected_result_observed` | 精确预期内容出现。`executionCompleted` 仍为 `not_proven` |
| `unknown` | 证据缺失、冲突、harness 变化或协议未知 |

`--wait-ms` 只把 `failed|delivered|expected_result_observed` 当 settled；`recorded` 继续等。`executionCompleted:"not_proven"` 始终明确：该命令没有另造原生 run-completed 权威。预期内容只能验证业务断言，不能替代工具是否实际运行、模型身份、checkpoint/reload 等独立证据。

Join（与投影器一致，不另造状态机）：echo 按 nonce 或 requestId；journal 按 `clientNonce` 命中或已在种子里的 turnId/stepId；trays 只按种子里的 requestId/stepId 关联，禁止只按 agentId 模糊匹配。冲突 → `unknown`；关联 durable 拒绝 / terminal / live tray → `failed`；delivery → `delivered` / `progress` / `expected_result_observed`；仅 echo 或 journal bind → `recorded`；否则 `unknown`。transcript 窗口没有 echo、但 journal 已有该 nonce 的 reject 时，仍是 `failed`。

## 稳定命令

在源码工作树可用 `bun run grokbox`；实际打包版本可用 `node dist/index.js`；安装版本为 `grokbox`。金丝雀不必打下面这些；它们不是第二套观测入口。

```sh
# 仅读当前警告，不 dismiss/clear，不输出 rawDetail、actions 或私密 URL。没有 --nonce。
grokbox alerts list --agent <agent-id> --json

# 自发送开始之前订阅可捕获短暂出现又被清除的警告；沿用既有事件游标/gap。
grokbox events --channels transcript,tray

# 可选：等一个明确的最终预期内容。--runtime 已隐含 --expect-harness box。
grokbox history outcome <agent-id> --nonce <clientNonce> \
  --runtime --expect-text 'EXPECTED_FINAL_RESULT' --wait-ms 60000 --json

# 次查找：从已有 requestId 解析到同一 SendAttempt，不是第二主键。
grokbox history outcome <agent-id> --request-id <id> --runtime --json
```

`--runtime` 只允许明确本机 local/auto Profile，拒绝 remote/SSH/daemon/gateway Profile，避免用本机日志给远端任务背书。普通 alerts/outcome 通过 typed Gateway 和 daemon 两种实现；daemon 添加 `grok.alerts.read`，旧 daemon 未提供时不能伪造支持。

同一 Bot 的两份历史不能混算：`agents show/list` 和 roster 事件保留 `harness: box|temporal|unknown`，结果查询用同一 Gateway 的 roster 在每次采样前后校验。`--expect-harness box|temporal` 声明要验的入口，`--runtime` 默认要求 box；路由变化/未知/不符保持 unknown，不返回借另一份历史匹配出来的成功。`evidence.transcriptRoute` 明确声明来源、前后值、非原子采样以及桌面 replica 未观测。完整边界与双账本区别见 [Transcript harness](transcript-harness-box-vs-server.md#acceptance-must-not-mix-transcript-sources)。这不是修复 App 缓存或同步两套 store。

观测等待最多120秒，RPC受剩余预算约束，每次最多5页/1000项，间隔2秒，不在超时后发最后一轮多余请求。匹配失败优先于已发进度；Host明确拒绝优先于其后 modeld 的断连取消。Gateway代变化、nonce关联多个request或未知告警结构保持unknown。无原始body/密钥/操作action进告警投影。事件脱敏保留安全requestId/clientNonce、started/ended身份信息；ended仍不是成功。

## 这次 App 反例及永久修复

Synthetic regression scenario: an earlier progress message is not a final result. A later Host rejection must remain `state:failed` even when live trays have already disappeared. The owned regression fixtures carry the public proof; private transcripts and execution identities are not distributed.

桥的原策略是 `parallel:fail-closed`，却未统一将它写入provider请求。当前源码在Host stream准入前设置canonical `parallelToolCalls:false`，Chat/Responses adapter按原合同编码成 `parallel_tool_calls:false`，恢复也保留原STEP参数。仍保留违约多调用时零 executable release 的拒绝，不靠删检查/丢弃调用/静默执行追绿。这不宣称已新增并行工具支持。

Host终态持久投影新增terminalClass/errorCode/toolCallCount/modelId，拒绝记录增加stepId。这样以后可以分清Host的 `parallel_tools` 与模型端被关socket后的 `disconnected`，不用再依赖用户截图。该新增Host写入逻辑只有新preload被加载之后才生效，不能回填旧历史。

## AH-92.5 wave D：早期 admit 拒绝

现场 catalog 里的可选模型都是 openai*，`models use` 对未登记 id 会在写入前拒绝（`Unknown model … Add it to models.json first.`）。因此不能再用 `models use <非 openai*>` 复现原始狗粮班。最小负例是：只给一个 box Bot 临时写入非 openai 赋值 `ah92-admit-deny/none`（provider `acme`），然后跑金丝雀两条命令，最后还原 `models.json`。不新增 CLI 面。维护入口：

```sh
bun scripts/verify-ah92-admit-observation.mjs --confirm [--agent model-dogfood]
```

缺 `--confirm` 不写盘。禁止打长期金丝雀 `grokbox` Bot。默认目标是 `model-dogfood`（`00000000-0000-4000-8000-000000000119`），跑完必须把它付回原先赋值。

Expected message: `route admits only stub/echo or openai* in this slice.`. Public acceptance assertions: early admit denial remains `failed`, including with a null display request ID or empty alerts; the durable rejection must be nonce-bound and stable across readers. This is a synthetic test recipe, not a published live receipt.

失效条件：Host preload 丢 nonce 绑定、catalog 出现 CLI 可 `models use` 的非 openai 模型、或 outcome 又把空 alerts 当成成功。

## 换模防回归（AH-97）

立刻绿不够。金丝雀对长期狗粮 Bot（默认 `model-dogfood` / 当前 assigned Pi 模型）按顺序：

```sh
grokbox models use <model-id> --for model-dogfood
grokbox send model-dogfood --text '<text>' --json
# 记 data.clientNonce。入队不是回复。

grokbox history outcome model-dogfood --nonce <clientNonce> --runtime [--wait-ms 60000] --json
grokbox agents show model-dogfood --json
# data.agent.title （App Label）须含 m=<alias-or-model>

grokbox agents title sync
# 再等至少一轮 daemon title-sync（~120s），再 show；m= 仍须在。
```

仍只打金丝雀两条观测命令；send 回执 / 空 alerts / 第一秒 title 不得当成换模成功。运行者文案见 [skill](../../skills/grokbox/SKILL.md#prove-a-model-switch)。禁止打长期金丝雀 `grokbox` Bot。

## 验证与现场边界

2026-09-12本轮 scoped regression **123 pass / 0 fail**（含CLI/事件/管理/运行时合同、12个结果观测测试、5个工具准入/终态测试、持久凭据与原生outer retry回归）。真实只读结果查询也已完成。完整全仓测试调用及候选 profile-write/re-adopt 调用被工具安全检查拦截，未执行；未改路重试部署，没有宣称串行策略修复已在现场加载或真实工具链已验完。具体制品身份与后续待验项以readiness为准。
