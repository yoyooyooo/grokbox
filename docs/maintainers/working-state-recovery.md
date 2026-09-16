# 持续 Working：诊断、停止与验收手册

**用途：** Bot 已回复“收工”、外部任务已结束，侧栏却持续 Working 时，沿真实执行归属定位并清理残留工作，而不是隐藏指示器。本手册拥有这条操作流程；各显示面的含义仍由 [Host / App live projections](host-app-projections.md) 解释，App 验收仍由 [Composer Working](composer-working-status.md) 约束。

**适用边界：** 基于 2026-09-16 的排查经验及当前 `activityObservation` v1 实现。`box`、`temporal`、不同会话与不同 Host generation 必须分开。默认只读；本文不是永久停止授权、自动重启策略或新的执行权限。没有本次明确授权，就停在诊断和建议。

## 1. 核心教训与复发判断

**这次不是单纯“假转圈”，而是对用户已无意义、对执行系统仍真实存活的监听子任务。** 要结束的是这些资源的生命周期，而不是把 UI 改成空闲。

三组“不等于”决定了排查顺序：

```text
外部业务任务完成 ≠ 等待它的原生监听子任务退出
父回合结束       ≠ 所有子任务、后台 shell 和 watch 结束
本机任务列表为空 ≠ temporal 服务端执行上下文没有子任务
```

**同类情况有复发条件，但一次事故不能估计复发频率。** 本次清理了具体任务，也部署了诊断能力；没有实现或验证跨外部 worker、原生子任务和后台 shell 的统一自动回收。以后重新创建未绑定终态的监听、父回合停止但子任务独立存活，仍可能产生相同现象。观察器和回归测试缩短了诊断路径，不会替执行 owner 关闭任务。

已经定位的是“原生监听子任务仍存活，并持续贡献运行状态”。本次没有逐个重放监听内部为何未退出，尚不能断言究竟是哪条终态通知、等待条件或取消传播出了问题。因此，生命周期改进列为待实现/待验证的方向，不把猜测写成已证实的底层缺陷。

另需区分：后续新指令合法启动了新任务，是新的工作，不是旧任务复活；权限等待、其他会话活动或 App 本地发送记录异常，也不能套用本次子任务结论。

### 脱敏案例：哪些证据改变了判断

| 排查动作 | 观察与结论边界 |
|---|---|
| 看见外部任务已结束，本机子任务和异步任务列表为空 | 只能排除对应的本地登记，不能排除服务端子任务 |
| 初期猜测旧活动投影超过默认有效期仍未清除 | 未拿到原始 live 时间和实际计时器证据，仍是假说；roster 最后消息时间不是 live 更新时间 |
| 切换到已部署的观测构建并重启 Host | 重连期间短暂空闲；随后不断收到新的服务端 child-only 帧，推翻“只是本机旧帧赖着”的解释 |
| 原生父回合中断返回 `hadActiveRun=false` | 只说明没有父回合被中断，不能作为所有子任务已停止的回执 |
| 由目标 Bot 的原生执行上下文枚举并停止后台工作 | 维护回复报告找到并停止两个监听子任务；这个数量属于目标 Bot 的工具结果转述，不是本地列表的直接证据 |
| 独立复核原生活动和 Gateway | 收到两个运行标志均为 false 的服务端帧，当前 overlay/roster 同步空闲；在跨度超过十分钟的多次检查中未见该状态复发 |

案例中的观察时长不是 SLA，也不保证未来不再创建新任务。真实 Agent ID、nonce、PID、业务回执和原始日志只保存在私有事故证据中，不进入公共仓库。

## 2. 先固定对象，再做只读分流

### 2.1 保存现场

记录目标 Agent ID、发生时间与时区、具体显示面（侧栏、当前聊天、消息流、发送失败气泡），以及已有的 nonce / request ID / STEP。身份未知先解析，不凭名称相似或时间接近串联事故。

在停止、重启、删除消息或清缓存之前保存一份安全快照；含正文的历史查询只在必要时使用。原始凭据、全量响应和私有任务正文不复制到公共文档。当前维护窗口内是否有新业务指令也要记录，防止停错后来启动的工作。

在目标 Box 的正确运行根执行：

```bash
grokbox agents show <agent-id> --json
grokbox agents ownership <agent-id> --json
```

需要判断通道或部署是否缺证据时，再执行：

```bash
grokbox doctor --json
grokbox runtime modeld status --json
```

`agents show` 的 harness 是路由声明；结合 ownership 结果判断归属。`activityObservation` 是独立观察，不授予执行或停止权限。归属读取失败也不能解释成“没有任务”或“账号失去权限”。

