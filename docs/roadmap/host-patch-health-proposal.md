# Host 补丁健康识别与监控告警闭环：新架构方案

状态：**2026-09-20 架构方案。已讨论确认 Rust/Oxc 静态验证内核、Node 管理的按任务子进程、stdio JSON-RPC 与只读快照 FD 输入；包/目录边界已讨论认可，见第15节；施工入口与插入建议见 [HOST-01](../tickets/HOST-01-patch-health-verifier.md)。尚未创建 Rust 工程或实现这些增量，不是现场采用资格。**

本方案沿已接受的[重建骨架](agent-first-cli/implementation-impact.md)组织责任：管理 Server 持有领域与后台资源，modeld 独立，Host/preload 轻量，唯一 controller 拥有 Host 生命周期操作。复用旧代码中成立的合同与能力，不为重建复制新的 publisher、原生 writer、报警库或并行 daemon。具体命令名、表结构、文件拆分留给实施；本文固定识别语义、责任、关键机制与验收。

既有长期合同仍在 [Host compatibility](../runtime/host-compatibility.md)、[operations](../runtime/operations.md)、[architecture](../architecture.md)。已接受差额继续归 HSO/HCR、T44、T41/OBS、T45 与 CLI-05；本方案不覆盖这些文档的当前合同。新增带外出口或主动 canary 属于本文明确提出的产品扩展，不因写入本页而自动启用。

## 1. 目标与核心结论

目标不只是“Host 升级后提醒一下”，而是可靠回答：

1. 当前选定的补丁能力依赖哪些来源、切片、运行对象和原生协议？
2. 新来源是否仍满足这些前提，现有配方能否精确应用，候选变换是否符合明确行为？
3. 当前真正运行的 Host/worker 是否加载了这份实现，注册对象是否存在，发生业务时是否确实执行了预期路径？
4. 哪些能力现在可用，哪些失效，哪些只是未观察；这个结论自身是否新鲜、完整、有可靠来源？
5. 有影响的变化是否进入持久 incident，通知是否送达，恢复是否经过正证据确认？

**以能力为单位、以证据层次为边界。精确字节负责“不乱打”；AST/绑定/有限控制流负责“没有打错地方”；行为反例负责“判定器不是自证”；加载/实际调用证据负责“现在真的生效”；持续观察与带外出口负责“不会安静地失效”。**

不提供一个百分制“健康分数”。关键错误不能被大量无关通过项平均掉。系统对声明支持的范围建立强检测，对未覆盖动态行为保留明确未知，不承诺数学上证明任意 JavaScript 的全部语义。

## 2. 本次核验基线与对上一轮判断的推进

工作树 HEAD `a3e9131`，包含持续并行重建；本次重新读了 `packages/server/src/server.ts`、`installed.ts`、重建骨架、Host compatibility、HCR实际加载合同和关键旧切片。Server 源码已经组合 monitor/notification 等 worker；这证明组合入口存在，不证明现场服务已运行。

旧缺口与已验证边界来自[健康链审计](../reports/2026-09-20-host-patch-health-chain-audit.md)及[版本影响报告](../reports/2026-09-20-grok-bot-upstream-impact.md)。本次重跑审计反例、HCR capabilities、preload marker、envelope drift，26 pass / 0 fail / 176 expects / 4 files；没有实际 Gateway、模型或用户数据读取。

### 新的只读技术验证：整包严格 AST 可行，旧 8 MiB 是工具预算限制

在 `packages/box-runtime` 依赖上下文中，用 Node 22.22.0、已安装 Acorn 8.14.1、ECMA2022/script 对实际磁盘 Host **只做 parse，没有执行 Host**：

| 项 | 一次样本观察 |
| --- | --- |
| 来源 | `/home/box/sand-host/host-main.cjs`；SHA `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548` |
| 字节 | 26,523,565 |
| 结果 | 严格解析成功；21,248 个顶层语句 |
| parse 耗时 | 1,709 ms |
| parse 后 heapUsed / RSS | 411 / 494 MiB |
| 进程最大 RSS | 531,600 KiB，约 519 MiB |
| V8 heap 参数 | `--max-old-space-size=512`；这不是 OS 级总 RSS 限制 |

首次在仓库根尝试因 Node 无法解析该 workspace 的 Acorn 依赖而失败；改到实际依赖所在 package 后成功。没有改依赖、源代码、解析器上限或生产配置。

这不是完整分析成本：未执行 scope/CFG/变换后比较，单次 parse 不是性能 SLA。它足以支持一个更稳的选型：**每个新来源在隔离 worker 中整包严格解析一次，随后按能力只保存必要结构证据。** 局部窗口是增量与诊断优化，不是丢掉全局上下文后仍宣称完整语义的捷径。

## 3. 健康对象：Capability × 来源 × 运行代，而不是一个 Host 布尔值

### 3.1 四个身份分别记录

- 安装与意图：installationId、启用的能力集合及 policy/config revision；不从 profile 恰好省略某项推导该能力不再需要。
- 静态制品集合：Host entry、相关 worker/companion、preload/handler build、reviewed profile、contract/checker revision，以及该能力需要的 loader/ABI/wire。
- 加载运行代：boot/session 身份、PID+start、实际编译来源与输出、加载 profile/preload、worker 各自 generation、Gateway 对应进程。
- 业务执行：已有 TURN/STEP/operation/request 标识、固定选择版本、该次运行的能力证据。新配置不得改写旧运行的归属。

每项摘要必须标记 scope、observedAt、evidence refs、coverage 和 freshness。版本号、磁盘 hash、archive hash、实际加载身份不混用；同 SHA 重启、A→B→A 也产生新的运行/安装事件，旧使用证明不能直接继承。

### 3.2 每个能力保留分层结果

| 维度 | 例子 |
| --- | --- |
| desired | required / optional / disabled |
| source | stable / transition / mixed / unavailable |
| applicability | exact-match / mismatch / unknown-source / not-checked |
| qualification | qualified / unreviewed / contradicted / unsupported-analysis |
| loaded | matching / different-generation / missing / unknown |
| attachment | expected-handles-present / partial / absent / not-checked |
| exercised | observed-pass / observed-fail / not-exercised / evidence-gap |
| sensing | fresh / stale / unavailable / conflicting |

用户级摘要可收敛为 ready、degraded、blocked、unknown、not-applicable，但原始维度保留。`ready + not-exercised` 只能说加载与准入前提满足，不能说真实往返已证明；观察到成功也只覆盖那次、那个分支。无触发机会的异常分支，不因计数为0而判坏。

