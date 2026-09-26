# 2026-09-20 旧 Host 补丁失效检测、告警与自治链审计

## 范围与结论

本轮依用户明确要求，只分析破坏重建之前已有的 Host 补丁、来源资格、controller、monitor 和通知机制。不评价新 CLI / Web / materials / protection 入口是否迁完，不把并行施工差额算成上游兼容问题。

基线为本工作树 HEAD `a3e9131`。Host seam、preload/compile、controller、monitor 主循环等关键文件与 HEAD 相同；对发生重建改动的 CLI 命令、daemon、monitor store、通知 driver，使用 `git show HEAD:` / `git diff HEAD` 区分原有逻辑。旧 daemon 已持有 monitor 与 notification worker；本文不以新管理 Server 为旧实现的运行所有者。

**结论：已有机制不是空壳。精确字节/字符串防错、Golden 写入门、编译成功证明、幂等操作、持久 incident/outbox 都值得保留。但它们没有组成全覆盖、持续运行的“Host 形状破裂 → 自动发现 → 精确 incident → 可送达告警 → 恢复确认”闭环。主要缺口在持续来源生产者、负向加载回执、兼容性事件到 incident 的接线，以及告警与被监控 Host 同故障域。**

本次没有读取实际用户对话/密钥，没有实际 Gateway HTTP、模型或 Bot 调用，没有采用/重启/更新 Host，没有修改 App/harness/服务/全局 CLI。实际 Host 只读字节测量与隔离测试不是现场运行资格。本报告是固定审计，不是新合同、自动处置授权或实施完成声明。

## 1. 已有三条链路及实际连接状态

| 链路 | 现有入口与实现 | 已有能力 | 边界/缺口 |
| --- | --- | --- | --- |
| 加载防错 | `host/profile.ts` → `host/compile-hook.ts` → `preload.ts` | 精确源 SHA、唯一锚点/替换、变换 SHA；成功编译后正向 marker | 不匹配时不注入但继续原生编译；没有同等明确的负回执 |
| 离线来源与形状分析 | `ops/host-seam/observe.ts`、`replay.ts`、`shape*.ts`、`envelope-windows.ts`、`process/profile.node.ts` | 来源留存、两刀口、Golden、窗口变化审查、AST/lexical 候选 | AST 不在运行加载门；默认两刀口不代表完整配方；watch 仅 once；analyze 未接真实 runner |
| 持续观察与通知 | 旧 daemon → `roots/monitor.runtime.ts` → `monitor-store.node.ts` → outbox → notification worker | 归属采样、Host/control 日志 intake、incident、持久通知与去重 | 未周期接入 Host 来源/形状/loaded 健康；旧升级事件只是 evidence；投递依赖健康且资格匹配的接收 Host |

现有统一 controller 的确认、lease、幂等和未知结果处理独立于以上观察链，应继续作为唯一生命周期写者。不要把监控接线做成第二个 controller。

## 2. 精确加载门很实在，但“拒绝补丁”不是“记录失败并告警”

### 2.1 已验证的防错

`packages/box-runtime/src/internal/host/profile.ts:75–110` 的 `applyPatchProfile` 依次验证源 SHA、允许切片集合、起止锚点唯一性、窗内替换唯一性与整个变换结果 SHA。任一步失败不会返回部分打补丁的代码。

`host/compile-hook.ts:25–40` 在失败时返回原始 native bytes，`transformed:false` 和有限 `code`。`installCompileHook` 在目标模块上仍调用原始 `_compile`；成功变换并实际编译结束才触发 `onTransformed`。

本次合成反例：给已匹配来源添加无关注释，结果为 `unknown-sha`、`transformed:false`，输出严格等于新原始输入。第二批实际 disposable preload 测试同时通过：source mismatch、syntax error、compile throws 均不签发 compiled receipt。

### 2.2 负证据缺口

`compile-hook.ts:38–39` 的投影丢失底层失败 `sliceId`；`installCompileHook` 没有 `onRejected`。`preload.ts:149–179` 只写成功 marker，没有 failed/refused marker。Alert 与 Server activity 观察器在成功变换前的 `onTransforming` 才安装，因此不能指望它们解释“正是它们的补丁没有装上”。

这不代表完全无错误信号：有采用方等待 marker、有按需 status 和 controller preflight。但细节可能退化为 missing marker、source mismatch 或 timeout，而不是带来源/profile/切片身份的直接失败事实。