### 2.2 正确读 activityObservation

| 字段 / 证据 | 用法及限制 |
|---|---|
| `hostGenerationId`、`instrumented` | 确认当前运行中的 Host 确实加载了观测切片；源码已提交、dist 已构建均不能替代它 |
| `agents[].projection` | 当前 native overlay；`absent` / `unavailable` 不等于明确的服务端空闲 |
| `agents[].sessions[]` | 最近观察到的各会话帧，不是当前子任务清单；已移除会话的历史帧也可能仍被保留 |
| `sessionId` | 空字符串是合法默认会话，不用 truthiness 过滤；其他会话可能使整个 Bot 仍然 Working |
| `isRunning`、`hasRunningSubagents` | 分开看父回合与子任务；缺失字段保持未知，不能补 false |
| `serverUpdatedAtMs`、`serverStaleAfterMs`、`ttlMs` | 原帧时间与有效期；不拿 roster 的最后消息时间代替，也不固定假设永远是 90 秒 |
| `elapsedMs`、`remainingMs` | 收到该帧时计算的值，不是每次查询重新计算的倒计时 |
| `timer`、`settledAtMs` | 观察到的挂载、失败或过期处理回执；`armed` 不证明回调已经执行，`settled` 不证明服务端任务已经结束 |
| 顶层 `observedAtMs` | 查询时间，不能拿它把旧帧变成新证据 |
| `evictedSessions`、`sessionsTruncated` | 明确的覆盖缺口；不能据被截断的列表宣称“所有会话都空闲” |

需要核对帧序列和计时器时，读取同一 Host 运行根的 `host_server_activity_observation` 事件。已有入口为 `grokbox runtime log --source host --json`；它返回有界窗口，不承诺覆盖整段事故。正确指定原部署的 `GROKBOX_RUN_ROOT`，核对 generation、时间和日志缺口。不同进程的追加行序不证明跨进程因果。

### 2.3 分支表：下一步由谁处理

| 当前证据 | 判断 | 下一步 |
|---|---|---|
| 相关会话收到新帧，父回合运行中 | 有实际父回合活动，不能称为假 Working | 核对该回合是否仍在用户授权范围；有停止授权才中断 |
| 新帧父回合为 false、子任务为 true | 服务端仍报告子任务，可能是残留监听，也可能是有效工作 | 转到原生执行 owner 枚举；不要用本地空列表或空消息预览代替 |
| 原帧已过有效期、未见更新，而当前 overlay 仍 busy | 才进入过期计时、发布、重连和代际排查 | 核对实际 timer 事件及覆盖缺口；仅有一条旧 witness 不足以定本机故障 |
| 服务端与 Gateway 已明确空闲，App 同一会话仍转 | 客户端投影、路由、发送队列或安装问题 | 保留原发送身份，走 [App 验收](composer-working-status.md)，不杀无关任务 |
| 缺观测、缺归属、重连中、被截断或来源矛盾 | 状态未确认 | 补对应证据；必要的版本切换单独获授权，不能把未知当成空闲 |

对于 `box` 路径，用它自己的本地 run、子任务和后台工作 owner 排查；本文的 temporal 子任务链不能替代本地执行诊断。对 `temporal`，modeld 为空闲或已升级都不能证明它的服务端任务结束。

## 3. 只有明确停止授权，才进入清理

### 3.1 确定停止范围

把“停止当前父回合”“停止该 Bot 为指定任务创建的原生子任务和监听”“停止外部业务 worker”分开。后两项不能靠一句父回合停止回执互相推导。用户只要求停止残留监听时，不顺手终止其他 Bot、远端业务 worker 或新收到的任务。

`interruptAgentRun`、`getSubagents`、`getAsyncTasks` 在这里指原生接口，不是新增加的 grokbox CLI 子命令。操作人员没有合资格入口时，不编造命令、借用内部通用 RPC 或临时搭一条第二 Watch。

### 3.2 到真正的执行上下文停止

由目标 Bot 的原生执行 owner 使用 `CheckSubagent`（不传 id）查看其可见子任务，并按当前工具契约用 `StopSubagent` 停止已确认属于本次范围的 running 子任务。工具名和参数需要以该运行上下文实际暴露的版本为准；本地 grokbox 自定义模型进程不是 temporal 子任务的 owner。

后台 shell/watch 优先使用 owner 返回的任务句柄和取消能力。必须用进程信号时，先核对精确 PID、启动身份、归属和用途，发信号前再次核对，防止 PID 复用。不因命令名含 watch、inotify、ssh、Herdr，或 PPID 变成 1 就批量终止。不能确认归属或无法枚举时，保留未清理项并升级处理，不猜测“全停了”。