全局摘要显示受影响能力、根因与范围。需要先确认依赖闭包：某个 observer 降级不自动停掉所有模型调用；关键 identity/owner/commit contract 失效则阻断依赖它的我方操作。

### 3.3 不把监控结论变成第二个执行准入权威

健康领域负责观测、分类、解释；controller/原有执行准入用同一纯合同核验当前直接事实。不能让下一次合法 STEP 必须同步访问管理 Server 或查询 monitor SQLite。静态资格可以作为绑定不可变输入的受控制品；旧 UI 的绿色快照不是权限。

管理 Server 停止不主动终止已开始的合法 modeld 执行；若后续准入确实缺乏必要身份/安全证据，按原有 owner 拒绝，而非依赖“监控服务是否在线”这个替代条件。

## 4. 先建一份有限的能力/补丁合同目录

复用现有 SlicePatch 与能力依赖，不维护另一份手抄枚举。TypeScript 能力目录定义 required checks、依赖、影响与健康组合；Rust/Oxc 实现代码语义谓词与检查注册表。前者要求什么、后者实现什么是不同职责，通过稳定 check ID/revision 和构建合同验证连接，不在两边重复写判断算法。跨语言消息用有限 schema 表达；不另造规则 DSL、通用分析插件或规则引擎。

每个能力的定义包含：语义目的、必要切片/相关artifact与ABI、预期role、结构/行为断言、运行见证、触发机会、失败影响、证据来源。每个选入profile的slice必须有归属；每个被宣称启用的能力必须有完整依赖。handler清单、支持声明与相应测试路由可从同一个目录派生；**行为Oracle和Golden的正确性不能由matcher自动生成**。

| 能力族 | 重点覆盖 | 关键行为义务 |
| --- | --- | --- |
| managed session / identity | create-session、main options、TURN/STEP关联 | 正确主链与Host绑定，不误认辅助会话，原生/managed选择不串线 |
| retry / failure boundary | provider、turn、output、summary retry gates | managed失败不落进未声明原生重试或备用路线；取消不重复执行 |
| context maintenance | compact注册、前后台summary、manual、idle相关依赖 | 正确生命周期、唯一原生写者、取消与checkpoint结算，不制造业务成功 |
| native continuity | Host/current-state与worker协议、birth/startup/fences | 已准备目标、明确root边界、未知不重放、非伪用户输入启动 |
| ownership / native control | schema、实际handler/wrapper、native reader、Gateway归属 | 来源与运行身份一致，读能力不自行授予写/执行权限 |
| runtime observation | run/tool/group/alert/suppression/server activity | 该看的入口被捕获，观察不改变原生动作，缺席和健康有区别 |
| 原生依赖协议 | 被CLI/服务实际消费的RPC与必要数据形状 | 方法存在之外，还核验decoder/handler/使用侧合同；缺能力不能当空数据 |

最后一族不是“补丁文件”的一部分，但像旧Memory RPC移除会改变能力，应作为host-compatible capability的依赖，不误归为所有patch失效。

观测切片可以继续独立于execution Golden演进，但必须有自己的合同，不能因为不进入旧19窗就无证据。旧两个刀口、四窗保留历史定位用途，不继续承担完整健康宣称。

## 5. 七层健康识别机制

### L0：可信来源与安装一致性

入口只读已授权的安装路径与有限dependency set；不是全盘扫node_modules，也不从用户提供的路径创建替代目录。entry、critical worker、preload、profile/contract变化都能触发复测，不能只盯host-main。

对每个文件固定fd，核对类型、size上限、dev/inode、mtime/ctime、读前读后与pathname重新解析，读取期间变化归source_changed。按多文件集合再核对一次，形成完整artifact set；混代集合可以留作transition观察，但不晋升stable/可采用。两次稳定观测也不是官方supervisor锁，实际编译仍对自己的字节作最终检查。

模块标记、source map、版本文件、服务状态只辅助定位，不替代实际字节。无相关变化不反复parse；周期仍需真正hash复核，不能只信stat永远不变。

### L1：精确字节与完整有序配方

复用实际 `applyPatchProfile`，不另写“差不多一样”的检查器。源SHA、起止唯一、窗内find唯一、pass次序、变换SHA都保留。记录每片的原来源范围与当前pass范围，并验证UTF-16/UTF-8映射。

加载路径仍严格失败即不注入。诊断路径可在第一失败后继续收集其他能力，但必须区分：实际执行pass的证据、原始source上的局部测量、因前置变换失败而无法验证。禁止把跳过失败片的中间结果发布为完整profile。

已打过补丁的输入、重复插入、同名局部变量冲突、重叠窗口和互相改变锚点的切片都属于反例覆盖。任何new SHA仍需新的精确qualification，不用相似度兜底执行。

### L2：严格 AST 与真正的绑定/控制流

主流程：固定source → 独立 Rust/Oxc worker 整包严格解析与语义诊断 → 顶层/词法作用域索引 → 能力所在role与依赖闭包 → 有限控制流断言 → 有界报告。Oxc 为已选生产静态内核；具体 crate/toolchain 版本待资格切片锁定，不在运行时追随 latest。必须检查 parser/semantic diagnostics 与实际分析覆盖，存在 AST 不等于合法。Acorn 仅保留为隔离测试中的独立参考，不在 Oxc 失败时充当自动生产回退；不再按名字Set拼接绑定。

必须明确检查：

- Identifier use解析到哪个declaration，而不只看名字；shadowing、TDZ、闭包、destructure、reassignment各自有规则。
- `this`/Host/options/回调来自同一条预期关系，目标确实被主链注册/调用，不是死代码、后台lookalike或字符串/注释。
- 同步/async/generator、返回形状、await、throw、finally、abort/dispose位置是否符合所支持变体。
- object spread、getter、computed property、重复字段与后续覆盖会否重写agentId/nonce；字段插入的求值顺序是否改变原生行为。
- 管理错误门是否先于应当被阻断的retry；compact lease是否覆盖provider调用且释放后不再写入；startup与resume/idle分支不混。
- RPC名字、参数decoder、实际handler和消费者之间有没有断开；能力声明不能由只存在函数名来证明。

对关键位置建立小范围CFG/def-use分析，用清楚的支配/后支配性质验证“每次进入X之前必经Y、退出后不得再Z”。碰到不支持的动态别名/运行时改写，返回unsupported/unknown，而不是构造一个未经证明的通用分析器。

