# 主线交接：Host 升级风险 → 补丁健康闭环 → Rust/Oxc 验证内核

交接日期：2026-09-20。接收者：正在实施 grokbox 新架构主线的 Agent。

**这不是让你另起一个 Rust 项目，也不是要求重做当前主线。请把本会话已确认的 Host 健康能力整合到你正在推进的新架构、来源票与实施顺序中，充分复用旧逻辑，随后按大阶段实施。**

本文是一次固定的跨会话交接与导航，不是新的总 Spec、当前进度账或现场操作授权。完整设计仍归[健康方案](host-patch-health-proposal.md)，施工责任归 [HOST-01](../tickets/HOST-01-patch-health-verifier.md)，跨域进度归 [CLI-05](../tickets/CLI-05-implementation-follow-through.md)，现场结果只归 [LIVE](../tickets/LIVE-integration-validation.md)。接收后以这些入口的最新内容和实际代码复核，不把本页快照覆盖回主线。

## 1. 工作位置与第一步

环境：`devspace-box`。交接产生于 `~/.devspace/worktrees/feat__box-runtime-v2-17d4f799`；本次工具确认的绝对路径为 `/home/box/.devspace/worktrees/feat__box-runtime-v2-17d4f799`。正文内代码路径均相对于该仓库根；文档链接相对于本文。

私人上游研究库是 `~/code/grok-bot`；原生磁盘来源在 `/home/box/sand-host/`。这些是调查入口，不是公共构建依赖，也不是当前已加载进程的证明。

先核对你正在操作的 checkout、暂存/未暂存成果、最近一个实际闭合的切片与正在执行的验证。不要只看 Git HEAD，不要 reset/clean、覆盖并行改动或从干净 HEAD 重建本工作树。若需并行，先固定实际共享基线并划清共享文件的写入者；本交接不要求另开 worktree。

### 交接写入时的新进展

本次读取 HEAD 仍为 `a3e9131`，大量新版成果尚未提交。更重要的是，CLI-05 已新增「当前上下文阶段固定验证」：记录固定源码 `0e31d6ce81ab47bac6cd159ab61032abb0eb7304bf85f65128918e6e726ddf44` 上 705 项隔离回归，以及该阶段的类型、生产制品和文档检查。

**这更新了上一轮“current-state 尚待最后收尾”的判断。** 上述数字是接收前主线票中的固定记录，本次写交接没有重新执行这些测试。请读取其最新段落；若该切片已经闭合，就直接从下一个安全工作边界接入 HOST-01，不再重做 current-state 收尾，也不沿用旧的688项作为这一阶段证明。

截至本次目录核对，尚无根 Cargo 工程、`crates/host-verifier` 或 `protocols/host-verifier`。若接收时这些已由你或其他 Agent 落地，应吸收实际成果，不重复创建或覆盖。

## 2. 这件事为什么从版本调查发展成核心架构工作

### 起点：不是新版 App 多了功能，而是原生依赖真的发生变化

用户最初要求比较 `~/code/grok-bot` 最近版本与 grokbox 的关系。[版本影响报告](../reports/2026-09-20-grok-bot-upstream-impact.md)分清了 App 0.47→0.57.1、研究库旧 Host、Box 磁盘新 Host与当前工作树，不把它们当成同一版本。

在报告的固定来源上，基础配方39片中9片不匹配，current-state19片中2片不匹配；checkpoint3片能匹配，但不能据此继承整个Host/worker配对资格。问题涉及retry、tool/alert观察、手动Compact和startup，且新Host增加idle compaction相关控制流。旧Memory RPC移除也影响仍然使用它的材料回退，不能把它误判成整个新材料查询失效。

### 第二步：用户明确要求看旧机制，而不是把破坏重建中的缺口算成升级故障

[旧健康链审计](../reports/2026-09-20-host-patch-health-chain-audit.md)因此追了精确apply、字符串窗口、Golden、AST、编译回执、watchdog实际入口、monitor intake和通知。

