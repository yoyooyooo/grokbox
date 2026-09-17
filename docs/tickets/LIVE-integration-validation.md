# LIVE — Cross-worktree integration validation backlog

Status: **open, continuing process**. Individual entries close; this ticket remains available for later features. Created 2026-09-17. Default integration line: `feat/box-runtime-v2`.

本票是跨 worktree 的 **live-only 验收排程与结果唯一入口**，不是另一份实现 Spec、部署授权或当前线上健康证明。功能语义、代码缺口与验收标准仍归各来源 Ticket/Spec；来源票链接这里的稳定条目，不再复制另一份 live 状态表。npm 发布仍归 [release runbook](../maintainers/release.md)，Host/modeld 的发布合同仍归 [T40](T40-persistent-release-and-rollback.md)。

**默认先合入 v2，再选择固定集成提交、构建并成套切换 Host/profile/preload/modeld，集中验证同批兼容条目。未合入的 feature worktree 不为验收而轮流接管现役环境。** 本票只记录计划，不自动合分支、改 shim、切 profile、重启、领养、改 Bot 模型、发送消息或消耗模型额度。

## 哪些项目进入本票

只有需要真实原生组件、已加载制品、真实 Provider、原版 App、实际权限/迁移或重启恢复链才能取得证据的部分进入这里。源码检查、复制品转换、类型检查、合成故障注入、离线协议/打包回归、代码 Bug 和独立代码复审仍应在功能 worktree 完成；不能改名为“待 live”藏在这里。

可以先登记待集成条目，但**登记不代表实现、离线验证或复审已通过**。进入 `ready` 前必须解除来源票中的非 live 阻断；外部 reviewer 不可用同样是非 live 的 review blocker。仅有历史成功回执不自动取得新制品的资格。其他 worktree 只负责自己的来源条目，不替未检查的功能声明完成。

## 条目状态与并行编辑

| 状态 | 含义与进入条件 |
|---|---|
| `awaiting-integration` | 已登记 live 需求；尚未记录其在 v2 的实际集成映射，或尚未选定共同制品 |
| `ready` | 来源代码/离线复验/独立复审已满足；源提交已映射到固定 v2 提交；依赖、制品及本轮对象/额度/停止条件已确认 |
| `running` | 已授权窗口开始，记录实际加载身份与本轮唯一回执关联；失联不能保持虚假的“已完成” |
| `passed` | 本条全部 oracle 在指定制品/原生版本/策略下有证据；只对该范围成立 |
| `failed` | 已观察到违反本条 oracle 的结果；保留失败证据，代码修复回来源票或新的修复票 |
| `blocked` | 缺对象、权限、复审、受控输入或安全窗口，无法完成；缺证不是通过 |
| `needs-revalidation` | 制品、Host 原生版本、schema/wire、策略或相关接点变化，使旧回执不再覆盖当前候选 |
| `superseded` | 需求被明确替代/取消，记录替代条目和原因；不是验收成功 |

条目使用语义命名空间，例如 `LIVE-MODELD-AUTHORITY`、`LIVE-<feature>-<case>`，避免多 worktree 抢占全局 T 序号或重复的 `L01`。不要重排/复用已存在的 ID。合并同一条目的并发变更时保留双方来源和回执历史；冲突不采用整段 last-writer-wins。一个窗口由一个集成维护者更新运行状态，feature 作者仍维护其实现票。

## 登记模板

复制以下段落，填入最小但可执行的信息。未定值写 `not-selected` / `not-recorded`，不要补猜：