内容原始hash和归一化结构fingerprint同时保留。可以在已解析绑定前提下识别局部改名、无关位置偏移；不能抹去属性键、literal、运算符、求值顺序、directive、async/await、异常边界、ASIs或tagged-template raw内容。fingerprint相同仅支持“这个窄结构相同”的诊断，不自动准入。

全包AST避免截取窗口后丢掉scope。增量窗口仅在能证明完整scope/依赖映射时沿用；否则回全包或明确partial。纯tokenizer用于候选/线索，不作为JavaScript语法证明。

### L3：变换后约束与行为资格

原代码的结构匹配，不代表替换代码正确。对有序变换后的结果再做strict parse、绑定/CFG和前后差异检查。仅允许各slice明确声明的变更；未触及的区域保持字节一致，新增变量不捕获/覆盖原有绑定，原生handler调用次数与参数顺序符合合同。不可仅因能compile就判健康。

行为用例使用生产转换与真正的adapter/纯程序，外部效果由独立fixture控制。至少验证：native passthrough精确一次；managed/no assignment/明确fallback策略；失败/取消/超时；native constructor前提；compact与idle竞争；checkpoint未知；observer失败不得改变业务结果。

本轮重读 `live-slices.ts:25–36` 发现现有session替换先构造native session再调用hook；`docs/runtime/host-compatibility.md`也将早期guard与该顺序的冲突保留为未解决项。因此第一批合同不能把这段旧实现直接当正确Oracle。应验证“managed路径是否必须不受native构造前提影响”的既有产品要求，再决定是否改为lazy原生构造或承认该前置条件；检测器不能替产品语义作假证明。

日常静态分析不require/import/eval任何保留的私人Host。公开回归使用独立编写的来源fixture；真实原生行为资格须在明确授权的可丢弃原生运行环境中验证，和provenance来源分析区分。node:vm不是安全沙箱。

### L4：加载证明与实际挂接

复用正向compile marker、PID/start、HCR wrapper+reader能力见证；扩展为完整load attempt与per-capability attachment，而不是另起一个自报healthy API。

建议阶段：attempt_started → target_seen → transform_passed/rejected → native_compile_completed/failed → handlers_attached → readiness_observed。`onTransforming`是构造期间的bootstrap见证，不得提前叫ready；最终ready需要compile及必要对象挂接都成立。异步安装、worker或Gateway晚到保持阶段差额。

补失败回执的有限字段：attempt/source/profile/preload/process身份、stage、code、slice、有限异常类别；不输出raw exception/source/credential。真正_sourceSha来自实际传给目标compile的bytes，不在compile结束后重新hash可变路径冒充已加载。preload/handler build也要绑定实际运行制品/不可变启动路径，避免只读磁盘文件伪装已执行字节。

失败回执即使无法写持久日志，也不能改变原生业务结果；外部producer通过attempt期望/进程状态/缺失阶段发现gap。显式失败、没有启动、启动了但没遇到目标、日志丢失必须区分。

thin witness应绑定实际注册的handler/callback实例、角色与协议版本。profile声明某slice存在，不能自行制造attached=true。只读metadata challenge通过原生wrapper调用对应reader，可带request nonce/单调序列区分缓存；不访问Server roster、不调用模型、不启动业务。随机challenge不是抗恶意同UID篡改的密码学attestation。

Host消失、PID重用、Gateway指向另一Host、worker换代、module重新加载、handler替换都失效相应运行证明。静态字节资格可重用，运行代证明不可沿用。

### L5：实际触发与生效证明

只注册handler仍可能命中上游不再调用的旧函数。为关键边界增加极轻量的“入口/结果/结算”见证，与既有TURN/STEP/journal关联，不在热路径逐token写日志。

例：managed TURN admitted → route入口选择managed → modeld接受对应STEP → Host消费归一化终态。compact requested → 原生摘要开始 → checkpoint owner结算；“生成了摘要”不能当成“写入状态已完成”。tool开始之后finish/error/cancel之一应闭合；observer自己的失败与业务失败分开。

预期机会来自不同位置的已有事实：已接受TURN/明确compact operation/原生run状态等，而不是让待验证hook自己既宣布expected又宣布observed。相同Host运行代、对应ID、读取窗口、合理期限与有界丢失检查共同决定是否path_bypassed/contract_violated，避免用两个不一致采样计数直接判坏。

如果触发机会本身也没有独立来源，只能报告not-observed；不能声称已经证明该路径没被绕过。多个探针有共同失效风险，报告coverage限制。总计数、函数名、低延迟heartbeat、providerHTTP200都不能独立证明正确模型/正确Bot/正确writer。

无业务时报告ready/not-exercised；不会为凑绿自动调用模型。单独的显式资格canary可覆盖首轮、工具、取消、compact、restart，但必须独立授权/固定测试目标/费用预算，不把业务Bot当探针。

### L6：检测系统自身的健康与证据有效性

把来源读取、parser、scope/CFG、worker、队列、provenance、journal、intake、notification出口的不可用作为显式coverage，不吞成无变化。历史证据绑定source+profile+contract+checker/parser+runtime build；版本变化使相应分析cache失效。不可变artifact的有效静态资格不因一次临时parser宕机自动变假；但新来源无有效证明时保持unknown/unqualified。

wrapper注册、module编译、进程存活、采样器心跳、source刷新、业务成功是不同事实。单调时间用于本进程期限，wall clock用于展示；跨boot/恢复不沿用旧单调时钟。旧cache、迟到A报告、重复seq、restore旧数据库不能让B代恢复为绿色。

## 6. 组合判定与影响策略

原则：**肯定失败不被其他通过冲掉；缺必要证据不被沉默补成成功；不相关组件失效不自动扩大影响。**

