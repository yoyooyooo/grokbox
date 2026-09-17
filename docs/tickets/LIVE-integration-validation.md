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
### LIVE-CONFIG-CUTOVER — 实际配置迁移与入口切换
Status: blocked — integrated into v2; independent review and an authorized live cutover remain pending

来源：[配置 Spec](../roadmap/configuration-rebuild-spec.md)、[T57](T57-unified-config-schema-layout.md)、[T58](T58-config-command-single-writer.md)、[T59](T59-config-migration-cutover.md)、[T60](T60-config-ops-integration-proof.md)，source branch `feat/template-ops-automation`，最终 rebase 基线 v2 `6f2fcd1`，实现提交 `80fe393`（初始实现 `dbc43f5` 的 rebase 映射）；[配置收口回执](../reports/2026-09-17-unified-configuration-closeout.md)保存 source/packed 验证与未放行项。2026-09-17 实际集成：v2 从 `6f2fcd1` 快进至 `efa6557`，实现映射 `80fe393 → 80fe393`、live 登记 `efa6557 → efa6557`，零 merge commit。合入后的 v2 已重新通过配置专项 200/0 与制品专项 15/0，详见 [v2 集成回执](../reports/2026-09-17-config-ops-v2-integration.md)。这是离线集成候选；实际 live candidate/loaded identity 仍 `not-selected`/`not-recorded`，独立复审和授权窗口未满足，不能转 ready。

离线已证明：严格 v2、真实临时文件/锁与死亡 owner 恢复、迁移各阶段中断、模型原字节/secret ref 保持、bootstrap 回退不得覆盖后来编辑、alias 保全恢复、prepared/ABA 不重放、desktop 精确应用收据、source/packed CLI 和 Host 选模依赖隔离。独立代码复审尚待，属于 T60 非 live 阻断；本条不代替它。