单次中断或发出停止请求后，要重新枚举确认；不能靠反复 stop、无限等待或重启所有组件掩盖未知结果。

### 3.3 没有外部子任务控制入口时：一次显式维护消息

这是一条**新的、经授权的维护操作**，会让目标 Bot 短暂开始一个新回合，可能消耗模型请求。它不是自动重试，也不是重发先前发送失败的业务消息。若目标不能正常接收指令或执行原生工具，此路径不能保证可用，应保留证据交给实际执行 owner，而不是循环发送。

可复用的维护指令正文：

```text
只处理本次授权范围内、由你为已结束任务创建的原生子任务和后台监听。
先用当前运行上下文的原生工具枚举并核对任务身份，列出真实结果；
只停止确认属于该范围的 running 子任务，以及你自己仍登记的后台 shell/watch。
优先使用任务取消句柄；使用 PID 前核对当前启动身份、归属和用途。
不要因为外部任务界面空闲，就断言原生监听为空。
不要继续旧业务、重新派活、等待新回执或再建监听；不要改代码或提交。
不要停止其他 Bot、Host、modeld、未授权的外部 worker 或未知进程。
能力不可用、枚举不全、停止未确认时明确报告，不能猜测成功。
最后只回复实际检查结果、已停止项、未清理项与标记 MAINTENANCE-WORKING-CHECK，
随后结束本轮，不保持监听。
```

将正文作为 `--text` 参数，给本次维护生成新的 UUID v4 nonce，记录后再发送一次：

```bash
grokbox send <agent-id> --expect-kind agent --nonce <new-maintenance-nonce> --text '<维护指令正文>' --json
grokbox history outcome <agent-id> --nonce <new-maintenance-nonce> --expect-harness temporal --json
```

第二条命令只适用于已经确认的 temporal 路由；该路由不要加 `--runtime`，后者只关联 box-local modeld 执行。nonce 一旦发送就固定，超时或响应不明时先查同一 nonce，不生成新 nonce 重复发。读取回执使用有界等待或有限次数查询，不引入永久后台轮询。

`accepted` 只代表接收入队；维护回复只是报告。`history outcome` 可能仍显示 `progress` / `executionCompleted:not_proven`，不能把回复标记当成原生任务全停或 App 已恢复的证明。`--expect-text` 是完整预期消息的精确匹配，不拿一个嵌入式标记冒充全文匹配。

## 4. 重启与升级：补运行能力，不当通用停止手段

需要新观测切片、组件协议不匹配或已有独立部署故障时，沿 [Host 恢复](../../skills/grokbox/adopt.md) 和 [运行版本切换说明](run-outcome-observation.md) 操作；先保留现场，再确认允许中断的范围。按当前状态输出的 next 与已核对的 service epoch 执行，不照抄历史 PID、SHA、generation 或替换命令。

升级要核对源码、构建、磁盘 profile、已加载 Host 和驻留 modeld，而不是看到新 commit 就宣布部署完成。切换后确认 doctor、modeld 的协议/服务身份和 `activityObservation.instrumented`，再等待真实 server 帧。CLI 与 modeld 的协议一致，也不自动证明 Host 已加载同版。

**重启不是跨域取消。** 它可能只清掉本地投影；服务端下一帧会把真实子任务活动重新带回来。若新帧仍 child-only，返回第 3 节，不进入“再重启一次”的循环。禁止清空 overlay、强写 running=false、改 harness、删除去重库或自动重放旧请求来制造成功。

## 5. 验收：资源停止、投影空闲、App 恢复分别交代

验收至少保留以下三层证据，不能互相替代：

1. **执行 owner：** 再次枚举确认授权范围内不再有 running 子任务/后台等待，记录未知项。停止回执不代表外部业务已完成，也不代表发生过的工具副作用已回滚。
2. **活动生产与投影：** 在清理之后，相关会话收到明确的 `isRunning=false` 和 `hasRunningSubagents=false` 帧；随后 native projection 与 Gateway roster 均为空闲。不能把 `timer=settled` 或 `projection=absent` 单独当作这份服务端结束证据。
3. **用户界面：** 同一 Bot/会话的 App 实际视图或用户确认。没有这层证据时只说“执行与 Gateway 已空闲，App 显示未验证”。发送失败气泡的排序和接收确认仍要独立处理。