| 情况 | 健康判定 | 行为建议 |
| --- | --- | --- |
| 磁盘新B，实际运行旧A且A证明仍有效 | A当前可用；B未资格/安装过渡 | 保留A观测，启动B诊断；阻止未资格采用B，不仅因磁盘更新杀A |
| 新来源精确不匹配，但AST只是局部变量改名 | 当前配方不适用；候选语义可能相容 | 给出小范围改名证据，重新生成/审查精确profile；不自动跳过SHA |
| 同位置结构相似但branch/异常/写者改变 | 能力contradicted/unqualified | 对依赖能力阻断采用，附具体不变量与反例 |
| compile拒绝、当前managed意图未实现 | loaded不满足；存在route偏离风险 | 我方可控入口不宣布managed成功；记录原生继续运行的范围 |
| 仅某观测能力失效 | 观测degraded，核心执行另判 | 停依赖该证据的自治动作，不自动停止全部普通推理 |
| parser unavailable，无新来源资格 | qualification unknown | 告警分析盲区，不自动扩大预算无限重跑 |
| 接收Bot资格随Host变化失效 | incident仍open；delivery blocked | 已授权独立出口或本地故障面；不自行换目标/模型/权限 |
| 用户关闭某功能 | intent不再要求 | 标not-applicable/intent-withdrawn，不能声称原故障修好 |
| 上游模型503，来源/加载合同正常 | provider failure，patch health不因此变坏 | 交既有执行故障分类，不发误导性的补丁失效结论 |

尤其要诚实：补丁不适用时原生代码仍可运行；补丁已完全消失时，grokbox无法凭不存在的hook保证拦住原生App所有消息。安全门管住本系统实际控制的入口和依赖能力；若已有显式fallback策略，记录实际fallback及版本，不能隐式装作managed仍生效。

## 7. 新架构下的责任与数据流

```text
已授权安装来源 / 实际Host-worker / 编译回执 / 业务见证
          ↓
Box Host-health adapters + 单个隔离分析worker
          ↓
纯能力合同判断 / 有界健康快照与固定证据回执
          ↓
管理Server内 Host-health producer
          ↓
现有 OBS intake → SQLite incident / outbox
          ↓                         ↓
CLI/Web共享读面           已授权通知 / 独立兜底

需要改变Host → 显式控制用例 → 唯一controller → 新代加载/使用证据
```

Host/preload只包含同步必要的精确apply和小型见证，不导入Effect/parser/SQLite/SDK。AST、源码扫描、差异、LLM全部在冷路径。modeld只贡献自己真正拥有的STEP/选择/终态证据，不变成Host安装controller。

建议落点（路径为方案骨架，不表示文件已存在）：

| 责任 | 复用与最小增量 |
| --- | --- |
| 浏览器安全合同、组合规则 | runtime-kernel现有contract/observation旁增加host-health纯表面；能力意图与状态组合一处定义 |
| 形状、scope/CFG、变换后语义 | 新增 `crates/host-verifier/` 的 Rust/Oxc 内核；只产生静态证据，不拥有最终健康、发布或采用 |
| 精确配方、Golden、来源留存与回放编排 | 复用box-runtime `internal/ops/host-seam/`、既有apply及provenance/publisher；消费Rust结果，不维护第二语义引擎 |
| 实际加载与触发见证 | 现有preload、compile-hook、HCR capabilities、run/alert observer；添加薄有限健康出口 |
| 持续采样与冷分析资源 | box-runtime `internal/roots/host-health.runtime.ts`类似领域root，由Server生命周期组合 |
| 事实留存和故障物化 | 原provenance存不可变私有receipt；现有monitor DB存当前投影/incident/outbox，不新建报警DB |
| CLI/Web读与显式复测 | shared client → Server用例；页面不跑CLI/解析源码、不为每个标签页启动watcher |
| Host变化与恢复 | 原publisher + 唯一controller，健康领域只提供有界证据与建议 |

诊断查询返回最新真实观测及年龄，不隐式修复、建库、写profile。显式复测可返回operation与最终结果，仍不等于采用。管理Server宕机时，离线doctor复用同一纯判定/本地只读来源，不能偷偷启动另一个后台或writer。

## 8. 持续监控：快采样、慢分析，不能让重解析拖垮服务

三类触发并行成立：启动/恢复与运行换代强制resync；目录变化标脏；有界周期hash/来源与load事实复核作为backstop。file watcher不能作为事实来源，也不能只绑定一个永远不会重开的inode。

每安装最多一个同类重分析，按artifact+contract/checker key single-flight；快速变化只保留最新待测代，旧完成结果记为superseded历史，不能覆盖当前。check schema/worker出错有有界退避，不重复向Bot唤醒。当前代与使用中回执优先保留，队列/输出/磁盘压力可观察。

初始调参建议：dirty合并约1–2秒，轻量resync约30秒，完全hash复核约数分钟；加载失败事件立即入队。它们是候选配置，不是已验SLA。空闲常态零模型/零Bot唤醒/零Host mutation；同源分析走有效cache。冷检查单次完成期限需包含读取、parse、scope/CFG、变换后验证及报告，不用只计parse时间掩盖排队。

本轮约519MiB峰值说明要用独立进程的有限OS资源边界，而不是在API事件循环parse。V8 heap上限不等于总RSS；scope和前后两份AST会额外占用，优先顺序投影/释放，不长期保存完整AST。parser不可用与worker资源失败明确报告。禁止继承NODE_OPTIONS/loader hooks/不必要凭据；不使用shell，不运行源中的代码。

超时：中止→终止所属worker→确认exit/close→释放slot；未确认退出则slot隔离并报告cleanup gap，不发起无限新worker。输出上限、子进程树、关闭竞态、管道错误都要测。某分析失败不得带倒整个管理API；真实无法收束的资源问题可使该producer失败并由服务owner明确呈现。

本机Host-health无需非空Bot列表或Server roster成功才采样。native read、journal drain、Hash/AST、维护分别有资源边界，沿用旧monitor的调度隔离，不让上游慢请求阻塞本地负回执。

## 9. 故障到告警：一次根故障，多个受影响能力

新增的健康receipt必须进入现有journal/OBS版本化投影与classifier，不能只落到evidence表。第一次集成反例就使用上一轮4个升级事件：它们必须生成正确的安装级condition，而非0 incident。

建议故障族：source不适用/混代、contract违反、load缺失或错代、预期挂接/调用缺席、观察链盲区。根incident以installation+变更episode+有限cause族聚合；capability/bot列为影响，不每slice或每30秒新开一个incident。新的policy/checker解释不能篡改旧证据。

provenance receipt先完整发布，再由OBS幂等索引；进程在两步之间退出，启动backstop补入。SQLite内snapshot/incident/outbox变更保持同事务语义；不声称跨文件与SQLite原子提交。capacity/gap要进入健康面，不允许为了告警删掉受保护的当前资格或无限写日志。

通知摘要应回答：实际运行什么、磁盘候选什么、哪些能力不满足、用户影响是已观察还是潜在、自动做了什么/没做什么、复核入口是什么。不得携带私人Host片段、用户正文、token或raw exception。