**补丁 fail-closed 与产品执行 fail-closed 必须分开。** 未适用的 patch 不会写入 Host，这是已证；原生 Host 仍可能继续其原生执行路线，这是编译路径允许的行为。不能把“拒绝注入”解释成“所有用户后续输入都被阻止”或“自定义模型仍在生效”。本轮没有验证现场消息实际走了哪条路。

建议：在实际编译边界产出有界、脱敏的失败回执，绑定 operation / process lifetime / observed source SHA / expected profile 与 preload / stage / finite code / slice ID；与成功 marker 同一 attempt 区分。日志不可用不得破坏原生编译，但外层观察方要能识别回执缺失，不把缺记录解释成成功。

## 3. 字符串、四窗、Golden、AST 是不同证据，不是一个“形状已锁死”布尔值

### 3.1 现有覆盖面

| 证据 | 实际覆盖 | 可以说明 | 不能说明 |
| --- | --- | --- | --- |
| 整源 SHA + profile | 被审核的精确输入/输出及配方切片 | 当前字节是否属于该 profile | 新 SHA 的逻辑是否等价 |
| `KNIFE_SLICE_IDS` | create-session、agent-id 两个 | 两个核心插入位置/计数/来源范围 | 所有 retry、context、alert、startup 均可用 |
| `CONTRACT_SLICE_NAMES` | create-session、session-options、agent-id、prompt-session 四窗 | 旧窗口快照差异 | 整个执行/观测 contract 没变 |
| execution envelope Golden | 基础 19；随 context/current-state 能力扩展，本次最大集合 48 | 更大范围窗内容、锚点/替换计数及插入关系变化 | AST 语义等价、未包含的观察器健康 |
| Acorn / lexical shape | 两个核心候选族 | 找可能插入点、抵御部分注释/字符串假目标 | 作用域/控制流/写者语义已经证明 |

源码：`ops/host-seam/knife-points.ts:9,128–220`，`io/contracts.ts:19–20`，`ops/host-seam/envelope-windows.ts:27–46,238–250,594`。

本次实际集合盘点：LIVE recipe 39 个切片；13 个 run/group/tool/alert/server-activity/receiver 观察切片不进入 execution envelope。这是刻意保护历史 execution Golden 不因纯观测扩展全部失效的设计，不应简单称为 bug；但观察能力仍需独立 contract/coverage，否则“最需要发告警的 patch 失败”可能没有细粒度诊断。

完整 profile 的字符串 apply 仍会校验其中包含的观察切片。这里的缺口是独立形状证据和报告覆盖，而不是它们被无条件跳过执行校验。

### 3.2 默认 observe 的两个 ok 容易被高估

`ops/host-seam/observe.ts:74–82` 默认只使用两个切片和零值 transformed hash 作诊断；CLI observe 不显式传入整个 reviewed profile。默认返回可出现两个 knife rows `ok`，同时 applyCode 是该占位 profile 的 `transformed-mismatch`。

本次反例：只改变合成 Host 的 output-retry seam，完整配方返回 `find-missing/managed-output-retry-gate`，默认 observe 仍是两个核心行 `ok`。这不是完整加载门失守，而是默认局部诊断无法定位该故障。

**保留例外：** provenance retention 可以加载 durable reviewed/prior recipe，生成更完整的 envelope Golden；本次对应测试已通过。因此不能写成“系统所有来源观察都只检查两处”或“没有完整 Golden”。问题在这些不同证据没有成为同一份清楚表达覆盖范围的持续健康结论。

建议：按安装实际 reviewed profile 的能力集合输出完整的逐能力矩阵；局部未测、未支持、被前置失败阻断、确实不匹配应区分。完整加载失败后可以继续做只读定位，但不可将诊断中部分匹配当成候选可采用。

### 3.3 AST 当前不能直接分析真实整包

本次直接读取 `/home/box/sand-host/host-main.cjs`，对现有 `acornShapeSync`、`structuralShapeSync` 做纯函数调用：

```text
source bytes: 26523565
Acorn:  unavailable / source_too_large / 0 candidates
lexical: unavailable / source_too_large / 0 candidates
```

该字节来源为磁盘 Host `0382fa8`，SHA `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`，不是运行中 loaded 身份证明。

Acorn worker 将源上限设为 8 MiB、固定 Acorn 8.14.1/ECMA2022；严格解析失败不降为 loose 成功。这些限制有合理安全目的，但与真实整包约 26.5 MB 的使用方式不匹配。