必须 live 的原因：现役配置来源、旧 writer 是否确已停止、source-backed shim 的实际采用及既有凭据仍可用，不能从临时目录推导。消费者的持续采用/重启另由 [LIVE-CONFIG-CONSUMERS](#live-config-consumers) 取证，平台 Reset/home 重建另由 [LIVE-CONFIG-HOME-RESET](#live-config-home-reset) 取证；本条成功不代替它们。当前环境/对象/停止权限/窗口均 `not-selected`，不执行 Bot、模型、Webhook 或 GitHub 探针。

步骤/oracle：

1. 固定 v2 候选与新旧 Node 制品；先核对本机 CLI 是源码 shim 还是安装包。源码 shim 跟随 v2 时，Git 快进就会使下一次 CLI 调用读取新代码，但既有进程不会因此自动切换；不得把“未修改 shim 文件”说成“日常 CLI 行为不变”。只获准源码集成而未获准 live 迁移时，明确披露旧配置可能触发 config_migration_required，保留旧提交与恢复路径，并确认新制品的 config path/validate/migrate 不依赖普通 Profile 初始化。生产迁移窗口内再保全可以操作旧服务的固定制品，不因合入而隐式停写/重启/迁移。
2. 保全当前配置、布局和 secret 引用证据，在明确授权下停止会写历史格式的 daemon/bootstrap/相关运行时角色。未能证实停写则阻断；不因为锁旧就删，不擅自停止用户 Bot 或 Host。
3. 用新制品 preview exact source/root/conflict plan，再批准 apply；检查 config/model canonical、home 别名、安装安全状态和旧文件退役。models 与 credentials 不被规范化重写，旧 explicit off/预算不被升级默认值覆盖。
4. 按批准范围启动新消费者，核对它实际采用的 domain revision、PID/start、模型路径与 Host/modeld 运行事实。配置 committed 与消费者 applied、Host loading 分别记录；不得因保存成功声称服务恢复。
5. 记录迁移完成时的初始配置/模型/secret 引用与消费者快照，把后续持续采用/重启交给 CONSUMERS，把真实平台重置交给 HOME-RESET；没有执行相应流程就保留其 not_proven，不能为了补证清理用户 home。

停止/恢复：新旧 writer 并存、配置/别名冲突、source 变更、未知提交、模型或 secret 引用不一致即停止。按 migration/bootstrap 的精确 before/after 版本恢复，保留后续用户编辑及所有 unknown 回执；不重放用户消息、不自动回滚官方 Host。恢复后重新检查真实消费者，未验证则报告 blocked，不靠 doctor 单项绿代替全部结果。

回执：本条未运行。预算/授权、实际 source/artifact/installation/process identities 和各 oracle 结果在窗口后回填；原始私密配置与令牌不进入仓库。

<a id="live-config-consumers"></a>
### LIVE-CONFIG-CONSUMERS — 现役消费者采用、重启与模型路径
Status: blocked — integrated into v2 at efa6557; T60 review, CUTOVER and an authorized consumer window remain prerequisites

- 来源与依赖：[T58](T58-config-command-single-writer.md)、[T60](T60-config-ops-integration-proof.md)、[配置指南](../configuration.md)，实现 `80fe393`，分支 `feat/template-ops-automation`，基线 `6f2fcd1`；依赖 CUTOVER 已通过。actual live candidate/loaded identities 为 `not-selected`/`not-recorded`，独立复审仍归 T60。
- 必须 live 的原因：临时 daemon 测试不能证明当前服务采用了哪个配置根、revision 和制品；模型文件原字节不变也不能证明现役 Host/provider 仍能读取同一凭据。
- 环境与动作：固定安装与一个经批准的测试对象。先只读核对 source/packed CLI、daemon PID/start、domain revision、Host/modeld 实际身份、canonical 与别名，正常业务 Bot 不改模型。需要配置变更、服务重启或 provider 请求时另固定具体字段、对象和预算。
- 步骤/oracle：用不会扩大权限或回收范围的明确测试变更验证 committed 与真实 applied；无消费者回执时保持 pending，重启策略保持 restart-required，不隐式启动消费者。按授权正常重启 daemon/modeld 后，证明读取的仍是新根，无旧 writer 重新创建历史配置。client/desktop 的无关修改不能改变实际模型分配/当前 TURN 捕获；经批准的新测试请求需分别证明凭据解析、实际模型、最终投递，不靠 health 或文件存在自证。
- 预算与授权：配置字段、目标、每种重启次数、请求/token/费用、等待上限和原状态均 `not-selected`。没有模型额度时可先验证文件/进程路径，provider 与用户交付向量保留未证。
- 停止/恢复：错根、旧 writer 复活、错误应用回执、模型/凭据变化或未知操作即停止；恢复本次字段时先核对版本，不覆盖后来的用户编辑，不重放旧消息或全局解除 circuit。
- 回执：`not-run`；保存实际 consumer/version/domain revision 与有限测试结果。配置、进程、provider 和 App 证据分别记录，不能用一次 restart 关闭所有向量。

<a id="live-config-home-reset"></a>
### LIVE-CONFIG-HOME-RESET — 平台 Reset 后的 durable、别名和凭据
Status: blocked — integrated into v2 at efa6557; platform/reset proof requires a separately authorized disposable Box

- 来源与依赖：[T59](T59-config-migration-cutover.md)、[T60](T60-config-ops-integration-proof.md)，实现 `80fe393`；依赖 CUTOVER 和 CONSUMERS 的相关基本路径。实际候选、平台版本、测试 Box 与 reset 授权均 `not-selected`。
- 必须 live 的原因：平台 Reset 究竟保留哪些挂载、如何重建 home、何时运行 bootstrap，以及客户端 home secret 是否存续，不能由本机临时目录模拟来证明。
- 环境与动作：只在明确授权、可丢弃且不承担用户任务的 Box 执行真实平台重置；禁止以删除生产 home 代替。预先记录不含密钥原值的配置/模型摘要、secret ref 可用性、别名和启动 owner。
- 步骤/oracle：Reset 前后对比 durable config/models/secrets、home config/models 别名与 installation identity；bootstrap 幂等修复缺失别名而不覆盖 detached 编辑器内容，不重新生成第三配置或放大权限。确认旧 off/预算保持；恢复后的 grant/绑定需按来源合同复核，不因备份复活。模型 secret 与客户端连接 secret 分开验证，任一丢失明确报缺失而非默回官方模型。
- 预算/停止/恢复：一次 reset 的对象、平台调用权限、备份与回收计划须先固定；保留性或身份不符合预期即停止部署推广，恢复仅限本测试对象。不将容器重启或 daemon 重启当作平台 Reset。没有安全 reset 条件时本条保持 blocked。
- 回执：`not-run`；平台/实际挂载事实、bootstrap 日志的安全摘要、前后 digest 和凭据可用性结果按向量记录，无重置就无持久性成功声明。

## 预登记：运维闭环后续原生验收

以下只预登记明确需要原生/外部系统的最终 oracle，**不是把未实现代码移交为 live 待办**。来源为已提交的 [运维 Spec](../roadmap/template-ops-automation-spec.md) 与逐票合同，规划基线 `52e76eb`、配置实现 `80fe393`；各功能的执行实现提交仍 `not-recorded`。T43–T56 的实现、离线/打包验证和独立复审继续在来源票完成；未满足之前均 blocked。规划与配置代码已随 `efa6557` 原哈希进入 v2，实际业务实现提交仍未记录；Git 合入不会将这些状态改为 ready。

<a id="live-ops-routines"></a>
### LIVE-OPS-ROUTINES — Agent/Routine 原生 CRUD、Payload 与模板隔离
Status: blocked — T43/T46/T53 implementation and offline qualification required before native execution

来源：[T43](T43-native-webhook-contract.md)、[T46](T46-template-ops-pairing.md)、[T53](T53-agent-routines-cli.md)、[Spec §10.2](../roadmap/template-ops-automation-spec.md#routine-e2e)。待实施提交/实际 candidate/窗口 `not-recorded`/`not-selected`。

原生步骤：经发布 Node CLI 创建一次性 Bot → 创建 disabled Webhook Routine → 读回并显式 enable → 真实 HTTP POST 合成 probeId → 关联原生 run/收到的 Payload/用户报告 → 更新同一 Routine 并再次 POST → disable 与安全清理。另验证两个模板导入实例的 endpoint/secret/绑定不互相继承。认证、Payload 编码/大小、原生响应层级与禁用语义分别取证；不得用 sendPrompt 或 mock handler 冒充 Webhook。

预算与停止：另行批准测试 Bot 数、每个 probe 请求/模型费用与清理范围；超时先对账，不重复创建对象。发现错对象、secret 泄漏、跨实例触发即停止。disable 不等于取消在途任务，只有本次回合及子任务退出才删除本次确实拥有的 Routine/Bot；清理失败保留 cleanup_required。回执 `not-run`，无公开 secret/真实对象标识。

<a id="live-ops-receivers"></a>
### LIVE-OPS-RECEIVERS — custom 选模、多 Bot 分流与有界交接
Status: blocked — T45/T47/T54/T55 implementation and receiver qualification required

来源：[T45](T45-template-webhook-delivery.md)、[T47](T47-bounded-ops-diagnosis.md)、[T54](T54-ops-targets-and-routing.md)、[T55](T55-custom-receiver-delivery.md)，依赖 ROUTINES；实施提交与 live candidate 尚未记录。

原生 oracle：使用批准的低成本/分析 Bot 与可选备用，核对 Webhook 回合真实捕获的模型、供应商、工具权限和数据同意；普通聊天 custom 成功不能替代。验证单目标默认、按 intent 分流、一层 needs-analysis 交接、可选集中报告和配置更换需重绑。ACK 丢失/已接受无回复不能自动广播备用；重复、备用和集中报告均计入同安装/同 Bot 总预算。最小提醒不得触发深诊断，模型配置不因通知失败被修改。

预算/退路：提前固定各 Bot/模型、消息与 token/费用总额、备用数据去向；身份或原生选模无法关联即停止该 lane，保留 not_proven。不得故障注入生产 provider 或强修接收者。取消/撤销只按已授权本次工作处理，不取消 Bot 的无关业务。回执 `not-run`；没有原生工具隔离证据就不能宣称安全自动诊断。

<a id="live-ops-observer-lifetime"></a>
### LIVE-OPS-OBSERVER-LIFETIME — 持续观察、无人值守提醒与服务故障
Status: blocked — T44/T45/T46/T50 implementation and installation qualification required

来源：[T44](T44-host-ops-continuous-sensing.md)、[T45](T45-template-webhook-delivery.md)、[T46](T46-template-ops-pairing.md)、[T50](T50-template-ops-release-proof.md)，依赖 CONSUMERS/ROUTINES。实际实现提交、服务宿主、候选及窗口尚未选定。

原生 oracle：使用该平台支持的真实服务 owner，关闭网页并结束启动 Bot 回合后，observer 仍持续采样；无变化零模型唤醒，确证用户影响且不可安全自修才一次短提醒。验证 restart/断网/endpoint 撤销/观察库不可用后的 source cursor、欠账、去重、预算与 degraded 状态，不因观察失败阻断现有推理或自动清 Host circuit。真实 native 用户交付与本地 outbox/HTTP accepted 分开确认。

预算/退路：采样窗口、允许停止的 grokbox 自有服务、请求/费用、离线演练与恢复计划均须另行批准。不得改变官方 supervisor 或令生产 Box 故障来证明监测。整个 Box 离线无独立外部观察者时不承诺自我告警；恢复后对账也不等于实时送达。回执 `not-run`；本条不拥有未实现的服务生命周期代码。

<a id="live-ops-issue-publishing"></a>
### LIVE-OPS-ISSUE-PUBLISHING — 原生用户确认与 GitHub 真实提交
Status: blocked — T52/T56 implementation, trusted consent and an authorized test repository required

来源：[T52](T52-consented-support-issues.md)、[T56](T56-scripted-issue-publishing.md)、[Spec §5.2](../roadmap/template-ops-automation-spec.md#issue-automation)。默认提醒/草稿无需 GitHub 凭据；Fake Publisher 的无授权零写、脱敏、重复/unknown 等测试仍归来源票，实际实施提交/候选 `not-recorded`。

外部 oracle：核实原生用户回复可与自动事件可靠区分；对已经展示的 exact 仓库/作者/可见性/标题/正文确认后，由发布 Node CLI 提交并读回实际 issue ID/正文。限定 public-summary grant 单独验证有效期/事件类/额度与撤销，不能借逐份确认的结果关闭。跨 Bot 重复确认仍对应一个 submission。仅在安全代理或专用测试环境允许注入 ACK 丢失时验证真实创建未知后的对账，不盲重发 POST。

预算/退路：指定专用测试仓库、可公开的合成摘要、作者、最多 issue 数、可执行的清理动作；**本次 AH-99/AH-100 人工关闭不构成本功能的发布资格**。无批准仓库时只做本地/Fake，生产项目不被测试写入。真实 issue 关闭/删除或追加评论也须在清理授权范围内。安全分类/正文/目标不符即停止，保留 unknown 与已知引用；回执 `not-run`。

<a id="live-ops-maintenance"></a>
### LIVE-OPS-MAINTENANCE — 真实安全屏障、Bot 交接和退出补丁
Status: blocked — T47/T48/T49/T50 implementation, independent review and explicit mutation window required

来源：[T47](T47-bounded-ops-diagnosis.md)、[T48](T48-low-risk-host-qualification.md)、[T49](T49-policy-host-maintenance.md)、[T50](T50-template-ops-release-proof.md)，依赖配置/原生接点和接收者相关 lane。实际执行提交、维护 grant、制品、停止权限及候选 `not-recorded`/`not-selected`。

原生 oracle：先证明当前平台存在经资格化的暂停/排空或等效 admission fence；Bot 持久交接后先终结本回合及相关子任务，唯一 controller 才执行已预授权、已资格化计划。busy、待审批、新任务撞屏障、授权撤销或原生换代应延后/拒绝，不忽略提出者。一次同代对齐与一次安全退出分别验证真实 loaded tuple/未注入官方路径/后续新回合，不在同 STEP 换供应商或重放工具。退出未知保持 rollback_unverified，不从命令退出码推断成功。

预算/停止/恢复：固定单动作类、测试 Bot、最多变更/重启/请求、旧制品与恢复策略；只执行用户批准的窗口，不因为“合入 v2”获得升级权限。无安全屏障就是来源功能阻断，不以多次 idle 采样替代。越权、重复动作、未知进程所有权立即停止，按准确 operation/guardian 对账，不无限 patch/rollback。回执 `not-run`。

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

## 同通道模型推理设置

共同来源：[FEAT-model-reasoning-policy](FEAT-model-reasoning-policy.md)、[Spec S11](../roadmap/box-runtime-impl-spec.md#model-reasoning-policy)、[ADR](../decisions/2026-09-17-model-reasoning-policy.md)。Source branch `feat/model-reasoning-policy`；初始 source `1e9a76a` → 最新 v2 `fa476b1` 上的 `ac73435`，原回执 `1108011` → `697fe0c`；配置/命令面组合修复为 `0f2cd0aab6397ba1ea207b012193cb2798786948`。固定代码候选 sourceDigest 为 `82aaf3e43024f82e8d382734315e6208db5eb956d4d522e89d3b93c310f16750`；实际 v2 快进与合入后复验另记，live candidate/loaded identities 仍 `not-selected`/`not-recorded`。这三条只登记必须真实环境才能证明的事实；源码/离线/独立 review gate 在来源票，不由登记豁免。共同许可、目标、请求/费用上限和窗口为 `not-selected`，不得运行。

只读原生资格补充（2026-09-17）：来源树的独立 native-source 运行 **28 pass / 0 fail**，覆盖普通全库默认跳过的 6 个原生源码 case；已安装源码匹配既有资格 pin，源文件与相关 PID 快照未变，受保护临时副本已清理。这不是已加载新 Host/modeld、真实 Provider 或原 App 回合证明，以下三条状态不因此关闭。

组合树复验补充（2026-09-17）：当前相同构建输入已通过 2190 pass / 6 default native skip / 0 fail 的全库、516/0 的 modeld release-offline，随后在最终变基树完成 read-only native-source 28/0。后一次变基仅接入并行配置文档回执，不改源代码/锁文件/构建输入。普通全库跳过的六个原生源码 case 已在该只读 lane 覆盖，仍不能证明已加载制品/网关/App。独立复审留在来源票；基线已有的历史提交邮箱元数据扫描问题属于发布隐私门禁，不进入 live 验收，也不因本次合并擅自重写既有 v2 历史。

<a id="live-reasoning-cutover"></a>
### LIVE-REASONING-CUTOVER — schema v2 与 wire v7 成套切换及退路
Status: awaiting-integration

依赖固定 v2 集成映射、来源非 live 出口和适用的 [MODELD CUTOVER](#live-modeld-cutover) 接点资格。必须 live 的原因是磁盘新构建不能证明已经加载的 Host/preload/modeld 同版；旧 schema/制品的恢复还涉及真实服务生命周期。离线已覆盖 v1 只读/v2 保存、取消与 CAS、v6 只读探测/禁止执行、真实隔离 Unix 和磁盘绑定；计数与候选以来源票为准。

环境与动作：批准的 restart/installed-host 窗口，预先保护 canonical config/models、profile、安装布局与旧制品，不输出凭据；若尚有旧 general config，先按 [CONFIG CUTOVER](#live-config-cutover) 停止旧 writer 并完成显式迁移，再协调 CLI/preload/Host/modeld 的 v7 加载与模型 schema 保存。`config migrate` 对已有 model v1/v2 原字节不改写，`models migrate --confirm` 只负责模型 schema，不能互相替代；人读别名与 canonical 实体沿统一布局，不另建设置文件。不在未合入 feature 上抢占全局 shim 或現役服务。

源码 CLI 边界：已确认全局开发 shim 跟随 v2；Git 快进后下次命令使用新代码，不代表现役 Host/modeld 已重启。普通模型保存会发出 schema v2，不在旧 Host/modeld 仍运行时把一次成功保存当上线资格。组合验收还须核对 home aliases、canonical 路径以及 client/desktop 编辑与 Bot effort 相互不改写；本地跨域、种子与迁移中断保真已有离线测试，现场实际采用需 [CONFIG CONSUMERS](#live-config-consumers) 与本条共同留证。

Oracle：逐个记录实际 source/profile/preload/service/wire 身份，新执行均为 v7；旧 peer 可诊断但不能接 managed STEP；旧 service epoch 不复活、历史消息不重发；v1→v2 不改变其他 Bot、wire model 或凭据引用。回退演练恢复匹配旧制品和受保护旧 schema 配置，不能以静默删掉 effort 作为无损降版。实际原生身份或旧配置不可证明时保持 blocked。

预算与授权：对象、最多切换次数、窗口、允许停止/写入及批准回执 `not-selected`。任一身份/协议/配置不匹配、旧 TURN 被重跑或影响非目标 Bot 即停止；恢复已核验备份并复查服务与官方对照，不扩大请求。回执：`not-run`，加载身份/回滚结果 `not-recorded`。

<a id="live-reasoning-provider"></a>
### LIVE-REASONING-PROVIDER — 原通道档位透传与上游证据
Status: awaiting-integration

依赖 CUTOVER（或单独批准的非现役真实 Provider 资格环境）。离线已证明 locked SDK 反例、Chat/Responses 最终 HTTP effort、冲突零 fetch、同 channel/model 稳定；不能据此证明真实网关未覆盖/忽略参数。作用域必须是明确批准的 endpoint/API/wire model/credential reference，不自动换另一 Provider 或铸造 wire 变体。

步骤与 oracle：先核对通道能力的权威依据，再在批准对象上比较 default/high/xhigh 的配置、TURN revision、emitted 与 HTTP/Provider 结果，核对 endpoint/key-reference/wire model 不变。收集可审计且脱敏的网关转换或 Provider 明确回报；没有合格回报解码器时 `providerReported:unknown` 是正确结果，不能用 latency、reasoningTokens、标题或自述签署 xhigh 已执行。分别记录“请求成功发出”和“上游档位是否证实”，任何真实不支持应撤销能力声明并回来源票修复，不降档重试。

预算与授权：canary ID、最多请求/费用/等待、工具权限与授权回执均 `not-selected`。达到预算、能力与响应矛盾、参数丢失/冲突或未知副作用即停止。回滚只恢复该 Bot 原 assignment/能力声明，不更改 ownership；不重发旧请求。回执：`not-run`，Provider 资格与实际执行档位 `not-recorded`。

<a id="live-reasoning-host-app"></a>
### LIVE-REASONING-HOST-APP — 原生会话与 App 的下一 TURN 改档
Status: awaiting-integration

依赖 CUTOVER 与适用通道的 PROVIDER 请求资格；与原 [MODELD TOOLS](#live-modeld-tools)、[MODELD APP](#live-modeld-app) 共享窗口时仍独立记录。本条必须使用已加载的真实原生 Host 与未修改的 App；source-shaped fixture 和标题字符串测试不证明原生恢复、工具消费者或 UI 展示。

在批准的一个 confirmed_box canary 上执行同 modelId 的 high → xhigh → default → official，另一个 Bot 保持原配置/official 对照。只使用批准的有界任务；需要工具/Memory/compact 的向量不得靠停掉这些原生路径通过。已有 TURN 必须继续原绑定，新 TURN 才改变 effort；实际工具调用、Host normalized terminal、最终交付及 App 标题 `m=/e=` 各自留证。改 effort 不应因为伪造新 modelId 触发不必要的模型切换/上下文清空；default/official 清 e，不破坏用户标题。配置查询不得冒充当前 TURN，tokens 不代表 Provider 档位确认。

预算与授权：对象、TURN/HTTP/费用上限、允许工具和等待时间、原 App 观察及回退许可 `not-selected`。旧 TURN 混档、重放请求、上下文/工具结果丢失、其他 Bot 被改或 Working/交付异常即停止。恢复该 Bot 原 assignment 与标题显示状态，核对 pending 工作是否实际终止，不将重启当全部副作用停止；必要制品回退沿 CUTOVER 预案。回执：`not-run`；实际 native/artifact/wire/selection identities、App 图像与结果均 `not-recorded`。