incident的open/ack/snooze/resolved、通知的pending/accepted/unknown/blocked、人读到没有分别保留。恢复需要同一能力当前代的正证据达到要求；关键加载故障恢复不强迫触发所有罕见业务分支，但必须说明哪些仍未exercised。曾观察到业务不变量失败则需要对应回归/新证据，不凭heartbeat自动消失。

## 10. 同故障域与兜底：不是扩建通知平台

现有接收Bot通知依赖Host/profile/model/ownership资格，不能为了报告这些资格失效而放宽这些安全门。

本方案建议把**一个独立、事先授权、无LLM/无本Host patch依赖的安全摘要出口**提升为“升级故障可达”资格的必要部分；这是对既有多渠道候选的一项小范围提升建议，而非默认开通所有渠道。现有Bot通知继续走原outbox/授权；带外收件目标、可发送信息、预算、未知结果不重发仍明确治理，不允许临时换接收者或自动重绑。

本地最低出口是独立于monitor SQLite的有限emergency status/服务stderr/journal，标记intake或投递失败，不成为第二业务数据库。相同磁盘满/整机断网会同时破坏本地出口，不能承诺它一定送出。整机或管理Server死亡需要机器外的dead-man：它只判断最近heartbeat的状态/采样年龄，不把进程心跳当Host健康，也不拥有Host重启/模型/恢复权。

尚未配置带外出口时，产品仍可提供本地监控，但必须显示delivery coverage local-only / not-independent；不宣称Host故障必达。检测器失联的异常在可用独立渠道报告，避免“告警发送失败→继续用同一失败渠道告警自己”的递归风暴。

## 11. 自治边界与证据包

自动完成：采样、留存、完整机械检查、生成/更新incident、预算内既有通知、恢复复核。未知新来源可按source+recipe+contract/checker key触发一次Agent诊断，默认输出candidate，不定期消耗LLM扫描整包。

诊断输入为有限证据包：准确artifact identity、违反的不变量、source/AST范围引用、前后差异摘要、最小反例、受影响能力和未证范围；私有代码不自动上传外部。LLM不能写green、修改Golden来自证、扩大parser预算无界重跑，或绕过publisher。

可以进一步授权维护Agent提交候选修复及隔离验证；真正profile发布、Host采用/回滚仍走原有审查和controller。权限可以明确委托，不必全部永远依赖人工，但不能从旧聊天、旧receipt或“模型认为很安全”推导本次采用权限。恢复旧Host还必须考虑相关worker/ABI、当前活跃TURN和原生writer，不把retain当执行介质。

## 12. 重点验收：证明检测器会抓错，而非只证明Happy Path

### 12.1 两套变体要同时存在

安全等价的受支持变体：Unicode/CRLF、无关位置移动、已解析绑定的局部改名、允许的打包符号变化。必须仍定位正确role，同时新source精确资格仍需重建。

语义破坏变体：shadowing/TDZ、options在另一scope、字段后写覆盖、spreads/getter、调用目标改变、同步变async、错误门移到retry之后、条件反转、finally/dispose删除、worker接口改变、observer未注册、已注册但入口绕过、缺少负回执。

**不能让所有破坏测试仅靠unknown-sha通过。** 在隔离测试中为变体重新固定输入hash，单独运行结构/行为判定，验证后层确实抓住语义问题。发布/执行资格依然禁止给真实新source自动改hash；这只是检测器反例测试的方法。

Oracle独立审核；新checker不自动重写Golden。对明示支持的关键反例集合要求零漏过，同时列出unsupported/no-coverage；不拿一个总体mutation百分比分数代替关键义务。

### 12.2 跨链验收矩阵

| 场景 | 必须看到 |
| --- | --- |
| 两核心刀口绿，其他必要切片坏 | 能力失败+精确原因；不能全局健康 |
| 同名不同scope、死代码lookalike、属性覆盖 | AST/role/binding明确拒绝或unknown，无错误候选准入 |
| 原生factory先抛错、managed条件满足 | 验证声明的前提与顺序；不让旧行为给自己签字 |
| 新idle分支绕开旧summary入口 | 静态依赖/控制流变化可见；有触发机会时缺使用见证可见 |
| Host entry不变但worker/preload变 | 对应能力qualification/load失效，不全局继承旧SHA |
| 源同size同mtime变化、rename、软链接交换、读中churn | hash/identity/backstop能发现；混合快照不晋升稳定 |
| profile说有observer但加载未注册，或注册后无入口 | attachment与exercise分开，外层期望发现缺席 |
| target未被compile、source拒绝、syntax/初始化抛错 | 每种负阶段可区分，不伪造成功marker |
| 源更新A→B→A、PID复用、旧结果迟到、旧DB恢复 | 运行代/episode正确，旧证据不恢复当前健康 |
| AST大源、语法不支持、CPU/内存/输出超限 | 检测器unavailable，不green；资源有界且真实退出 |
| parser崩、远端RPC慢、无Bot目标、monitor DB忙/满 | 本地来源/负证据持续可观测或明确blind，不阻塞推理热路径 |
| retain后intake前强杀、重复事件、乱序seq | 幂等补入正确incident，保留gap，不重复通知 |
| 接收Host也失效，或Server/整机停止 | 已授权独立出口或明确local-only/失联coverage |
| 用户ack、intent关闭、真正重新加载修复 | 三种状态不同；只有相应新代正证据证明恢复 |
| 一次源无关变化/长时间无变化 | 不误报相关能力，不调用模型、不唤醒Bot、不发Host mutation |

既有53/89等测试数字只是各固定报告的回执；新集成必须有自己的生产入口验收，不把旧mock报告直接升级为新架构可用证明。

## 13. 实施顺序与收口标准

第一块：完整能力目录、来源集合与新旧指纹身份；把现有apply/Golden/replay变为同一诊断输出，并补失败回执。先用一个source不匹配垂直切片接到现有incident，避免又造一堆不被调用的检测器。

第二块（识别质量重点，不能以第一块可告警为理由删减）：整包strict AST、scope/有限CFG、变换后约束、独立Golden与正负变体；execution/observation各有完整合同；实际大包和资源退出验证。

第三块：实际加载、对象挂接与关键使用见证；扩展现有HCR元数据读面；运行代、机会与freshness规则进统一健康组合。静态资格、ready/not-exercised、实际业务证明均可见。

第四块：Server常驻producer、dirty/backstop、跨provenance/SQLite恢复、聚合incident、原outbox与独立兜底、observer自身失联、最终CLI/Web/离线doctor共用读面；冻结制品后做有限真实升级/换代与故障窗口。