建议先做固定 source SHA 的有界模块/函数窗口定位，再在独立 worker 内严格 AST 验证，保存原包偏移与窗口 hash。窗口提取若不唯一/语法闭合不足，就明确 unavailable/ambiguous；不能先 `indexOf` 取第一处再宣称 AST 已证明正确。无需把 AST 放入 preload / inference 热路径，也不要只无限抬高内存预算。

### 3.4 AST binding 不是实际作用域证明

`shape-acorn-worker.ts:103–163` 将所有 modelId 对象变量声明与所有 createSession 第二参数收集为名字集合，按名字相交，没有实际 lexical binding resolver。

本次跨作用域同名变量反例成功复现：未使用函数中的 `options={modelId: unrelated.model}` 被另一函数的 `createSession(..., options)` 识别为一个 agent-id candidate。输出有 `acorn_binding_only` 限制，现有流程也没有由此自动写入 profile，因此**不是已证明的错误注入漏洞**，而是不能把候选定位升级为语义权威。

值得补强的窄语义：同一作用域 declaration-use 绑定、候选唯一性、指定调用与 host/options 的关系、分支位置、finally/异常处理边界；Golden 应来自独立审核，而不是让新候选给自己签字。暂不需要做全程序形式化证明。

### 3.5 Worker 的生命周期证明也应补齐

`shape-acorn.ts:37–112` 已有超时和 kill，但 `finish` 在发出 `SIGKILL` 后立即 resolve，没有在该返回点等待 child close。`host-seam-acorn.test.ts:114–130` 名称含 reaped，实际断言只验证 unavailable/timeout，没有断言退出完成。

不能据此断言现场已经泄漏进程；但把该工具接入常驻观察之前，应补 signal→exit→close 的结构化收尾、输出字节上限、重复超时/退出验证，避免新周期与未结束旧 worker 重叠。正常模型推理与 Host 退出不应依赖 AST worker 成功。

## 4. 旧 watchdog 与真正的现役入口已分离

`process/watchdog.ts:29–147` 的旧 `observeAndHeal` 确实实现过：disk SHA observed → 来源留存与 contract snapshot → attestation invalidated → circuit open → stale patched detected → 受身份约束的 signal/relaunch。

但是在本次生产源码引用追踪中，未发现它被实际入口调用。`roots/controller.runtime.ts:73–97` 的旧 tick/cutover/manual executor 明确拒绝，提示使用 `startControlOperation`；其退休在既有 T28 提交中发生，不是本轮破坏重建新产生的差额。

旧 CLI HEAD 的 `commands/runtime.ts:393–405` 中，`runtime watchdog run` 只做 observation journal maintenance 和只读 reconcile。当前同逻辑位于约310行。`runtime-kernel/internal/commands/controller-operation.ts:138–157` 的 reconcile 读取状态、执行 preflight、返回 receipt，不自动采用、不签新的健康证据，也不由此产生 source-health incident。

`runtime profile watch` 在 HEAD约640行就已经要求 `--once`。`ops/host-seam/watch.ts` 可以在没有 from 时返回一个没有来源观察的单次 receipt；没有目录 watch 或定时扫描。`profile analyze` 在 HEAD约523行就固定 runner:false、port:null。AST与分析机制不能据此推断已有常驻 Agent 自主诊断。

额外核查 guardian 与临时 supervisor：guardian 是采用过程的 exact-identity 解冻保险；临时 supervisor 负责拉起进程；transient adopt 的多次 SHA recheck 限于该操作窗口。它们不是长期 Host 更新监视器。

按需 `io/observe.ts` 仍能区分磁盘 SHA、attestation、新旧进程与 patched-unknown，并给出 stale_attestation/window-open/recovery-required。这是有用的查询能力，不等于周期发现与通知。

**建议不复活旧 observeAndHeal 作为第二个写者。** 在已有长期服务内增加只读来源 producer，实际生命周期动作仍走统一 controller；旧 helper 的缺陷或历史意图不能替代当前授权/目标/恢复证据。

## 5. 最明确的闭环断点：兼容性事件没有变成 incident

`monitor.runtime.ts` 已经具有三条独立有界子任务：归属读取、本地 Host/control journal drain、维护。慢远端不会占住本地日志 intake；取消会结算事务；这些机制与测试都是真实可复用的。

但采样对象主要是 ownership/run-health，日志索引主要是 execution/provider/native tray/continuity。没有周期消费 source/shape/loaded/component 健康。

