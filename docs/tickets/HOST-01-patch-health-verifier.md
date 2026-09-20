# HOST-01 · Host 补丁健康识别与 Rust/Oxc 验证内核

状态：**实施中；2026-09-20 主线接收。** Rust/Oxc、Node所属按任务sidecar、stdio JSON-RPC、只读快照FD、五个现有TS包加一个Cargo package的边界已确认并按交接实施。版本与规则由本轮实际构建/反例资格锁定；静态工具不取得最终健康、执行准入、profile发布或通知权限。已闭合的current-state阶段不重做，并行成果保留。

## 用户结果与责任

用户最终使用新版时，所声明启用的 Host 补丁能力有明确的静态资格、加载/使用证据与覆盖缺口；必要失效能进入既有 incident/通知链，不能仅因源文件、两个刀口或进程存活而显示健康。

本票拥有新增静态验证器、能力/分析合同以及与既有健康链的集成验收入口，不另写总 Spec、monitor 数据库、profile publisher 或 Host controller。详细设计唯一指向[健康方案](../roadmap/host-patch-health-proposal.md)，包与协议布局见[第15节](../roadmap/host-patch-health-proposal.md#package-layout)。精确应用与运行权威继续归[Host compatibility](../runtime/host-compatibility.md)，告警语义归[Operations](../runtime/operations.md)。

主线接收本会话成果时，从[整合交接](../roadmap/host-patch-health-integration-handoff.md)了解版本调查、旧链审计、已确认Rust/Oxc边界和接入顺序；其中进度是固定快照，接收时复核CLI-05最新阶段，不另立当前进度账。

## 本次插入依据（固定观察，不是当前部署状态）

本轮读取工作树 HEAD 为 `a3e9131`，实际业务成果大量处于暂存/未暂存状态。CLI-05 已记录共享 Server/客户端、观察与通知、材料、保护、人工生命周期；本轮读取期间又补入独立 current-state 入口，最终扩大回归仍待收尾。因此不能只读 HEAD 或票首摘要判断开发进度。

本轮重新读取的磁盘 Host SHA 为 `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`，worker 为 `56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e`。逐片纯内存诊断仍是基础39片中9片不匹配、checkpoint3片匹配、current-state19片中2片不匹配；完整配方并未通过。包括context/startup/retry/alert相关切片，且current-state仍固定另一Host/worker资格组合。磁盘字节不是运行进程已加载该版本的证据。

新增审计反例、context客户端合同与HCR能力测试本轮共17项通过；其中审计再次复现合法升级事件入evidence却不产生incident。它们证明局部现状，不签整个current-state阶段、Rust或现场运行。前置事实详见[版本影响报告](../reports/2026-09-20-grok-bot-upstream-impact.md)和[旧健康链审计](../reports/2026-09-20-host-patch-health-chain-audit.md)，再次升级后需重测相关来源。

## 插入点：W3 内的平台依赖工作，不是 W4 末尾的新愿望

主线已完成独立current-state切片及705项固定回归，现从这个完整边界接入本票与HCR/T44必要部分。当前W3阶段优先完成真实来源诊断、首批三个Oxc语义规则、正式Node/FD/binary链及原OBS安装级condition；不提前冻结新版候选，不重跑旧RC。手动handover/compact的后续迁移继续排在此平台接口之后；无关材料及页面可并行，不重新选架构。

它不以DATA-01所有文件扩展、CONT所有关系或全部旧命令迁完为前提。无关的材料/界面/纯客户端迁移可以继续。依赖实际Host能力的compact、startup、capture/initialize、真实恢复和通知资格，必须消费当前明确的来源/能力证据，不能用合成端的通过覆盖缺口。原生适配修复若已有独立证据可以先完成，不要求等整个Oxc内核；反过来Rust解析成功也不能替代实际修复/采用。

完整识别与必要监控告警是新版可靠性工作；自动派生profile、无人值守采用属于[低风险维护T48](T48-low-risk-host-qualification.md)/[T49](T49-policy-host-maintenance.md)的独立授权范围，不把检测器延期成它们的可选附属，也不为先做检测扩大维护权限。

## 已落地的首个完整纵向工作包（2026-09-20）

主线接收后保留既有及并行成果，实际接通：原TS `applyPatchProfile`→固定只读artifact FD→正式Rust/Oxc binary→有界报告→原provenance→原OBS installation condition/outbox→共享CLI和Web。Cargo/Oxc0.75.0/Rust1.85.0及wire生成固定；schema是握手/请求/报告完整形状的单一手写源，Node和Rust共享独立形状反例。binary只做静态分析，未增加controller、DB、RPC server或第二transform。

三个已实现checker为 `session.main-binding`、`retry.turn-guard`、`context.checkpoint-await`。解析完整文件并检查parser/semantic错误，用实际symbol binding、有限CFG/def-use与受支持的直接调用/CJS注册链，而非同名变量集合。新反例复现并修复了死分支/return后匹配、TDZ值、字段/回调重写、不同词法frame与未注册或被覆盖的入口被误判通过的问题。它们仍是明确的有限结构证明：动态registry、一般跨函数别名和完整native主链角色尚未获得资格；unsupported不退Acorn或自动改Golden。checkpoint callback的await证明不冒充完整lease/finally/worker原生寿命已证。

Node对子进程输入/输出/权限/哈希和job/attempt/build/schema/checker核验；超时/取消终止后等待真正close，不以收到报告释放槽。真实binary测试覆盖只读FD、错hash/长度、重复fd、语法恢复、父Node死亡；敌对测试进程仅用于协议崩溃/重复final/截断/挂起反例，不替代正例实际Rust。Host实际source与companion各自语法结果和candidate谓词分开保留，任何必需artifact无效由健康组合保留失败，不能被candidate通过盖掉。

管理Server所属producer按安装来源dirty/backstop采样，不依赖非空Bot名单；跨来源代的迟到报告不能覆盖当前，A→B→A可重用静态缓存但生成新证据序列，loaded/attachment/exercised不沿用。源snapshot完成前会重新通过FD读bytes核hash，修复同size/同毫秒mtime变化被stat漏掉的问题。原provenance保留未索引回执，原OBS按有限cause归并condition，读回/正证据恢复和ack/通知分别处理。当前公开coverage为local-only，没有放宽接收者资格。

`system host health` 和 `/host-health` 已读取同一管理用例，页面无源码/AST/凭据、无采用/重启/模型调用。正式发行制品包括binary、manifest和完整依赖许可文本；Oxc crate未附LICENSE的情况按crate原VCS revision核对并使用实际取回的固定上游文本，非按MIT标签虚构版权通知。`test/packaging.test.ts`实际安装后核hash并通过Node/FD运行安装后binary；运行时无需cargo或联网取latest。

实际入口：`bun run verify:host-health`（core与integration两个固定源码窗口）、`bun scripts/qualify-host-health.ts --source <absolute-host> --worker <absolute-worker> --binary-directory <artifact-directory>`（可另传显式 `--profile`）。后者仅显式来源静态资格，不发布profile或执行私人Host。最终固定回归记录归CLI-05，不用此前705项替新阶段签收。

本阶段重新固定磁盘Host/worker，与前置报告相同：26,523,565字节Host及677,638字节worker；完整base配方仍首先在managed-retry-gate失败，逐片39中9个/原生current-state19中2个不匹配。Oxc整包source/companion严格诊断可完成，但没有精确候选，所以candidate规则不是passed。保留旧配方和配对pin，不批量改名/删slice/提高权限求绿。详细最新取样与时长归本阶段固定回执，磁盘观察不代表当前loaded。

**HOST-01仍未整票关闭。** 后续依赖是实际native role/完整能力目录与post-transform行为、加载负回执、同代attachment/exercised、profile/companion资格、长期容量和独立出口。下一段handover/compact等受Host影响路径须先补对应当前来源资格；无关材料/管理可以并行。当前工具/安装集成通过不准许部署或宣称真实恢复。

## 编译正负回执与运行代集成

原 compile hook/preload marker 已提供实际模块求值的正负观察；Server 在独立采样通道核对 PID/start/UID/exe/argv、安装根与启动目标，区分当前运行代和历史，不用磁盘新字节撤销旧运行代事实。原 provenance→OBS 的运行事件流已接通；静态通过、进程退出和缺 marker 不能替代运行编译恢复证据。CLI/Web 分开展示两种来源，attachment/exercised 仍缺证，qualified=false。

固定证明见[编译健康阶段报告](../reports/2026-09-20-host-compilation-health.md)：实际打包 preload/公开合成模块、真实 Node进程、原存储和Chrome，含负编译、PID复用、旧marker回滚、retain-before-intake与无OBS。未修改当前私人Host配方或配对pin；该适配和完整挂接/实际触发仍是本票下一阶段。

## 同代注册与实际边界见证

已落地原preload引用登记和原getHostStatus本地challenge。管理Server前后核运行代，读取handle/method真实身份、必要切片与最多32项连续事件后缀；注册失配、见证读取失败进入原runtime provenance/OBS，不刷新即宣称修复、不放宽通知门。session选择/流/terminal、retry识别、context lease/preflight/checkpoint记录实际边界；读面不触发这些动作。错误旧回复不归因于新代，原证据文件丢失不静默重置序号。来源与运行scope仍独立，机会覆盖未建立，不称全路径已正确挂接。固定398项、Rust20、Node19、Chrome66等范围见[见证报告](../reports/2026-09-20-host-capability-witness.md)。

下一批继续完整能力目录与当前来源适配；不重新开发已闭合编译/见证链，仍不得由有限handle检查将`qualified`升级为true。

## 固定新版来源的配方适配与注册复核

已针对固定`2380c2c7…`源码完成原9+2处失配适配，并经原TS完整有序apply得到61片候选。原profile writer/只读envelope按准确源码选择维护布局，未知源码不模糊替换，旧profile与Golden/配对pin不变。新actionOnly/idle/resume、受信手动Compact与private startup各走原语义分支；独立执行fixture验证异常、工具、alert抑制和上下文分支。实际source/candidate/worker经正式Rust严格诊断均合法，但3个native role规则仍unsupported、配对未资格，不能宣称恢复可用了。

真实factory复核修正了Alert attachManager误登记与其他遗漏handle；另以阻塞反例修复两采样lane把未留存见证提前显示committed的问题。最终固定486项/0失败，witness Node20与Chrome66等内部范围、实际候选SHA及尚未归因的浏览器偶发失败见[本批报告](../reports/2026-09-20-host-idle-layout-adaptation.md)。本批仍不执行私人Host、发布profile或采用现役服务。

下一批应扩展当前真实包的主链角色/完整checker与相关Host-worker资格，再接续受影响的handover/compact；原生应用与边界见证不是仅靠61片匹配或一个工厂表就闭合。

## 同一工作包的顺序与出口

### A. 先收实际原生依赖风险

逐项核对当前Host的失败切片、idle compaction/启动语义、Host/worker配对及仍被旧能力使用的RPC；区分真实适配问题与正在迁移的管理入口。通过既有profile/HCR/CONT owners修复或给出明确不可用原因，保留精确SHA、完整依赖与未知效果边界。不能只全局替换打包变量名、删slice或读本地副本伪造原生支持。

输出应能说明本次实际来源的必需能力、失败/缺口及其影响。不要求在本阶段临时恢复旧开发版日用或部署当前worktree；现场读取/采用/模型动作另核授权与目标。

### B. 尽早落 Rust/Node 的真实纵向切片

按已确认目录实现一个Cargo package、固定protocol及受管stdio/FD适配，复用实际TS apply结果作为候选输入。先实现主会话绑定、managed retry分支、一个context生命周期的真实语义检查；同一固定来源或独立反例经Node实际入口到Rust、有限报告、既有证据owner、OBS intake，至少形成一个可查询的正确incident。必要source不匹配在AST之前即可报告，不让后层阻塞前层确定的故障。

同一切片纳入Rust源码/lock/toolchain/schema/规则的构建指纹，验证正式打包binary而不是cargo run。超时/崩溃/错版本/FD不匹配/输出截断/取消/真实exit-close结算有反例；不放到最后安装阶段才发现新工具链不能交付。不能以空Cargo工程或一条parse成功替代本阶段。

### C. 完整识别、实际加载与监控闭环

按启用能力补齐精确有序apply、AST/binding/有限CFG、变换后约束、独立Golden与破坏变体。关键变体不能全靠unknown-sha抓住；不支持范围明确unknown，不因引擎失败退到另一个parser求绿。HCR补负回执与同代attachment，区分ready和未触发；业务见证只覆盖实际发生的窗口。

由T44在管理Server Scope接入安装级来源producer、dirty/backstop、重启和换代resync，不依赖非空Bot列表；OBS负责幂等condition、影响聚合、缺口与恢复。通知复用原outbox/权限，接收Host也失效时必须明确独立出口或local-only覆盖；选择出口与凭据仍须授权。不得另建sidecar daemon/controller，不让monitor成为同步STEP准入依赖。

首个纵向切片不是最终交付上限。对所声明必需的执行与观测能力，完整识别、必要故障入库和恢复证据都要完成，才能关闭本票的集成义务。

## 责任分配（各事实仍由原owner维护）

| 入口 | 本轮关联责任 |
| --- | --- |
| HOST-01 | Rust/Oxc、静态谓词、有限分析合同、跨语言/制品一致性与其集成验收 |
| HCR-01/02/04 与既有profile/CONT | 当前来源配方诊断、实际loaded/attachment及原生能力资格；不复制writer |
| [T44](T44-host-ops-continuous-sensing.md) | Server所属持续来源/加载/检测器健康producer |
| [T41](T41-continuous-observation-and-alerting.md)/[OBS-01](OBS-01-incident-intake-and-detection.md)/[OBS-04](OBS-04-bounded-observation-storage.md) | 原库intake、condition、证据、容量、去重与恢复 |
| [T45](T45-template-webhook-delivery.md)/[T55](T55-custom-receiver-delivery.md) | 原通知投递、接收者资格与同故障域；独立出口按明确范围接入 |
| [T40](T40-persistent-release-and-rollback.md)/[T50](T50-template-ops-release-proof.md) | Rust与Node成套发布、正式宿主/重启/退出资格 |
| [CLI-05](CLI-05-implementation-follow-through.md) | W3插入顺序、共享client/CLI/Web集成、W4冻结前完整交付 |

既有[HCR入口](README.md#host-capability-recovery)与[T48](T48-low-risk-host-qualification.md)不被本票重新编号或合并。研究库中主Bot/人类群/邮箱/语音等新增产品面，仅按实际依赖另判范围，不随本票自动成为全量App复刻任务。

## 哪些可以继续，哪些必须等资格

| 工作 | 与本票的关系 |
| --- | --- |
| 当前current-state有界收尾、纯HTTP/权限/回执/页面、无关材料迁移 | 可继续；记录真实来源未证范围，不等待全部Rust实现 |
| compact/startup/原生恢复路径的修改 | 先核实际来源与相关不变量；可与静态内核并行，不按旧fixture猜当前正确行为 |
| 新版Host采用、实际受管模型/恢复/接收者通知验收 | 相关来源与加载资格必需，具体现场动作另授权；不要求全仓所有无关checker先完成 |
| 新版完整候选冻结和可靠性交付 | 完成所声明Host健康能力与必要监控/告警；Rust制品纳入安装与重启证明 |
| 自动新profile派生/自动adopt/通用多渠道升级平台 | 非本票默认范围；不阻塞准确识别本身，不扩大许可 |

## 集成证明与完成边界

新测试按实际命名落盘后进入根构建与适用验证；不要现在登记尚不存在的可执行命令。至少覆盖完整判定链、真实Node→打包Rust→报告、等价与语义破坏反例、当前大包静态输入、worker结算、source/loaded分代、retain后intake前崩溃、通知同故障域和正证据恢复。公开测试不依赖私人Hostdump，私人字节只进入受控静态资格窗口。

LIVE中的HOST-CAPABILITY-RECOVERY、CURRENT-CONTEXT、CTX-ADOPTION、MONITOR/OPS-OBSERVER-LIFETIME与PACKAGE-INSTALL/RELEASE-CANDIDATE按实际新增义务绑定本票；现场结果仍只记[LIVE](LIVE-integration-validation.md)。如确有新场景，由实施者同批更新执行手册、registry覆盖和验证工具，不把设计文档存在写成ready/passed。

完成至少要求：必需检查无未声明缺口；原生资格与静态资格不混；真实负事件可进入现有故障出口；既有publisher/controller/存储owner没有重复；正式binary、Node协议及缓存身份相容；Server关闭和分析失败不带倒合法modeld执行。未授权的实际采用、外部通知和模型费用不因源码完成自动发生。