上述是同一终局的工作包，不是逐包上线要求。可以并行建设source/静态与runtime witness，接口先对齐。破坏重建期间不维护双daemon和过渡双writer；最终切换时停止旧采样/通知owner，由新Server接管。旧历史证据保留其来源与版本，不伪造迁移后的当前健康。

交付门：所宣称启用能力没有未标明缺口；关键破坏反例不能漏过；每类必要健康故障经生产intake形成incident；至少明确证明一个不依赖本Host patch的出口或诚实local-only；恢复和unknown不混；source分析与读取不产生Host mutation/模型费用；管理API、原生推理与modeld寿命没有被新观测域绑死。

## 14. 来源定位

本方案的仓库事实依据：

- `packages/server/src/server.ts` / `installed.ts`：新Server组合与安装入口；`docs/roadmap/agent-first-cli/implementation-impact.md`：边界与一次性重建约定。
- `packages/box-runtime/src/internal/host/profile.ts`、`live-slices.ts:25–36`、`compile-hook.ts`、`preload.ts`：精确加载、native-first顺序与当前marker。
- `packages/runtime-kernel/src/internal/contract/host-capabilities.ts`、`packages/box-runtime/test/hcr-capabilities.test.ts`：wrapper/reader与真实loaded身份。
- `internal/ops/host-seam/`、`internal/io/provenance.node.ts`、`internal/roots/monitor.runtime.ts`、`internal/io/monitor-store.node.ts`：分析、留存与intake。
- 两份前置审计报告、T44及本次26项复跑和整包static parse观察。没有据此宣称实际服务已安装运行。

外部技术事实只参考主来源（2026-09-20检索）：

- Node.js `fs.watch` 的inode替换限制，支持dirty事件+周期resync，而非只监听一个文件：`https://nodejs.org/api/fs.html#inodes`。
- Acorn文档：strict parse与ECMA/sourceType、tokenizer在现代JS中受parse context影响；支持parse+onToken而非单独token化自证：`https://github.com/acornjs/acorn/blob/master/acorn/README.md`。
- 初版曾考虑 ESLint scope analyzer：`https://github.com/eslint/eslint-scope`；后续已选择 Rust/Oxc，该链接仅保留初版选型来源，不是当前实施依赖。
- Node.js child process：signal成功不等于退出，close在进程结束/stdio关闭后；支持worker真正结算再释放slot：`https://nodejs.org/api/child_process.html`。
- Node.js vm明确不是安全机制，不能作为日常执行未知/私有Host的隔离许可：`https://nodejs.org/api/vm.html`。

本页维护方案与后续已确认选型，未因此修改生产parser、handler、运行服务、Host、profile、真实通知权限或原有业务实现。

<a id="package-layout"></a>

## 15. 包、目录、协议与发布制品：Rust/Oxc 细化

### 15.1 本次源码观察与边界结论

核对工作树 HEAD `a3e9131` 及实际文件：现有 `packages/` 是 runtime-kernel、box-runtime、client、server、cli 五个 TypeScript workspace，Web 位于 `apps/web`；没有 Rust Cargo 工程。工作树继续并行重建，本节不把该施工状态当兼容故障。

建议：**不新增 npm workspace；新增一个 Cargo package `grokbox-host-verifier`，位于 `crates/host-verifier`，内含一个 library target 和一个 binary target。** root Cargo workspace 只管理 Rust 构建，不是新增运行服务。shared wire schema 放 `protocols/host-verifier/v1/`，它是跨语言合同源，不是独立SDK或运行包。新目录只在真实实现落入时创建，不用空文件/空模块模拟已完成骨架。

| 包/边界 | 本领域的职责 | 不承担 |
| --- | --- | --- |
| runtime-kernel | 能力要求、静态/加载/使用/新鲜度的纯组合、有限健康语义 | spawn/FD/Oxc/RPC分帧/SQLite |
| box-runtime | 精确apply、固定来源、Rust进程适配、健康用例与Effect组合、既有OBS接线 | Web/API授权、第二套AST算法、第二controller |
| server | 用户鉴权/安装绑定、HTTP映射、持有health producer Scope、关闭服务 | 实现词法/CFG、直接在handler中spawn |
| client | 公开管理API DTO、decoder与类型化客户端 | sidecar wire schema、FD、内部源码路径、AST |
| cli / apps/web | 展示与调用同一管理用例；独立的显式离线诊断例外 | 日常直接启动sidecar或复制健康规则 |
| host-verifier Cargo package | Rust静态谓词；binary接收有限输入并返回报告 | 最终Host健康、自主告警、持久DB、凭据、发布/采用 |

独立modeld不加入此调用链；Host/preload不导入重分析或Server模块。Sidecar是按任务的受管计算子进程，不新增端口、常驻daemon或独立升级器。

### 15.2 仓库顶层目标

以下为目标结构，除已存在节点外都尚未创建；省略无关文件。

```text
/
├─ package.json / bun.lock
├─ Cargo.toml / Cargo.lock / rust-toolchain.toml       # 新增，固定Rust构建
├─ packages/
│  ├─ runtime-kernel/
│  ├─ box-runtime/
│  ├─ client/
│  ├─ server/
│  └─ cli/
├─ apps/web/
├─ crates/
│  └─ host-verifier/                                  # 唯一新增Cargo package
├─ protocols/
│  └─ host-verifier/v1/
│     ├─ README.md                                    # framing/版本/FD/取消与错误语义
│     ├─ schema.json                                  # 有限wire数据形状的唯一手写源
│     └─ cases/                                       # 双端有效/无效消息样本
├─ test/
│  └─ fixtures/host-verifier/
│     ├─ sources/                                     # 独立编写的公开合成JS
│     └─ expectations/                                # 独立审核的oracle，不自动刷新
├─ scripts/
│  ├─ build-host-verifier.mjs                         # 新增Rust构建/封装
│  ├─ generate-host-verifier-protocol.mjs              # 新增确定性生成与--check
│  ├─ build.mjs / build-provenance.mjs                # 扩展原构建，不建平行发布系统
│  └─ check-runtime-boundaries.mjs                    # 扩展现有边界检查
└─ docs/roadmap/host-patch-health-proposal.md           # 延续本页，不新起平行总Spec
```

协议cases只验证wire；语义sources/expectations验证分析规则。两者不可混为一个自动生成Golden。真实私人Host、原生用户材料、production receipts仍留在现有受保护provenance域，不进入Git/fixture/npm/crate制品。