在本次授权的观察预算内，至少保留清理后的首次样本与跨过相关原帧有效期的后续样本，并核对期间有无新的任务、代际变化和可见 busy 帧。使用实际 `serverStaleAfterMs` / `ttlMs` 加合理调度余量，不机械等待 90 秒。计时器过期只能排除某些旧投影，不能替代正面的停止证据。

样本间没有连续覆盖时，准确说“这些时点未见复发”，不声称连续监控证明。日志丢失、会话淘汰/截断、持续连接未证实或时钟异常要写成限制。预算不足时保留已确认结果和待验收项，不自动安装定时任务。后续新合法任务使 Bot 再次 Working，要重新核对任务身份，不自动再停止一次。

## 6. 如何降低复发：已经做到的与尚待实现的

| 措施 | 当前作用 / 状态 |
|---|---|
| 原生活动帧、当前 overlay 与 timer 观测 | 已有实现；可以定位究竟是新 child-only 帧、旧投影、重连还是缺证据，不会自动取消任务 |
| 明确的停止指令、owner 枚举与多层验收 | 本次用它清理了实例；可复用流程，不是以后每次都已获授权 |
| 外部任务和监听成对登记 | 建议：创建监听时记录它等待哪个工作项、由谁拥有、使用哪个取消句柄；工作完成/失败/取消都应结束相应等待 |
| 有界等待与不重复创建监听 | 建议：设定失联/超时策略，同一工作项不要因为父回合重入再生成独立监听；没有终态证据时报告未知，不无期限静默等待 |
| owner 管理终止传播和收工检查 | 建议：明确父回合取消如何处理子任务，最终回复前核对本次资源并报告残留；真正的强保证需要执行 owner 的代码及生命周期测试，不是提示词承诺 |
| 只读诊断或提醒进一步产品化 | 候选：child-only 久置只能提示复核，不能直接判故障或触发自动停止；合法长任务、权限等待、其他会话和新授权任务必须保持可见 |

本手册没有新增通用“停止所有后台”CLI、自动回收器或持续告警规则。未来工程化应落在真实执行 owner，使用现有身份、生命周期和日志，不再造一份会竞争的任务登记或状态写入器。需要验证成功/失败/取消/超时/重连各路径释放资源，晚到旧回调不伤新任务，停止不等于回滚，未知结果不会被写成成功。

## 7. 复用时留下的最小回执

```text
目标与范围：Agent / session / harness；允许停止什么、不允许停止什么
原症状：侧栏 / 当前会话 / 单条消息 / 发送状态；时间与时区
运行身份：Host generation、modeld service epoch（适用时）、是否实际插桩
首次事实：父回合与子任务标志、原帧时间/TTL、timer、当前 overlay/roster、覆盖缺口
分支结论：实际工作 / 残留监听 / 过期投影待查 / 客户端待查 / 未确认
执行动作：具名 owner、已确认任务身份、停止结果；维护 nonce（如有）
独立验收：后续 server idle、overlay/roster、观察跨度、新任务及 App 证据
限制：无法枚举项、未知副作用、断线/截断、未获授权或未覆盖的范围
```

该回执保存到事故的私有位置，不把实际凭据、账号、私有业务数据或机器记录提交进公共 Git 历史。

## 8. 实现与回归锚点

- [活动事实合同](../../packages/runtime-kernel/src/internal/contract/activity-observation.ts)：安全字段、合法空 session、缺失与截断。
- [原生观察器](../../packages/box-runtime/src/internal/host/server-activity-observation.ts)与[切片](../../packages/box-runtime/src/internal/host/server-activity-slices.ts)：读取已有 native timer owner，不另开 Watch、不改变状态。
- [观测回归](../../packages/box-runtime/test/server-activity-observation.test.ts)：child-only 新帧、显式 idle、其他会话隔离、原生异常和日志。合成测试不是跨系统自动清理或 App 像素证明。
- [完整 Host 测试样本](../../packages/box-runtime/test/live-shaped-host.ts)与[切片准入回归](../../packages/box-runtime/test/e07-host-admission.test.ts)：新增切片时必须同步完整样本、切片清单和打包资格，不只跑新文件的局部测试。
- [打包指纹验证](../../packages/box-runtime/test/context-continuity-artifact.test.ts)与[skills 入口测试](../../test/skills.test.ts)：构建匹配、按需读取与随包可达，不靠未发布的文档路径让默认 Bot 才能运行。

上游运行状态字段、默认 session 语义、原生停止工具、任务归属、Host 切片、App 路由或部署流程变化时，重新核对本手册。历史案例和一次通过的测试都不是最新版本的永久资格。