本次用隔离临时 SQLite 验证四个合法旧事件：

```text
disk_sha_observed
contracts_snapshot (create-session drift)
attestation_invalidated (disk_sha_changed)
circuit_open (unsupported_bundle)
```

结果：**4 条事件通过投影并进入 evidence，0 条 incident 变化，0 个 incident，0 个自动通知工作。** 没有真实 HTTP/用户数据参与。

源码：`io/monitor-store.node.ts:368–426` 会保留有效事件并分别调用几个有限索引器；`runtime-kernel/internal/observation/incident-rules.ts:6–42` 没有 Host 兼容性映射；`io/monitor-incident-intake.node.ts` 是现有 native intake。

因此既不能说“完全没有告警体系”，也不能说“写了 circuit_open 就一定会告警”。若注入消失导致 ownership 读取失败，可能出现通用 observation_unavailable；那是间接症状，不能替代 source/profile/slice 的直接因果信息。

现有 T44 在 **HEAD** 就明确写着 HSO其他来源未闭合，并规划 dirty事件＋周期backstop＋启动/换代同步、来源契约/加载失配进共用incident、跨provenance/SQLite幂等接线。此审计确认了它对应的实现缺口，不应另建 HSO 报警库。

建议：把 source mismatch、必要切片不匹配、运行 loaded/profile 不一致、预期观察器缺席、解析器 unavailable 分成有依据的状态，映射为本机安装范围的 condition incident。只读留存/hash变化不必全部通知；没有相关能力变化的更新留在本地。升级事件先按 installation+generation+profile/capability 聚合，不对每个 Bot 发一份重复报警。持久 receipt 引用+幂等 intake 解决跨库中途退出；不声称原子跨库事务。

## 6. 缺观察器不是空闲，磁盘变化也不是立即终止旧进程的理由

`monitor.runtime.ts` 在从未有过 journal/cursor 时报告 not_observed，而不自动判为执行失败；producerLiveness 也明确 not_checked。这避免把合法尚未启用的功能当故障，但意味着需要一份“本安装预期应该存在什么”的有限 coverage。

一个补丁失败后从未启动的 alert observer，不会制造它自己的 failed 事件。若没有 expected coverage，系统无法区分“没有任务”与“观察器根本没装上”。建议从已选择的能力/profile推导期望，而不是把所有可选切片都强制启用。即使没有监控 Bot，安装级来源健康也应能观察，不依赖 nonempty agentIds 才开始。

状态应独立保留 installed-on-disk 与 actual-loaded（PID/start、实际compile/profile/preload receipt）。磁盘新包到达、旧已验证进程尚未退出时，可能只是安装过渡；只看 disk changed 就杀旧进程会把原本能继续工作的运行代提前切掉。反之，仅凭旧成功证明也不能为新进程背书。

恢复必须来自新代正证据：来源稳定、完整能力合同已验证、实际加载回执和期望吻合、相应观测重新活跃。改了 profile 文件、AST找到候选、HTTP200、用户ack或进程存在都不能自动resolve该condition。

## 7. 通知路径有同故障域风险，不应靠放宽安全门补救

旧 daemon 已持有自动通知 worker，现有 durable permission、outbox、预算、未知不重发、授权后新工作限制是有用机制。第二批测试实际验证自动worker处理新工作、取消HTTP、并发单次、未知恢复不重POST等。

然而 `ops-explicit-delivery.runtime.ts:49–87` 要求接收 Bot：native generation与绑定一致、所有权合格、routine一致、model可观察、Host capabilities ready、loaded profile/source一致，自动qualification也必须匹配。该检查在 HEAD 已存在；不是重建新加的门。

本次现有自动通知测试明确通过 model drift / generation drift / source drift / ownership drift 会阻止未来投递。它们正确防止自动改目标/改模型/重授权，但也意味着：**当待告警的问题就是本机补丁失效，同机接收Bot的资格可能同时失败，告警因此被拦。** 这项是由源码与隔离测试支持的条件性风险，不是已经测试了真实升级期间漏报。

建议把本地机器可读condition和通知阻断原因作为无模型、无被监控patch依赖的最低出口；需要人可见远端兜底时，使用事先独立授权的带外通道。不能临时改成另一个Bot、绕过ownership、自动变更modelRevision或重绑credential来“确保能发”。独立通道不是另一个诊断/运维权威，只运送有限安全摘要。观察者/投递者本身的心跳与盲区也应可见。