### 15.3 TypeScript目录：保留现有分层，但让健康模块可定位

```text
packages/runtime-kernel/src/
├─ host-health.ts                                     # 新增纯门面，对外 ./host-health
├─ internal/host-health/
│  ├─ model.ts                                        # 有限健康/静态证据模型
│  ├─ capabilities.ts                                 # 能力→required check/slice依赖
│  └─ assessment.ts                                   # 分层组合/影响/恢复谓词
└─ internal/contract/host-capabilities.ts              # 复用/扩展轻量loaded witness合同

packages/box-runtime/src/
├─ runtime.ts                                         # 保持既有 ./runtime包门面
├─ preload.ts                                         # 复用；不引入sidecar依赖
└─ internal/
   ├─ host/
   │  ├─ profile.ts / live-slices.ts / compile-hook.ts # 复用唯一精确apply
   │  ├─ load-witness.node.ts                         # 新增薄负回执/挂接见证
   │  └─ …                                           # 复用HCR与run/alert observers
   ├─ ops/
   │  ├─ host-health/
   │  │  ├─ verifier.port.ts                          # 唯一Effect能力合同
   │  │  ├─ program.ts                                # 分析请求/结果受理用例
   │  │  └─ evidence.ts                               # 回执绑定、完整性与规范化
   │  └─ host-seam/                                    # 原retain/Golden/replay编排，不另复制
   ├─ io/
   │  ├─ host-verifier/
   │  │  ├─ client.node.ts                            # 实现verifier能力；唯一live桥
   │  │  ├─ process.node.ts                           # spawn/cancel/exit/close/槽位
   │  │  ├─ stdio.node.ts                             # Content-Length+JSON-RPC边界
   │  │  ├─ binary.node.ts                            # 固定安装制品、manifest与摘要
   │  │  ├─ mapping.ts                                # wire→领域静态证据，不造healthy
   │  │  └─ generated/protocol.ts                    # schema派生，禁止手改
   │  ├─ host-artifact-source.node.ts                 # 固定artifact set/只读FD；复用retain
   │  ├─ monitor-host-health.node.ts                  # 原OBS库投影/intake扩展
   │  └─ provenance.node.ts / monitor-store.node.ts   # 复用唯一来源/存储owner
   └─ roots/
      └─ host-health.runtime.ts                       # Effect Scope/调度与live组合

packages/server/src/host-health.ts                    # 鉴权、DTO投影和HTTP用例入口
packages/client/src/host-health-contract.ts           # 公开API合同
packages/client/src/host-health-validation.ts         # 公开响应验证
packages/cli/src/commands/host-health.ts               # 常规路径只调shared client
apps/web/src/components/host-health/                  # 真实页面需要时创建
```

这些文件代表独立职责，并非要求一次创建全部空文件；相邻极小实现可以先共文件，但不得越过上列权威/资源边界。HTTP路由沿当前server平铺专题模块，不趁本任务重排全Server。CLI/Web接入现有路由和命令registry，页面文件名不在此冻结。

`verifier.port.ts`选择一个Effect Service作为规范能力合同，Live与Fake实现同一行为；不同时维护同义Promise接口、Effect接口和通用Worker接口。生成的wire DTO也不是这个Port。Server只从`@grokbox/box-runtime/runtime`消费域用例/Scope工厂，不能跨包deep import `internal/io/host-verifier`。

建议门面仅提供语义操作：启动/关闭host-health域、读取健康、提交显式复测与查回执、明确的离线检查。不要把spawn、framer、FD池或Rust私有报告解析器export给CLI。现有runtime.ts中历史HSO低层导出随消费者迁移按需收敛，不为了本模块机械重写整份门面。

kernel新增`./host-health`有真实跨模块消费者；它不传递引入Effect、Node、协议生成代码或Oxc。轻量Host实际加载见证继续经既有`./contract`表面，不为读取一个receipt把冷路径能力目录拖进preload。当前边界脚本锁死部分export清单，实施时必须更新准确的合法边，而不是关闭检查或让旧枚举阻止合理新增。

### 15.4 Rust目录：一个package、两个target，核心与stdio职责分开

```text
crates/host-verifier/
├─ Cargo.toml
├─ src/
│  ├─ lib.rs                                         # 窄公开API，不暴露Oxc类型
│  ├─ model.rs                                       # 输入/证据/检查结果，无FD
│  ├─ analyze.rs                                     # 一次分析流水线
│  ├─ analysis/
│  │  ├─ mod.rs
│  │  ├─ parse.rs                                    # 严格parser+semantic diagnostics
│  │  ├─ bindings.rs                                 # 同一词法符号/def-use
│  │  ├─ control_flow.rs                             # 支持范围内的CFG谓词
│  │  └─ transform_diff.rs                           # 原始/实际候选差异
│  ├─ checks/
│  │  ├─ mod.rs                                      # 实际检查注册表/版本
│  │  ├─ session.rs / identity.rs / retry.rs          # 首批资格切片
│  │  └─ context.rs / continuity.rs / instrumentation.rs
│  └─ bin/grokbox-host-verifier/
│     ├─ main.rs                                    # binary target组合根
│     ├─ stdio.rs                                   # framing/控制读/进度/取消
│     ├─ inputs.rs                                  # 验证只读FD、字节预算与digest
│     ├─ mapping.rs                                 # wire与Rust内部model转换
│     └─ generated/protocol.rs                      # 同一schema派生，不手改
└─ tests/
   ├─ semantic_contracts.rs
   ├─ transformed_contracts.rs
   └─ protocol_contracts.rs
```

Cargo.toml明确配置library和上述binary入口。library不读环境/文件路径、不碰stdio、不spawn、不持久化、不联网；接收已绑定的bytes/检查要求，返回静态证据。binary才负责OS输入、协议和线程退出。Oxc AST及内部ID只在library内部，规则可以使用Oxc而不发明通用AST/多引擎trait层。

AST arena/semantic/CFG生命周期限定在一个attempt；优先共享同次解析，再按需顺序处理候选释放大对象，不跨Node边界搬整棵AST。Node的jobId/attemptId只作分析关联，不变成Rust健康数据库。

暂不拆`verifier-core`、`verifier-protocol`、`verifier-cli`、`oxc-adapter`多个Cargo package。出现多个真实binary消费者、独立分发或必须编译期隔离的权力边界时，再把现有模块提升为package；不能因为已有一个Cargo workspace就为了对称建空crate。