```markdown
<a id="live-feature-case"></a>
### LIVE-FEATURE-CASE — 要验证的行为
Status: awaiting-integration
- 来源：完整 Ticket/Spec 链接、source branch、固定 source commit/range；所需依赖。
- v2 映射：source → integrated commit（rebase/cherry-pick 时记录实际映射）；candidate commit / source digest；未定则 not-recorded。
- 必须 live 的原因：具体事实与 owner；哪些离线证据已取得、哪些非 live 阻断还在来源票。
- 环境与动作：native-isolated / installed-host / provider / app / restart；只读或会修改什么，受影响对象与前置状态。
- 预算与授权：窗口、目标、最多请求/费用/等待、允许的停止/写入、授权回执；未定时不得运行。
- 步骤与 oracle：可观察的成功和失败条件，逐层区分模型/工具材料释放/实际工具执行/投递/App。
- 停止与回滚：具体停止条件、恢复到哪个已验证制品/配置，以及恢复后的检查；不重放旧请求。
- 回执：时间、实际 artifact/native/wire/policy identities、结果和缺口，最小公开证据链接；原始私密证据只保留不含路径/凭据的引用 ID。
```

“source commit 在 v2 可达”可证明普通合并的包含关系；cherry-pick/rebase 后必须核对实际变更映射，不能只看分支名或旧 SHA。相同 source digest 也不替代原生 Host 版本、加载身份或本轮 canary 回执。

## 一次集成验收窗口

1. **选择与冻结。** 功能分支完成非 live 工作后合入 v2；固定集成提交并复跑受影响的组合测试。逐条核对来源映射、依赖和冲突；不能因一个分支全库通过就给合并后的组合背书。
2. **构建与预检。** 从同一候选构建并记录 CLI/preload 摘要、profile/source SHA、wire/schema/策略与依赖版本。准备上一份可用制品和配置回滚；离线预检不改现役 shim/profile，也不把磁盘新文件当作已加载。
3. **授权与成套切换。** 按所选条目确定目标、额度、排空与停止条件。只在该窗口由唯一操作者排空/切换，禁止复制旧 service epoch、内存许可或自动重放失败用户消息。原生版本升级是额外动作，不由“重建补丁”隐含授权。
4. **按依赖验证。** 先原生接点/官方 passthrough，再 managed 路径、资格/取消、实际工具消费与 App，最后重启和回滚。同一重启可以服务多条兼容需求，但每条单独下结论。需要不同原生版本、配置或破坏性迁移的条目另开窗口，不能一次重启全部打勾。
5. **回填与失效。** 记录实际而不是计划中的进程代/制品/结果。失败立即停止该范围，不扩大对象或额度；新缺陷回代码票。通过保留原回执，相关制品/原生接点变化时转 `needs-revalidation`，另加新回执。整个列表不会因一次部署成功而关闭。

所有 live 命令沿用来源 runbook 的真实命令面，不在本票创造 `verify --live-all` 或自动发布器。无消息 nonce、scope、profile、停止回执或 App 图像时，明确 `not-observed`；不能用标题、roster、日志最后一条或 Bot 自述拼成成功。

## 当前已登记：统一配置

<a id="live-config-cutover"></a>
### LIVE-CONFIG-CUTOVER — 实际配置迁移、服务采用与 home 恢复
Status: awaiting-integration — configuration source/packed lane verified; independent code review remains in T60

来源：[配置 Spec](../roadmap/configuration-rebuild-spec.md)、[T57](T57-unified-config-schema-layout.md)、[T58](T58-config-command-single-writer.md)、[T59](T59-config-migration-cutover.md)、[T60](T60-config-ops-integration-proof.md)，source branch `feat/template-ops-automation`，rebase 基线 v2 `f8c82c0`。来源提交与固定制品按集成窗口记录，当前 v2 映射/candidate 为 `not-recorded`。不得把含配置代码的 feature 分支直接指给现役 CLI/服务来代替集成。

离线已证明：严格 v2、真实临时文件/锁与死亡 owner 恢复、迁移各阶段中断、模型原字节/secret ref 保持、bootstrap 回退不得覆盖后来编辑、alias 保全恢复、prepared/ABA 不重放、desktop 精确应用收据、source/packed CLI 和 Host 选模依赖隔离。独立代码复审尚待，属于 T60 非 live 阻断；本条不代替它。