## 8. 值得升级的最小方向

这些是建议，不是本轮已实施，也不是新增Spec或部署许可。

### 先把现有部件接通

在旧长期服务内复用monitor的Scope，增加本地安装级来源producer。启动、文件变化和周期backstop只产生dirty/复测工作；单代去重、有界采样、未知/过渡分开。采样不执行模型、不发更新RPC、不打断Host。读取、精确字节预检、retention及AST工作不能阻塞原生日志drain。

将加载负回执和来源/能力健康receipt接入现有OBS incident/outbox，补缺少journal时的expected coverage。这是本轮最高价值的P0闭环，不依赖先做高级AST或LLM自动修复。

### 再提升形状分析的覆盖与诊断质量

完整配方逐能力诊断，保留2刀口/4旧窗的历史意义但不让它们代表全部健康；execution与observation能力各自维护合适Golden。解决真实source尺寸、scope绑定和worker退出证据。新的结构分析负责缩小变更范围，不自行授予新SHA运行资格。

### 自治以已证权限为上限

可自动化：采集、留存、差异定位、去重incident、预算内通知、输出下一步证据包；可选event-driven Agent做一次诊断/候选补丁与隔离回归，结果标candidate-only。

不要把analyze→reviewed write→live adopt合成无边界操作。先解决无runner的现实，诊断按source/recipe/contract revision去重，故障摘要不含凭据/原始私人代码。涉及当前Host重启/采用/回滚只走统一controller，使用当前明确的策略权限、实际目标身份和已知恢复路径；未知effects不自动重放。不能从旧授权或过去receipt推导这次升级的新采用权限。

正常更新且相关合同/能力无变化时应零模型、零Bot唤醒、零Host mutation。必要失败优先进入incident，不以“是否能安全自修”决定要不要告警。

## 9. 建议的端到端反例验收

| 场景 | 应证明的结果 |
| --- | --- |
| 核心两刀口仍在，retry/alert/context之一改变 | 精确加载拒绝；能力矩阵定位；不能全局healthy |
| 整包太大、语法变化、AST worker超时 | 分析unavailable明确呈现；必要时incident；没有假green、未结算子进程或自动加预算死循环 |
| 补丁在observer启动前被拒绝 | 外层负回执/期望缺席可被发现，不依赖失败observer自报 |
| ownership正常且旧journal安静，但profile不再适用 | 安装级兼容incident仍可产生 |
| 新包在磁盘，旧已验证Host仍运行 | 分清transition与loaded；不盲目终止，不让旧receipt证明新代 |
| provenance留存后、SQLite入库前退出 | 稳定receipt可幂等补入，一次condition，不重复Bot唤醒 |
| 通知接收Host资格也失效 | outbox保留blocked/unknown，带外或本地应急出口可见，不自动换目标/降安全门 |
| 观察者重启、旧失败重播、用户ack | 不把旧代当当前、不重复effects；ack不等于恢复 |
| 新来源/profile真正重新加载并验明 | 同一condition由新鲜正证据收束；随后再次失败是新一轮事件 |

现有责任入口继续使用T44/OBS共享intake、T41 monitor、T45投递及既有profile/controller；常驻安装与现场资格另按现有LIVE入口。无需创建新的报警数据库或总Spec。

## 10. 本次验证与产物

新增忽略目录中的审计反例：`.scratch/upstream-patch-health-audit.test.ts`，仅四个已观察行为的characterization，不是把缺口当成正确产品验收。内容是合成source与临时SQLite，不依赖私人Host dump。第一轮最后一个断言因审计fixture把通知时间下界设为0而拒绝；改为合法正时间后复跑全组通过。该fixture错误不计为产品缺陷。

第一组：审计4项，加Acorn、envelope drift、replay、retired watchdog、monitor scheduling/source lifecycle既有测试，**33 pass / 0 fail / 244 expects / 8 files**。

第二组：controller、generation、preload marker、reviewed profile lineage、automatic notification，**56 pass / 0 fail / 249 expects / 5 files**。

合计 **89项，0失败**，其中85项既有测试、4项审计反例；通过说明这些有限行为已复现，不证明Host升级告警链已经打通。整包AST/lexical单独测量均为source_too_large。

本轮只新增该固定报告、reports导航和ignored审计测试；没有业务实现改动。没有全仓build/typecheck、没有运行中安装/Host/Gateway/服务E2E或真实通知投递验证。dirty工作树后续变更需按实际路径复验。