### 15.5 三种合同、三种权威，不能共用一份万能DTO

| 合同 | 唯一手写源/语义owner | 使用者 |
| --- | --- | --- |
| sidecar wire形状与传输语义 | `protocols/host-verifier/v1/schema.json` + README | Node adapter、Rust binary；有限类型由schema生成 |
| 能力要求与健康组合 | kernel `internal/host-health/` | 域程序、报告投影、纯规则测试；不导入wire |
| 用户管理API | client `host-health-contract.ts`/validation | Server、CLI、Web；不含FD/内部路径/Oxc节点 |

Rust `checks/mod.rs`拥有实际checker ID/revision/实现，构建导出实现清单；kernel capability目录拥有需要哪些checker及版本。CI/握手核对 required⊆implemented 与版本，没有第三份人工复制清单。wire schema定义check结果的数据形状，不承担JS语义；parser/checker build、wire schema、产品capability revision分别指纹化。

Node/Rust generated代码与生成工具版本锁定并可审查；CI `--check`验证不会漂移。生成类型不替代有限runtime decode和跨字段身份核对。两端用相同protocol cases测整数范围、未知字段策略、乱码、缺帧/多帧、重复final、错request/输入版本。语义Golden不能被schema/codegen或新matcher顺带改写。

`verifier.port.ts`不依赖generated协议；`client.node.ts`经mapping完成跨边界转换。Rust library同样不依赖JSON-RPC请求形状；只有binary负责把wire解码成library model。这样Oxc内部升级、stdio framing变化和用户API变化是独立变更，不要求三边同步改同一类型树。

### 15.6 进程、证据与写者的实际链路

```text
CLI/Web → shared client → server鉴权/use case
                               ↓
                     box host-health program
                 ┌─────────────┼──────────────┐
                 ↓             ↓              ↓
         source/provenance   精确apply      现有loaded/run见证
                 └────固定原始+候选FD─────────┐
                                             ↓
                        verifier Node adapter → stdio → Rust
                                             ↓
                  校验身份/完整性 → kernel健康组合
                                             ↓
                   原OBS投影/incident/outbox → 共享API/通知
```

自动dirty/backstop与显式复测进入同一program；由Server持有一个Scope/调度owner，HTTP断连不拥有共享分析取消。先publish完整private receipt，再幂等写原OBS库；重启按原回执对账，不建另一健康DB或跨库假事务。缓存静态分析不把旧loaded代证明转为当前健康。离线诊断复用同一Port与纯核验，可显式spawn同一制品，但不启动后台、初始化业务库或成为第二writer。

现有精确apply仍是TypeScript唯一变换程序；Rust验证它真实产生的候选，不并行实现第二套replacement engine。健康故障只产生领域事实与建议，真正改变Host继续走原publisher/controller；不得由Rust直接或经回调请求Node代发signal、更新RPC或模型请求。

### 15.7 发布、源码指纹与运行数据分开

建议发布布局：

```text
dist/
├─ index.js / server.js / …                         # 现有Node/Host/Web产物
└─ native/<target-triple>/
   ├─ grokbox-host-verifier
   └─ verifier-manifest.json

target/                                            # Cargo构建缓存，不发布/不作为runtime定位
```

首先资格化当前Box所需target；不因为CLI可能被其他平台调用就一次铺开全部Rust目标，也不允许在缺目标时静默回退Acorn成功。发布物可以明确声明当前可用targets及unsupported原因。release时固定二进制、执行权限、协议/checker/toolchain版本、依赖/许可证信息，装机不需要Rust工具链，不运行cargo或自动下载latest。

当前 `scripts/build-provenance.mjs`只哈希五个TS包、Web、Node相关锁和脚本。实施时加入Rust source/Cargo manifests+lock/toolchain、wire schema/版本与生成/构建脚本，避免checker变化仍复用旧sourceDigest。**源码指纹与二进制输出摘要分开**：构建后manifest列出binary SHA、target、protocol/schema/checker/build身份，再由发布制品集绑定Node与Rust。不要把manifest哈希写进它自己，或制造Rust binary自哈希的编译循环。目标源码在构建期间变化仍拒绝发布。

受保护Host快照、private结果receipt、分析临时FD材料仍由现有provenance/runRoot持有；当前投影、复测回执、incident/outbox在原OBS域。`dist/`和Cargo `target/`绝不存用户运行事实或真实Host dump。分析临时文件由attempt持有并清理；receipt保留受原retention策略约束。

### 15.8 旧逻辑处理与边界验证

| 现有来源 | 处理 |
| --- | --- |
| profile.ts / live-slices / apply / compile marker | 保留，增加完整trace与薄负回执；不翻译成第二Rust apply |
| provenance / envelope / Golden / profile writer | 保留唯一owner，明确区分字节证据与Rust语义证据 |
| HCR wrapper-reader / run-tool-alert witness | 原处扩展能力覆盖，不搬到sidecar |
| Acorn/lexical shape worker | 生产路径退出；有价值部分移动到测试reference，不成为自动降级路线 |
| propose / slice-emit / iteration / replay | 保留必要候选/回放编排，改为消费Rust规范证据；消除独立语义猜测与重复checker |
| monitor / incident classifier / outbox | 扩展原intake和DB，不新增HSO数据库、collector副本或通知writer |
| retired watchdog heal/cutover | 不复活；新producer只观察、controller唯一执行 |
| CLI原直接ops入口 | 常规业务迁到shared client；仅明确离线诊断保留直接只读组合 |

边界检查必须覆盖：preload/Host不能导入Effect、parser、sidecar/Node重适配；client/Web/kernel纯表面不能导入Node/FD/wire；Server只能消费包门面；Rust library不能依赖stdio/FS/网络/业务持久化；生成合同不漂移；target/private corpus不进发布包。扩展现有 `check-runtime-boundaries.mjs` 与打包测试，不能关闭旧门或顺带宣称全仓已有检查都正确。

验收分层：Rust规则正负变体、双端wire合同、Node真实binary进程/FD/取消/退出测试、Server真实入口到OBS的隔离集成、正式安装包smoke。使用同一公开fixture corpus与独立期望，不用native实际账号作默认测试。UI只验证投影与动作，不复写健康算法。

本次仅更新本方案与导航；没有创建以上Rust/Node代码目录、schema、生成器或空文件，也没有改发布/进程行为。接下来实施从能力/协议合同与首批三项Oxc规则的垂直切片开始，而不是先批量建目录或拆空package。