必须 live 的原因：当前服务的实际读路径、旧 writer 是否确已停止、source-backed shim 的切换、平台 Reset 的 home/durable 行为及既有凭据仍可用，不能从临时目录推导。当前环境/对象/停止权限/窗口均 `not-selected`，不执行 Bot、模型、Webhook 或 GitHub 探针。

步骤/oracle：

1. 固定 v2 候选与新旧 Node 制品；先核对本机 CLI 是源码 shim 还是安装包，并保留可以操作旧服务的固定制品。source shim 跟随工作区变化时，合入与迁移必须同一受控窗口安排，不能先让日常 CLI 因旧配置失效而失去恢复入口。
2. 保全当前配置、布局和 secret 引用证据，在明确授权下停止会写历史格式的 daemon/bootstrap/相关运行时角色。未能证实停写则阻断；不因为锁旧就删，不擅自停止用户 Bot 或 Host。
3. 用新制品 preview exact source/root/conflict plan，再批准 apply；检查 config/model canonical、home 别名、安装安全状态和旧文件退役。models 与 credentials 不被规范化重写，旧 explicit off/预算不被升级默认值覆盖。
4. 按批准范围启动新消费者，核对它实际采用的 domain revision、PID/start、模型路径与 Host/modeld 运行事实。配置 committed 与消费者 applied、Host loading 分别记录；不得因保存成功声称服务恢复。
5. home 别名恢复与平台 Reset 独立资格化。只有实际平台策略和回读证据支持时才声明对应持久性；未执行真实 Reset 就保留该向量 not_proven，不能为了补证清理用户 home。

停止/恢复：新旧 writer 并存、配置/别名冲突、source 变更、未知提交、模型或 secret 引用不一致即停止。按 migration/bootstrap 的精确 before/after 版本恢复，保留后续用户编辑及所有 unknown 回执；不重放用户消息、不自动回滚官方 Host。恢复后重新检查真实消费者，未验证则报告 blocked，不靠 doctor 单项绿代替全部结果。

回执：本条未运行。预算/授权、实际 source/artifact/installation/process identities 和各 oracle 结果在窗口后回填；原始私密配置与令牌不进入仓库。

## 当前已登记：modeld Effect core

以下条目只登记本轮实际未取到的原生/live 证据；并不表示其他并行功能没有 live 需求。共同来源是 [Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core)、[T47](T47-modeld-authority-state-machine.md)、[T48](T48-modeld-causal-observation.md)、[T49](T49-modeld-qualification-and-release.md)。Source branch `feat/modeld-effect-core`，核心候选 `6d0e914`，deadline 收口 `743daea`；后续复审修复由 T49 的当前候选记录追加。

**共同集成状态（2026-09-17）：** 已按用户明确指令线性合入 v2：原分支 `967b409` 的十一项提交变基到 v2 `36e6dc5`，再将 v2 快进到 `b57574844428219ead9b9ee18dce90ad3c8535fc`。核心/期限提交映射为 `6d0e914 → ce942f2`、`743daea → e6c5bf5`；全部映射、组合树验证和测试制品摘要见 [v2 集成回执](../reports/2026-09-17-modeld-v2-integration.md)。该组合树已重新通过类型检查、全库与制品离线验证，不沿用旧分支的测试计数。

**共同阻断与授权状态：** T49 G5 仍为 `review_pending`，其非 live 代码复审义务留在来源票，不因本次合入而豁免。live 目标、请求/费用上限、窗口与变更许可均 `not-selected`；实际加载 artifact/native identities 仍 `not-recorded`。因此六条进入 `blocked`（集成已完成，复审/原生窗口未满足），没有任何 live 运行或通过回执。下次部署必须固定当时的 v2 提交并核对是否仍覆盖本回执；五秒策略未放宽。

