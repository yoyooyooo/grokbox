# T40 — 持久运行、限定生产放行与完整回滚

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status / responsibility

**Partial / open release closeout：本票拥有持久服务/回退合同、实现与离线资格；现场进度不在本票维护。** 本票拥有V25/V27以及V17/V18的生产操作闭环；T28仍是唯一控制程序/精确进程操作owner，T25拥有modeld资源生命周期，T24拥有日常选模，T39拥有原生会话往返。

当前现场候选、已验/未验、阻断和下一步唯一索引到 [LIVE-RUNTIME-PERSISTENCE](LIVE-integration-validation.md#live-runtime-persistence)、[LIVE-MODELD-RESTART](LIVE-integration-validation.md#live-modeld-restart) 与 [LIVE-MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence)；固定运行证据留在它们链接的日期报告。退出操作合同仍在 [rollback acceptance](../maintainers/official-rollback-acceptance.md)。下方带日期的回执只说明当时范围，不是另一份当前部署账；配置保存/进程ready/单次pong不等于产品可生产。

## Dependencies without cycles

本票服务启动/停止的隔离实现以T25/T28现有机制为基础，可与T39旅程夹具并行。真实试验先用已满足的T37/T38身份门；**最终生产放行**才合取T24/T26/T32/T35/T36/T37/T38的必需子集和T39完成证据。T39不依赖本票整票Done，避免“先有发布才允许验发布”的环。

test2只保留T38冲突诊断/校准；test1未opt-in官方对照；test0或另一个经明确批准、Server确认box的对象承担正例。新建Bot或真实B模型要有具名授权，不由文档自动扩展到业务对象。

## 1. 正常持久运行

复用现有`runtime start/status`、controller/re-adopt、modeld与凭据存储接口，打通当前占位或不完整闭环。服务管理器采用当前部署环境可证明支持的一个明确方案，不并存多套启动所有者，不另造supervisor体系。

- 首次启动、重复启动、干净shell/父shell退出、modeld重启及需要的整机重启均读回同一批准配置；无需人工补shell env、临时故障注入或每次重新配模型。
- 已有file/env凭据解析和官方renewal都按本身权限工作；私钥不在argv/log/收据中。自定义凭据可用不替代官方身份读取认证，官方凭据失效不偷偷使用另一个服务的key。
- 每个listener/socket/process/helper由T25/T28精确标识，重复操作不多启进程；PID复用/错Host/旧receipt零错误signal。CLI退出不误杀长期服务，也不留无人管理的writer。
- 开始新managed TURN前读取T37新鲜身份；凭据/权限/所有权变更与配置切换分层，不重放上次未知STEP。status报告desired/实际加载/ready/执行证据差异，不把端口存在当已签字。
- 不以全局Compact GATE或canary筛选代替per-Bot正常启用；稳定状态下所有故障注入关闭。

### 单盒monitor的长期运行（T41）

[T41](T41-continuous-observation-and-alerting.md)承担采集/SQLite/incident程序，2026-09-13已有显式前台run、SQLite/本地changes及冷进程管理首片，入口见[持续观测](../maintainers/continuous-observation.md)。它没有安装服务或承诺残留锁恢复；本票只复用现有服务owner装配和生命周期：重启后一个collector、可读lastKnown但live证据待重新确认，CLI/网页退出不停止监控。collector的DB锁/满/迁移失败要可见，不重写产品配置或阻塞独立准入；停止/升级时有界退出事务/通知等待，保留unknown。

T41不等本票整票完成，本票服务实现也不等前端；**最终持续生产放行**加入V28–V30单盒最低闭环：变化/失去观察可查、incident处理持久、通知范围明确、网页不开仍运行。未配置外部渠道明确local-only；多盒和盒外失联监测/高级通知是future，不成为当前推理或普通发布的无限前置。

## 2. 两种回官方

### 日常官方选择

由T24的逐Botreset/official选择实现：bridge保持安装，未来TURN走原生session，其它Bot不变；活动回合正确结束或按原生策略等待，不改harness，不走Temporal。T39提供持久状态往返证据，本票不重新实现选择器。

### 完全未补丁Host

先停止受影响的新准入，列出在途/未知执行，按原生安全边界排空或隔离；确认原生状态可恢复、待退出进程身份和可信未补丁制品，再经T28同一控制程序执行。禁止手清circuit、伪造attestation、通用kill或通过强制清缓存回避失败。

回读验证：实际Host为未修改代码、补丁hook未参与、同一个官方登记box Bot的原生checkpoint/Memory/历史可继续，工具/SendToUser正常且无重复。旧bridge读取方法可能随卸载消失：必须在此之前明确无需该bridge的受支持原生读证据；缺读能力保留unknown，不把“接口不存在”误判成身份变更或卸载成功。

原生升级/resume-ownership可能涉及官方Box→Temporal受控迁移。我们不主动借迁移实现回官方模型，也不禁用/清除其hold。若本次操作确实改变官方归属，按实际身份记录为迁移/兼容性变化，不能记为“同Box会话无变化回滚”。迁移后的Server执行不再冒称受Host补丁控制。

## 3. 固定候选与有限放行

- 一次验证窗口固定source/未提交内容指纹、锁文件/工具链、实际preload/CLI/modeld、Host/profile与运行代。测试期间变化使受影响证据失效，不把多个候选的通过数相加。
- 独立review和真实使用试验分开；review必须绑定固定内容身份。没有review或缺必要live证据保持候选，不自签、不开全局生产。
- 只对具名批准Bot逐一启用。支持模型/协议/窗口/Host/App版本、凭据载入方式、未观测项和退出入口写 LIVE 对应条目，详细身份写日期报告；若用户要求的完整往返未齐不能改称已稳定。
- 失败按最早失败owner回票修复，再复验；outcome查询复用原nonce/TURN，不以新send探测旧请求是否完成。先保存证据，停止受影响准入，不隐式转官方或重试副作用。
- 客户端已确认记录不得被其它来源覆盖；App-only失败不能靠CLI成功放行。test2实际校准可经独立确认后进行，或明确保留；冲突阻断与防再引入仍是必须门。

## 3.1 本次候选核验的部署前问题（2026-09-12）

全仓首次实际执行为1132 pass / 1 fail，唯一失败是guardian停止恢复测试。该测试原先仅等/proc存在就捕获身份，也没有失败finalizer；已改成owned子进程自身ready后取身份，并在finally只恢复/回收自己创建的child，不扫描或信号其它进程。单测原先能单独通过，故不把这次全仓偶发失败的唯一根因武断归为exec竞态，更不宣称修复了原生guardian算法。新增9个原guardian-child代码的纯依赖注入反例（EOF/error/deadline只CONT一次，身份差异零signal）；原真实进程测试和这组均通过，已纳入control case，未放宽sameIdentity。

随后全仓1148 pass / 1 fail的窗口出现其它lifecycle源码/测试写入：前后指纹9096d9a5…→99947fde…，不能签固定候选；当时的唯一红项是`modeld-start-failure.test.ts`中stop超时无optional counters仍应报cleanup_gap，却返回成功。源码继续变化后该专项的直接复核被工具安全检查拦截，未经其它aggregate入口绕过；不能断言最新代码已修好或仍复现该红项。实现owner须固定最终字节并复核，不移除这条断言。

以上只证明这次运行过的scope；T25/T40其它并行修改不计成本轮作者的实现。没有新adopt、真实模型发送、业务进程停止或test2校准。首次失败前遗留fixture的清理状态未据新finalizer追认；只声明本轮修改后的用例具有其自身退出清理。

## 4. 检查与证据

### 已实现的前台服务子片：`service-lifecycle`

复用T25的`startModeldProcess`和原`runtime modeld run`，没有新增进程管理器：

- 启动的typed failure、defect、self-interruption都在资源Scope退出后结算ready；旧`tapError`漏掉后两类会使外部Promise永久等待。
- command signal贯穿启动及自有root生命周期；已取消不分配、启动中取消释放后拒绝。CLI复用已有signal owner并检查ready输出期间的取消，不再只等第二套进程信号监听器。
- stdout写ready失败仍释放owned service；borrowed服务从不被当前调用取消/停止。
- 停止等待超时即`cleanup_gap`，不能因未提供optional counters且release标志尚未变false就吞错报成功；稍后再次等待释放不回填此前超时回执。

上述8个真实反例先失败后修复通过；永久回归分别在`modeld-start-failure.test.ts`、`runtime-modeld-lifetime.test.ts`。`modeld-packaged-lifecycle.test.ts`实际启动Node `dist/index.js`、读取临时Unix health、第二Node只borrow退出、仅向本测试创建的owner发SIGTERM并验证干净退出；occupied非socket文件不覆盖。未使用真实Host/Server/provider/credentials，没有构造正式attestation来冒充推理ready。

`bun scripts/verify-runtime-rebuild.mjs service-lifecycle`已接同一runner，构建后执行source/Node制品子集并检查输入稳定性。通过支持前台资源/取消/失败合同，**不支持**`runtime start`完整准备入口、服务管理器安装/开机恢复、完整机重建、真实模型持久凭据、T37专项或原生卸载。本源码子片的固定输入/结果归本票及日期报告；对应现场缺口只在 [LIVE-RUNTIME-PERSISTENCE](LIVE-integration-validation.md#live-runtime-persistence)维护。

完整`service-release` case仍计划中，复用T25/T28/packaging/runtime-cli等测试；不将这个局部case改名为整票Done。最低有界场景：

| 场景 | required oracle |
|---|---|
| 干净启动/重启/重复start | 同一配置、凭据不泄漏、一个实例、无旧执行自动重放 |
| modeld失联/认证过期 | 诚实unavailable；官方其它Bot不退化，无隐式主模型fallback |
| 旧PID/错制品/竞态apply | 零错误signal；新鲜身份二次检查，失败receipt可对账 |
| 已有在途工具/未知终态时停用 | 不重复工具/消息，不假回滚，保留可恢复合法root |
| 日常回官方 | 单Bot选择改变，harness/store不变；不全局卸载 |
| 完全回未修改Host | 实际hook退场、原生状态恢复、App实际继续，旧bridge失效不伪证 |
| 官方身份变更/迁移窗口 | 复用原生pause/fence，不强留box，不错误放行新managed |
| 小范围生产/失败退场 | 只改批准Bot，日志不含secret/正文；真实支持矩阵/停止条件/receipt齐全 |
| monitor无网页/重启/DB异常 | 一个长期collector；lastKnown与live新鲜度分离、incident/ack持久；DB/通知故障不更改执行权或重放任务，范围明确local-only或批准渠道 |

源测试、实际packed、原生隔离、真实场景各自记录；进程测试仅允许受控disposable targets，真实主机重启等高影响行为在执行窗口明确范围，文档创建不是执行授权。

### 2026-09-13：借用服务必须确认数据根

补齐了一项真实启动前提：原来的`startModeldProcess/ensureModeld`只凭health成功就borrow，另一个durableRoot共用同一runRoot时会错误成功。新增反例先红后绿；现在用显式、无参数的v4 `service-info`查询核对服务声明的`rootId`（规范化durableRoot+runRoot摘要）后才borrow。匹配不停止原服务；不匹配返回`modeld_root_mismatch`，旧服务/缺失/无效声明返回`modeld_identity_unavailable`，不删socket、不启动竞争实例、不隐式换目录。原有health响应保持原形；rootId仅是部署范围诊断，不是鉴权、进程attestation或Bot归属证据。

新增11项source/protocol边界断言与实际Node制品的跨root拒绝；`service-lifecycle`在同一候选下为37/0。全仓/指纹/工具链及产物身份保留在相应固定输入的来源回执；现场候选和结果从 [LIVE](LIVE-integration-validation.md#live-runtime-persistence)进入。当前机器默认Bun已与packageManager不一致，verifier现在在运行任何测试/构建前验证实际child Bun版本，错误时零child并返回toolchain_mismatch。

该历史窗口尝试写入完整`command.runtime.ts`时被工具安全检查拦截，当时保留了占位；最新源码推进见下一节，不能继续把那次写入失败当成当前文件状态。该窗口未修改Server/Host/App或test2。停止超时旧红项经当时固定全仓复验；不能把该全仓结果继承给后续源码。

### 2026-09-13：`runtime start` 源码、CLI 与实际 Node 制品闭环

当前CLI已从占位改为调用同一个`command.runtime.ts/startRuntimeCommand`。该命令的Effect Scope拥有validate→root-qualified modeld acquire→唯一ConfigurationWrite保存desired→identity/route一次未确认reconcile→status→publish→owned前台等待→释放。observe不reconcile；不调用apply、不改Host或test2，不安装服务管理器；借用已有服务仅返回，不取得stop权。

route启动前复用128KiB/no-follow/regular-file ConfigurationRead检查canonical模型文件和有效assignment；配置不可读/非法时不创建listener或保存desired。新建服务打印的是ready/配置回执，不是退出或生产验收；输出包含`configRevision`、`modeld.kind`、`service.lifetime`、原reconciliation回执、status与`productionAccepted:false`。`autostartInstalled:false`表示本命令没有安装自启，不裁定外部manager的安装状态。

取消传入唯一命令signal，Scope在acquire尚未完成时也负责注册其返回资源的cleanup；已经开始的配置原子写在取消后先结算，不留脱离命令的后台写入，不伪造多资源rollback。取消发生在publish前是失败，在ready回执发布后可正常结束前台服务；output/status/reconcile失败仍停止本次owned服务，borrowed永不被停止；cleanup_gap不能吞成正常取消。

原POC `prepareRuntimeStart`和测试已被替换，不保留Boolean health猜borrow的第二路径。此前CLI复验受阻是历史，本批正常直接执行`test/runtime-start-lifetime.test.ts`的12项已通过。新增`runtime-start-packed.test.ts`在真实Node CLI进程中验证observe/identity/route的start→same-root borrow→SIGTERM→新进程启动；配置字节/配置revision保持，service generation改变，不构造Host attestation、不调用模型或adopt。另验证route坏配置不改已有desired、跨root拒绝不停止原服务。统一`runtime-start` verifier现包含typecheck/build及source、Unix、packed、status组合；固定指纹、数量与全仓结果留来源票/日期报告；本轮之后的现场采用与未验项只由 [LIVE](LIVE-integration-validation.md#live-runtime-persistence)维护。

前轮原生接点检索受阻；本批直接读取当前Host文件被限制在允许根外，未通过其它路径提取其正文，因此没有新增当前原生checkpoint/迁移接点资格。已有可读的私有历史启动研究不被升级为当前支持的boot hook。没有新Server快照、test2保全、profile发布、Host领养、模型请求或App修改。

### 已就绪后的服务丢失与状态一致性

`StartedModeld.finished`观察实际Effect root终态，完成点在Scope cleanup之后；borrowed句柄只代表本次借用结束，不拥有远端服务寿命。新建root等待真正listener的close/error，不再永远挂在`Effect.never`直到用户发下一次signal。非预期close/error分别报`modeld_listener_closed/modeld_listener_error`（不泄露底层异常文本）；正常signal先退订再释放，不把自身close误报失败。`runtime modeld run`与`runtime start`消费同一个finished；不可把已经发出的ready回执当作之后的命令成功。原有cleanup_gap语义保留，不自动重启或重放任何STEP。

`runtime status`显式消费调用方的GROKBOX_RUN_ROOT，同时保留未配置时的原观察adapter。真实modeld facet通过同一service-info判断当前durableRoot/runRoot匹配，增加scope与serviceEpoch：matched可ready，mismatch不ready，旧服务/坏身份/不可读路径为unavailable，真正缺少路径才not_observed。不会因另一目录中的健康服务把当前安装显示为ready；这些只是部署观察，不授予Bot执行权。源socket正反例、投影脱敏及packed启动回执均覆盖此边界。

## 5. 仓库与发布收口

沿用先前worktree审计：必要代码吸收、dirty/untracked与活跃引用保全、原生数据不入Git。阶段提交/最终清理使用工具明确支持的Git写入口；工具不支持时报告未执行，不以脚本绕过。主仓库Git数据和v2保留，不为“工作树数量归零”删除活动服务资源。

正常发行包只包含生产实现，自写fixture自包含；私有research和现场receipt留在私有仓库/受控空间。T40签生产前需必需证据合取和可执行退路；仅清理worktree不提高产品资格，未清理则如实记交付残留。

下一动作：前台start/borrow/orderly restart和失去listener的收尾已有source/Unix/packed子证明，不重复做占位修复。继续目标环境的受支持持久服务owner、安装/启动恢复和真实凭据推理回执，并与T37/T38当前原生资格、独立review、test2保全及T39原生checkpoint往返合流。tmux存在或本地PodDaemon历史机制可用不等于产品boot hook或跨recreate自启已证；不改官方wrapper/supervisor，不另建通用重启管理器，不用后台detach伪装安装完成。整票仍Open。

**2026-09-13 现场 start 借用：** `runtime start --mode route` 对当时 modeld REDACTED_PROCESS_ID 回执 borrowed / productionAccepted:false / autostartInstalled:false。

**本机服务主人（2026-09-13）：** Host REDACTED_PROCESS_ID 由官方 `sand-supervisor.mjs`（7076）拉起；modeld 与 Host 同为 pid 53 子进程，**不是** supervisor 孩子。user systemd 无 session bus（`$XDG_RUNTIME_DIR` 空），本命令不安装自启。circuit 仍 open/`pending-uncertain`（2026-09-08），禁止手清。

**modeld 受控重启：** SIGTERM REDACTED_PROCESS_ID 后从 `v2-a3a855f22af9` 拉起 PID **REDACTED_PROCESS_ID** / epoch `e97c91df-…`，Host 未信号、assignment 未变。随后 `runtime start` 再 borrowed；CLI nonce `af15ccfd-…` expected_result_observed。autostartInstalled 仍 false，不是开机恢复证明。

**核心 vs 停下（2026-09-13）：** 产品目标是确认 box Bot 走 grokbox 流程。test0 现役 Host 带 preload、assignment=grok-4.6，CLI/App 发送都能进 managed。官方 supervisor **不含** NODE_OPTIONS；Host 被它自行拉起时补丁会丢，需再 `re-adopt`——这是预期缺口，不为此改官方 supervisor。App 详情 echo/Cmd-Q 假失败、circuit、user systemd 自启、模型 B、owned-JSON checkpoint 探针都不挡这条主路径，先放一边。