结论不是“什么都没有”：精确加载门、profile发布、HCR、原生见证、持久incident/outbox等已有价值。真正的缺口是检测覆盖与常驻接线不完整，部分诊断停留在离线工具；合法升级事件可以进入evidence却不形成incident；依赖本机Host资格的接收Bot还可能与故障同失效。

### 第三步：目标转为面向新架构的完整健康能力

用户强调“健康识别本身最重要，字符串、AST等能增强准确性的机制都可以上”。[完整健康方案](host-patch-health-proposal.md)因此按来源、精确适用性、语义资格、实际加载、挂接、使用和检测器自身健康分层，而不是给出一个健康分数或只补告警。

随后经过Rust选型、Oxc/SWC比较、调用形式与包布局讨论，用户已确认下节边界。**不要再把Oxc当成尚待在SWC/Oxc间选择的候选，也不要退回“先做个字符串告警就够了”。** 具体版本与实现性能仍需工程资格验证，选择引擎不等于已经证明它的规则正确。

## 3. 关联文档：分别回答什么，不应互相替代

| 文档 | 接收时的用途 |
| --- | --- |
| [版本影响报告](../reports/2026-09-20-grok-bot-upstream-impact.md) | 解释眼前上游变化、具体失败切片、原生接口与业务影响；是固定证据，不是部署事实 |
| [旧健康链审计](../reports/2026-09-20-host-patch-health-chain-audit.md) | 明确旧机制可复用项、真实调用链断点和四个审计反例；避免重复造轮子或复活退休执行器 |
| [健康方案](host-patch-health-proposal.md) | 唯一详细方案；§3–6定义健康与识别，§7–12定义集成、监控、告警和验收 |
| [方案§15：包、协议与制品](host-patch-health-proposal.md#package-layout) | Rust/Oxc、现有TS包、stdio/FD边界、目录、三种合同与正式交付布局 |
| [HOST-01](../tickets/HOST-01-patch-health-verifier.md) | 新增静态内核及健康链集成的施工入口、范围与阶段出口 |
| [CLI-05](../tickets/CLI-05-implementation-follow-through.md)和[重建骨架](agent-first-cli/implementation-impact.md) | 当前主线实况、W3插入点、共享Server与一次性破坏重建边界 |
| [Host compatibility](../runtime/host-compatibility.md)和[Operations](../runtime/operations.md) | 既有精确应用、发布、运行权威及incident/通知合同；设计落实时归位到原owner |
| [LIVE](../tickets/LIVE-integration-validation.md) | 新版集中验收范围与当前现场结果；旧通过不能替新候选签收 |

按任务沿这些入口读取必要连续段落，不要求重读全仓历史。遇到陈旧摘要、设想中的路径或旧命令，先核实际代码与用途，保留历史证据的原范围；不要为了迁就旧文档恢复已退出的writer。

## 4. 已确认的架构边界：无需重新向用户询问

### 4.1 Rust/Oxc只拥有静态验证，不拥有最终健康与运维权

主静态内核使用Rust/Oxc，做严格parse、semantic诊断、真实绑定、有限CFG、变换后约束和有界证据。AST非空不算语法合法；支持范围外的动态语义明确unknown/unsupported。Acorn只保留独立测试参考，不在Oxc失败时作为生产求绿回退。

Node/Effect结合静态证据、实际loaded/attachment/exercised与新鲜度来形成健康判断。Rust不写数据库、不调用模型、不自动发布profile、不发Host控制动作，也不能反向要求Node代做这些事。

### 4.2 调用形式已定为按任务子进程

Node通过`spawn`启动固定发行版verifier，无shell；控制消息用stdio上的JSON-RPC 2.0与`Content-Length`分帧。stdin接请求，stdout只发协议，stderr只作有界诊断。源码/实际候选/必要companion使用继承的只读快照FD，不经巨型JSON/base64、不输出整棵AST。

一个进程完成一次完整分析任务，不是每slice启动一份，也不新增常驻HTTP/gRPC服务、UDS daemon或Server内N-API重分析。Node统一管理握手、single-flight、缓存、job/attempt身份、取消、输出上限、实际exit/close和槽位释放；完整报告与进程结算分别核验。

输入FD仍需验证实际读入的字节摘要；句柄不是不可变性证明。静态分析纯只读，结果丢失可在有限预算下用新attempt重算；不能把有外部副作用的Host操作未知重放规则不加区分地照搬过来。旧来源迟到结果不能覆盖新来源当前状态。

### 4.3 包与目录边界已确认

保留`runtime-kernel`、`box-runtime`、`server`、`client`、`cli`五个现有TS workspace和`apps/web`，不新增一串npm包。新增`crates/host-verifier`这一份Cargo package，含library和binary两个target；根Cargo workspace/lock/toolchain固定Rust构建。wire合同放`protocols/host-verifier/v1/`。

Rust library不读OS路径/环境、stdio或业务存储；binary负责协议和FD。Oxc类型不跨库/跨进程公开。TS的健康语义、领域用例、Node进程适配、Server组合、公开client DTO按方案§15落到原分层，具体小文件可按实现合并，不先批量创建空骨架。

wire、健康领域、管理API是三种不同合同。wire schema是消息形状的单一手写源；能力目录拥有“需要哪些checker”，Rust注册表拥有“实现了哪些checker”。构建与握手核对版本与覆盖，不手抄第三份支持清单，也不让生成器重写语义Golden。

### 4.4 必须复用的权威

**TS `applyPatchProfile`继续是唯一精确变换；Rust验证它实际产生的候选，不实现第二套replacement。** profile publisher、Host controller、provenance、原生当前状态writer、OBS数据库和outbox继续归原owner。

Host/preload保持轻量。modeld独立；监控故障不得主动终止已开始的合法执行，也不让每个STEP同步查询管理Server/健康库才能执行。执行准入仍在原owner处核必要直接证据。

### 4.5 健康识别与自动维护是两种范围

完整识别、必要监控与告警属于新版核心可靠性，不延期成[T48](../tickets/T48-low-risk-host-qualification.md)的可选附属。自动派生新profile、无人值守采用/回滚、通用多渠道平台与自动公开Issue不随本任务默认启用。

通知不得因接收Host失效而放宽其ownership/model/profile门。实现至少一个明确授权的独立出口，或准确显示local-only覆盖；没有渠道和凭据不伪造“必达”。整机/Server死亡另需外部失联观察，本机心跳不能自证整机故障可达。

## 5. 怎样整合到你正在推进的主线

**放在W3的平台依赖大阶段内，先于完整新版候选冻结，不等所有DATA/CONT/旧命令迁完才做。** CLI-05已加入该插入建议；本次current-state固定验证记录出现后，不再机械等待已经结束的收尾。

若你接收时正在另一个不可中断的验证/事务切片，先在最近的明确边界闭合并保留回执，然后切入；若已进入更后阶段，按真实依赖重排，不倒退重做主线。无关页面、纯HTTP权限/回执或材料工作可继续，并行时协调Server组合、包manifest、构建脚本、共享合同和CLI-05等共享文件。

### 线A：直接收实际Host风险，不等完整Rust工具箱

重新固定眼前Host/worker/profile来源，核失败切片背后的真实语义，尤其idle compaction、manual/startup、retry、观察器和配对资格。仍被必要能力使用的旧RPC也一并归类。对已有独立证据的适配，通过原owner修复与测试；其余准确拒绝并说明影响。

不要只批量替换打包变量名、删掉失败片、放宽SHA或用本地副本冒充原生支持。磁盘A→B不等于当前运行A立即不可用，更不自动授予杀旧Host的权限。

### 线B：尽早做真实纵向切片，随后扩成完整识别闭环

从主会话绑定、managed retry分支和一个context生命周期规则开始，让固定输入走过Node真实入口、Rust binary、有限报告、既有证据owner和OBS intake，至少形成一个可查询的正确incident。已确定的source不匹配在AST之前就可记录，不能等重分析成功才报告确定故障。

同一切片纳入正式binary、协议生成/校验、Cargo与schema构建指纹及打包测试，不等最后安装阶段才检查能否交付。测试必须运行真实binary，而不是始终由Fake替代；不以空Cargo工程、parse成功或合成hello-world作为一个大阶段完成。

之后按声明启用的能力补齐字符串/有序apply、AST/binding/有限CFG、变换后检查、独立Golden、语义破坏变体、加载负回执、attachment与实际使用见证，并由Server Scope接入安装级dirty/backstop与原OBS/通知。第一条纵向链不是最终交付上限。

两条线互相提供证据但不互锁：不要求先修绿所有Host才做检测器，也不要求Rust全部完成后才修已确定的Host问题。

## 6. 已有事实与陷阱：接收时复核，不当成当前绿色依据

下列均来自前置报告的固定窗口。本次写交接没有再次运行Host诊断或查询实际Gateway；版本再次变化应重新取样。

| 既有证据 | 对实施的具体意义 |
| --- | --- |
| 磁盘Host `0382fa8`，SHA `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`；worker SHA `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e` | worker未变不代表配对资格继承；先分清磁盘、原审核来源和真实loaded |
| 精确配方仍有前述9+2个不匹配项 | 部分单片匹配不是完整apply通过；失败样本可用来驱动新检测规则 |
| 升级四事件入evidence而不产生incident | producer→intake必须有真实集成断言，不只新增JSON报告 |
| Acorn按名字关联跨作用域`options`出现错误候选 | 必须用真实符号绑定；AST本身不是语义正确性证明 |
| 旧工具8 MiB预算拒绝真实整包；独立Acorn整包strict parse曾成功，约26.5MB输入 | “预算拒绝”不是“不能解析”；已有单次基线不代表Oxc全管线性能，需要实测 |
| 默认两刀口可绿，而retry片已坏 | 不能把局部窗口或`driftedSlices=[]`当全能力健康 |
| 旧watchdog执行器已退休，profile watch只做once，analyze未接真实runner | 不能据命名误认存在常驻自愈，也不复活第二controller |
| 源不匹配时保留原生编译，compiled成功marker不产生 | 补负回执；不声称拒绝patch等于原生所有执行都被阻断 |
| 当前session补丁先构造原生session再调managed hook | 先核正确产品语义与构造前提，不能复制旧行为给自己写通过Oracle |
| 接收者资格随source/generation/model/ownership漂移会阻止通知 | 安全门应保留，健康闭环需要识别同故障域与通知覆盖 |

四个可复用的characterization反例在忽略目录`.scratch/upstream-patch-health-audit.test.ts`；若跨checkout不存在，从原审计理解性质后迁入正式测试，不把临时文件列为发布硬依赖。它们中“通过”可能表示成功复现一个缺口，不是产品验收完成。

## 7. 责任归位：只补真实接口，不另立平行工程

| 入口 | 本次应承接的内容 |
| --- | --- |
| [HOST-01](../tickets/HOST-01-patch-health-verifier.md) | Rust/Oxc、静态合同、跨语言/制品一致性与端到端集成出口 |
| [HCR入口](../tickets/README.md#host-capability-recovery)、原profile/CONT | 失败配方、实际loaded/attachment、原生能力和状态安全 |
| [T44](../tickets/T44-host-ops-continuous-sensing.md) | Server所属安装级来源/加载/检测器健康producer |
| [T41](../tickets/T41-continuous-observation-and-alerting.md)、[OBS-01](../tickets/OBS-01-incident-intake-and-detection.md)、[OBS-04](../tickets/OBS-04-bounded-observation-storage.md) | 原库intake、condition、证据、容量、恢复与聚合 |
| [T45](../tickets/T45-template-webhook-delivery.md)、[T55](../tickets/T55-custom-receiver-delivery.md) | 原投递、接收者与同故障域，不放宽授权换取告警成功 |
| [T40](../tickets/T40-persistent-release-and-rollback.md)、[T50](../tickets/T50-template-ops-release-proof.md) | 成套安装制品、服务/子进程寿命、退出与重启资格 |
| [CLI-05](../tickets/CLI-05-implementation-follow-through.md) | 排程、共享消费者、旧入口退出、跨域验证与候选冻结 |

完整设计继续回写原健康方案；稳定规则按原Host compatibility/Operations归位；具体实施及验证差额写对应来源票。不要把本交接扩成另一份持续更新的总进度，也不要重新编号既有HCR/T44/OBS。

研究库新增主Bot、邮箱、语音、人类群等产品面，只按实际依赖另判，不自动进入这次核心工作；本任务不是全量复刻Grok Bot App。

## 8. 集成时不能缩掉的验证出口

**识别质量：** 每个声明启用的能力都有必要checker与运行见证，缺项明确；真实绑定、条件方向、覆盖写、异常/dispose/worker边界有独立反例。在隔离语义测试中重新固定变体hash，确保不是所有破坏都仅由`unknown-sha`抓住；新matcher不能自动刷新Golden。

**调用与资源：** 正式Node→打包Rust→报告真实运行，错binary/schema/checker/FD摘要、半帧/截断、重复final、错attempt、超时、崩溃、父进程死亡和取消均有断言；收到结果不等于child已退出，未结算资源不能当空闲槽位。

**状态与持久化：** A→B→A、PID复用、worker-only变化、旧报告迟到、无Bot目标、首次observer缺席、reader正常但source不适用都正确判定；retain后intake前退出可幂等补入；source变化不能由旧运行代背书。

**闭环与权限：** 真实负证据能形成正确installation级incident，多个能力受影响不变成重复风暴；接收Host失效能看到投递阻断/独立出口；ack、禁用意图、通知受理、修复和真正恢复分别呈现。

**制品与隔离：** Rust source/lock/toolchain/schema/规则进入构建身份，正式安装不需cargo、不下载latest；私有Host/凭据不进公共fixture和包；AST/协议不进入preload或browser；Server/分析器故障不主动终止已合法开始的modeld执行。

按受影响性质选择测试，不每次重跑旧RC或完整模型矩阵。新可执行入口落地后再登记验证命令；没有的文件不能写成已可运行测试。完整候选与真实现场验收仍分别取证，旧53/89/705等计数不能替新集成签署。

## 9. 接收后的执行方式与汇报

请先对照当前主线把本交接吸收到既有排程，指出已实现内容和仍缺接口；然后沿HOST-01进入一个足够大的实际阶段，不停在重新讨论架构、创建目录或只改Spec。已确认的Rust/Oxc、通信和包边界无需再次请求用户选择；若实际资格实验发现会推翻边界的具体反证，明确提出反证与最小调整，而不是因历史实现习惯退回旧路。

阶段结束报告应能定位：实际原生来源/必需能力的情况、真实Node/Rust链、复用和退出了什么、故障如何进入原incident、哪些场景已经验证，以及尚未验证/未授权的边界。实现与固定证据写回原owner；不要把“操作已受理”“AST找到位置”或“测试能parse”称为整个闭环完成。

现场Host采用/重启、真实账号/模型费用、外部通知和资料清理仍需核对已有授权及准确对象；本交接不撤销原范围内的有效授权，也不扩大它。纯工程实现、公开fixture和已允许的只读静态分析不应因此反复卡在例行确认。

## 10. 本次交接的变更范围

本次只新增本页，并在HOST-01放置交接导航；没有改业务实现、Cargo/协议工程、运行配置或现场服务，没有提交、合并、暂停其他Agent或替主线重新跑705项回归。接收方的实时工作状态仍以CLI-05、原领域票和实际文件为准。