| 条目 | 所需现实 | 依赖 |
|---|---|---|
| [LIVE-MODELD-NATIVE](#live-modeld-native) | 固定官方 Host，三路隔离对照 | 集成候选与原生测试对象 |
| [LIVE-MODELD-CUTOVER](#live-modeld-cutover) | 实际加载的 Host/profile/preload/modeld | NATIVE |
| [LIVE-MODELD-AUTHORITY](#live-modeld-authority) | 原生取证、暂停/失效与取消 | CUTOVER |
| [LIVE-MODELD-TOOLS](#live-modeld-tools) | 审批后实际工具消费者 | AUTHORITY |
| [LIVE-MODELD-APP](#live-modeld-app) | 真实 Provider、原版 App 的同会话投影 | CUTOVER；工具展示依赖 TOOLS |
| [LIVE-MODELD-RESTART](#live-modeld-restart) | 重启、旧代隔离、回滚恢复 | 上述基本路径通过 |

<a id="live-modeld-native"></a>
### LIVE-MODELD-NATIVE — 原生接点与三路对照
Status: blocked — mapped to v2; T49 review and authorized native window pending

来源：T43/T45/T49，当前 [原生覆盖审查](../maintainers/modeld-authority-boundaries.md)。必须读取/运行固定原生版本；合成的 `allowed/bound` 或 source-shaped fixture 不能证明原生 per-Agent/per-TURN 授权覆盖。优先在隔离原生环境比较未补丁官方路径、补丁官方 passthrough、补丁 managed 路径；不为对照反复抢占现役环境。

步骤/oracle：核对 source/profile 接点唯一匹配与 local-only 实际能力；官方 passthrough 不增加 managed List/Provider/工具副作用；managed 只取得白名单身份字段，本地暂停/未绑定/代变化不能被注册缓存盖掉。旧 Host 不具备 local-only 能力时明确拒绝，不拿完整旧快照冒充当前本地事实。缺固定原生输入或消费者观察点则 `blocked`，不把 fixture 代入后签通过。

预算/回滚：对象、原生输入与允许动作在窗口中指定；未经授权不迁移账号/Bot、不升级官方二进制。接点不匹配即停止，清理本次隔离资源，现役保持原状。回执须分别保留三路事实与具体未证明项。

<a id="live-modeld-cutover"></a>
### LIVE-MODELD-CUTOVER — 成套加载与版本身份
Status: blocked — mapped to v2; T49 review and authorized native window pending

来源：T44/T49、[T40](T40-persistent-release-and-rollback.md)。磁盘构建通过不足以证明进程已加载。依赖 NATIVE 后，从固定 v2 候选排空并切换 Host/profile/preload/modeld，读取实际加载的 generation、源码/制品摘要和协议。

Oracle：新协议一致、`doctor`/运行状态无阻断，旧 peer 只有有限只读诊断能力，不能承接 managed STEP；CLI→modeld 比较不冒充 Host 已加载同版。目标外 Bot、账号和配置不被改动。任一代、scope、profile 或执行能力未知即停止扩大验证。

预算/回滚：一次经批准的切换窗口和明确旧制品备份；加载或核验失败恢复该备份并重新核对服务身份。回执列出计划和实际加载结果，不能只记录启动命令退出码。

<a id="live-modeld-authority"></a>
### LIVE-MODELD-AUTHORITY — 原生取证恢复与取消
Status: blocked — mapped to v2; T49 review and authorized native window pending

来源：T45/T47/T49。离线已证明慢首次读取后重新获取新鲜证据、共享等待者取消、总期限与同 STEP 不重推理；这里补实际 Gateway/native source 的生命周期证据。依赖 CUTOVER。

步骤/oracle：在专用对象上进行一次正常 managed 请求；在经批准的可控延迟/取消环境观察首次取证失败后有界恢复，同 STEP 原身份不变，模型最多按已批准策略调用，资格恢复不增加推理次数。显式 native pause、作用域/Host 代失效应阻断新动作；已终止旧 TURN 不因随后 box 观测复活。对不合作 source 保留实际占用/未知结算，不把 waiter 结束当远端已停止。

预算/回滚：延迟/暂停/身份变更只能作用于批准的测试对象；不能为复现改整机网络或真实业务 Bot 归属。无安全注入点时该向量 `blocked`。达到次数/时间上限、重复模型调用、未知副作用即停止并恢复对象前置状态；不重发历史失败消息。回执关联 source/read/waiter/STEP 与真实停止结果，不猜网络或服务端因果。

<a id="live-modeld-tools"></a>
### LIVE-MODELD-TOOLS — 审批等待后的实际工具消费
Status: blocked — mapped to v2; T49 review and authorized native window pending

来源：T47/T49、[Host 主链](../maintainers/host-inbound-agent-loop.md)。modeld 的材料放行并不证明原生工具执行，尤其不能代替长审批等待后的最后一道原生门。依赖 AUTHORITY。

步骤/oracle：使用批准的无破坏性测试工具和临时标记，分别验证正常消费、等待跨证据窗口、等待时暂停/取消/换代。已失效上下文不得新增执行；正常情况仅一个实际标记写入，重复 STEP 不产生第二次工具副作用。分别核对模型调用、材料释放、审批、原生消费者执行、结果入库和投递，缺哪段就保留哪段缺口。

预算/回滚：测试工具种类、次数、临时路径与审批操作者预先指定；不使用真实业务工具。任何越界执行立即阻断发布并回来源修复票，不能降低为 UI 遗留。清理仅限本次临时标记；外部副作用未知时不宣称回滚成功。

<a id="live-modeld-app"></a>
### LIVE-MODELD-APP — 真实模型与原版 App 状态
Status: blocked — mapped to v2; T49 review and authorized native window pending

来源：T48/T49、[观测 runbook](../maintainers/run-outcome-observation.md)、[Working 语义](../maintainers/composer-working-status.md)。真实 Provider 的终态、App 消息发送确认、当前 session 与侧栏聚合状态各有独立 owner。依赖 CUTOVER，含工具情况依赖 TOOLS。

步骤/oracle：对指定模型和 Bot 发送新的有 nonce 测试请求，核对模型身份、实际调用数、最终内容和投递；原版 App 中等待/取消/失败/完成与当前会话对应，资格控制帧不变成模型文本。侧栏子任务 Working 与父回合分别核对，不强写 `running=false`。429 等真实上游故障保持其分类，既不能算请求成功，也不能误归为失权。原来的未发送黏底消息不自动重发或删除。

预算/回滚：请求数、Token/费用上限、模型和结果 oracle 在窗口内批准；没有额度不默认执行。观察结束后核对测试任务确已退出；不为改善展示升级 App 或清空缓存。回执包含发送确认、对应 STEP、原生终态与 App 实际观察范围，不能凭截图或 Bot 自述替代服务端证据。

<a id="live-modeld-restart"></a>
### LIVE-MODELD-RESTART — 旧代隔离与恢复退路
Status: blocked — mapped to v2; T49 review and authorized native window pending

来源：T44/T46/T49、[官方回退验收](../maintainers/official-rollback-acceptance.md)。离线临时进程/LevelDB 已证明所有权与防重放；现役的 supervisor、已加载 Host、配置和 App 恢复需要组合回执。依赖同窗口基本路径通过。

步骤/oracle：按授权计划分别验证正常退出/重启和回滚；旧 service epoch、旧内存许可、已终止 STEP 不被重接续，不因缓存冷启动重新选模型或重复执行。恢复后只以新测试请求验证当前路径；确认先前子任务和源读取的结算/未知状态，没有留下无主监听。回滚到已选定旧制品不等于 full-unpatched exit，后者必须单独按官方回退合同验收。

预算/回滚：重启范围、次数、排空时限、旧制品及配置恢复目标预先固定。无法确定旧 owner 已退出、数据库独占、旧请求状态或实际加载版本时停止，保持明确的失败/未知回执；不删执行账本来解锁，不复制旧许可到新代。

## 当前已登记：ownership evidence availability

来源：[AUTH — ownership evidence availability](AUTH-ownership-evidence-availability.md)、[Spec S10.4](../roadmap/box-runtime-impl-spec.md#modeld-effect-core)。Source branch `feat/ownership-evidence-availability`，固定实现提交 `90346bb2bd72b44b345eb4752d730c7922d8e809`，基于v2 `f8c82c0`。Source digest `a6eb9fb9ab63052fa22504639c6c529b3301d26c383b817178063bd44496dceb`；preload digest `c00484cf80649b95e920efea862cb744f800b8151942a8d2f050705eea2e6f4d`。当前策略为`strict-observation-v2`，执行wire仍为v6；未知旧组件组合不因wire编号相同自动取得资格。

共同集成回执（2026-09-17）：按用户明确指令，v2从`f8c82c0abdf2fc16ed54c1d2af559920e6fb8320`快进到`8760d3a09bd36975cf65192585ba0ba3daabc0e5`；实现提交`90346bb`与文档提交`8760d3a`均原哈希保留，无rebase、冲突、squash或merge commit。该v2候选已重新通过类型检查、重建release-offline（514通过）和全库（2088通过、6项原生默认跳过、0失败）；精确映射、源码/制品摘要与证据范围见[AUTH集成回执](AUTH-ownership-evidence-availability.md#v2-integration-receipt)。

共同阻断与授权状态：源码集成已完成，但本次实际live候选/loaded身份、目标、窗口、请求/费用上限与切换授权仍为`not-selected`/`not-recorded`。固定原生源码复制品/隔离片段的历史回执不证明当前实际加载或原版App/最终工具消费者。独立固定提交复审及一次未定因的历史全库测试异常仍在AUTH/T49中记录，不搬成live-only残留，也不因本轮全库通过而宣称根因已修复。下列三条转为`blocked`（已集成，复审/原生资格与授权窗口未满足），均未执行，无live通过回执。下一窗口必须固定当时的v2候选并复核包含关系和制品身份，不能从源码快进推定已经部署。

<a id="live-auth-availability-native"></a>
### LIVE-AUTH-AVAILABILITY-NATIVE — 已加载策略、真实取证与失效
Status: blocked — mapped to v2; independent review, native qualification and authorized window pending

- 来源与依赖：AUTH实现提交`90346bb`；依赖本次固定候选上的`LIVE-MODELD-NATIVE`、`LIVE-MODELD-CUTOVER`语义资格。v2 source→integrated映射为`90346bb → 90346bb`、`8760d3a → 8760d3a`，已离线复验的集成tip为`8760d3a`；实际live候选及loaded identity仍`not-selected`/`not-recorded`。
- 必须live的原因：已测试的native源码锚点、隔离retry/compact片段和模拟List不能证明实际Gateway读取生命周期、当前scope/native暂停状态或正在运行的Host/modeld加载了v2策略。
- 环境与动作：优先使用隔离原生环境；现役只在批准的单个测试Bot与成套制品上操作。先读实际loaded Host/profile/preload/modeld身份、wire与policy，核对非目标Bot和官方passthrough不受影响。
- 步骤与oracle：在安全、批准的延迟注入点验证2.5–4 s读取跨多个检查点时同STEP复用；新STEP不继承超过2 s的跨STEP缓存，原始证据不超过5 s。首次慢读可在原10 s累计预算内取得另一份新鲜证据；持续超龄仍拒绝。检查本地pause/unbound、scope/Host代变化和共享等待者取消，已观察失效不能被稍后ready结果复活；不合作source仍保留占用至实际结算。关联operation/waiter/STEP与模型实际调用数，不用标题证明授权。
- 预算与授权：目标、最多请求/费用/总等待、允许的暂停/取消及恢复动作均`not-selected`，没有授权不得运行。不为复现改整机网络或业务Bot归属；缺安全注入点则该向量`blocked`。
- 停止与回滚：身份不明、原始年龄续期、越权或重复模型调用、资源无法有界收敛即停止；按窗口预选的已验证制品与测试对象原状态回退，不复制旧permit/service epoch或重放旧消息。
- 回执：`not-run`；须记录实际native/artifact/wire/policy、测试输入、逐向量结果、source真实停止/未知结算与回滚检查。磁盘构建摘要不代替loaded身份。

<a id="live-auth-availability-tools"></a>
### LIVE-AUTH-AVAILABILITY-TOOLS — 长审批后的原生工具执行门
Status: blocked — mapped to v2; independent review, native qualification and authorized window pending

- 来源与依赖：AUTH实现提交`90346bb`；依赖上条NATIVE及`LIVE-MODELD-TOOLS`的当前候选资格。实现已按原哈希`90346bb → 90346bb`集成，离线复验tip为`8760d3a`；实际live候选及loaded identity仍`not-selected`/`not-recorded`。
- 必须live的原因：离线已验证模型只调用一次、工具材料检查点、等待/过期/失效与终态；modeld释放材料不等于原生消费者在审批后重新检查了权限。
- 环境与动作：指定批准的无破坏性测试工具、临时标记和审批操作者；分别验证正常消费、审批跨5 s证据窗口，以及审批中暂停/取消/换代。不得用真实业务工具代替。
- 步骤与oracle：分别记录模型调用、材料释放、审批、最后执行门、实际标记写入、结果入库与投递。有效上下文只执行一次；失效上下文不再新增工具副作用；同一STEP或已关闭TURN不能被重放。原生per-Agent/per-TURN覆盖不足仍作为阻断，不能用allowed/bound两布尔值或缓存快照签署通过。
- 预算与授权：工具、路径、次数、等待上限、审批人和变更许可均`not-selected`；不自动调用。
- 停止与回滚：任何失效后执行、重复副作用或无法关联消费者身份即停止并回来源修复票；仅清理本次批准的临时标记，外部结果未知不得宣称回滚成功。
- 回执：`not-run`；缺哪一段消费者证据就保留哪一段，不能仅凭模型响应或材料释放成功关闭本条。

<a id="live-auth-availability-app"></a>
### LIVE-AUTH-AVAILABILITY-APP — 原版App的等待、拒绝与下一步提示
Status: blocked — mapped to v2; independent review, native qualification and authorized window pending

- 来源与依赖：AUTH实现提交`90346bb`；依赖NATIVE，涉及实际工具的展示同时依赖TOOLS；实现已按原哈希`90346bb → 90346bb`集成，离线复验tip为`8760d3a`；实际live候选及loaded identity仍`not-selected`/`not-recorded`。
- 必须live的原因：新字段已通过真实fixture Unix/Host/journal/SQLite冷读/CLI投影验证；原版App实际渲染、消息确认及真实Provider调用/费用仍属不同事实源。
- 环境与动作：批准的单个Bot、模型和新nonce测试消息，核对当前session/STEP，不自动发送或删除历史失败消息。
- 步骤与oracle：等待不显示为已完成或模型正文；stale/read_elapsed、后续过期、permit过期、预算耗尽、真正temporal与访问拒绝可按有记录的原因区分，未知历史原因不补猜。stale不声称归属已变，访问拒绝不误指向模型Provider，建议不默认重启Host或刷新title。已发起模型/已释放工具的事实保持准确，终态只有一次；完成、投递与侧栏子任务Working各自核对。
- 预算与授权：模型、请求数、token/费用、最大等待及允许动作均`not-selected`；不得为了验证提示无限重试或升级App/清缓存。
- 停止与回滚：发生错误身份关联、控制帧冒充模型输出、误导性的零调用/自动重放提示或越出预算即停止；保存脱敏回执，按NATIVE窗口的既定制品退路恢复，不重播旧任务。
- 回执：`not-run`；记录实际artifact/native/policy、发送确认、对应STEP、Provider与Host终态及App观察范围。原始截图/日志和私密身份只保留受控引用，不进入公开仓库。

## 已完成回执

暂无 **live 验收**回执。v2 源码集成与组合树离线回执已记录在上方，但没有选择/加载 live 制品或执行 live 窗口。后续逐条追加带固定候选、时间、结果、证据范围和失效条件的回执；源码合入、构建成功或一次重启不能变成“全部 live 通过”。
