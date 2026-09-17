# 2026-09-17 — CTX 503 对照、显式备用模型与加载接缝修复

本报告§1–6固定截至17:18 UTC可核对的源码、模型请求、离线测试和现场只读证据；§7记录后续独立控制链测试发现的缺陷及修复，不能将晚到代码倒写为前一现场窗口已经采用。后续现场进度只维护在 [LIVE 唯一索引](../tickets/LIVE-integration-validation.md#live-ctx-adoption)。来源实现为 [CTX-00–04](../tickets/README.md#context-maintenance)，此前证据见[原离线报告](2026-09-17-context-maintenance-offline.md)。这里不把独立复审请求、直接模型适配测试、合成Host链和真实用户会话混为同一资格。

## 1. 真实上游请求的失败/成功对照

用户允许把503作为失败对照，并指定 `sub2api-xai/grok-4.6` / `high` 作备用测试模型。本窗先通过实际grokbox ModelBackend、BackendAuth与AI SDK发出两个无工具、输出上限1024、逐请求75秒以内的有限探针；目录与凭据通过既有reader/引用读取，不修改生产模型目录或已有Bot分配。

| 固定通道与档位 | 实际观察 | 能说明什么 |
|---|---|---|
| sub2api-codex/gpt-6-astra / high | HTTP503；仅一次HTTP；535ms结束；BackendFailure/provider_error；退出后activeFetches=0 | 真实上游失败经适配器正常收口，没有SDK隐藏retry或成功终态；不是Host/App完整验收 |
| sub2api-xai/grok-4.6 / high | HTTP200；仅一次HTTP；2954ms；stop终态；精确返回预设短标记；退出后activeFetches=0 | 同一实际适配层可执行备用通道，不是原503通道已经恢复 |

备用请求回报prompt2182/completion140，其中reasoning135、cache-read128；数字来自该请求usage，不外推费用或压缩质量。两个请求的requested/emitted为high，providerReported仍unknown；推理token存在不证明网关内部档位已得到独立确认。结束时AbortSignal被正常清理触发不等于服务端所有远端工作都获得取消证明。

仅此两条是完整结束的实际Provider探针。另一次直接ModelBackend的公开源码复审请求HTTP200/一次请求，但150秒到期，没有完整报告；两次headless Pi复审也到外层期限且无报告，其内部HTTP次数未取得，不捏造总调用数或零消耗。旧Astra reviewer503同样不是独立review完成。停止反复请求，不拿短探针成功替复审签字。

## 2. 503 后显式切换的可执行链路

`context-maintenance-host.test.ts`新增summary-503和main-503：真实SDK→loopback HTTP→Unix→kernel→Host facade。摘要503时仅一条摘要请求，旧root/新输入原样保留、零archive/零checkpoint、零主请求；成功compact后的主请求503只产生一条main HTTP，不重复压缩或自动重试，已提交checkpoint与新输入保留。原始Provider错误sentinel不漏入可见错误或后续上下文。

`context-maintenance-provider-switch.test.ts`进一步以同一份连续材料验证两条完整序列：

- 摘要阶段503 → 显式改模型并发送一个新的TURN → 在备用high下重新维护 → 新输入执行一次。
- compact成功但main503 → 显式改模型及新TURN → 直接使用已提交的压缩root，不再为旧错误无谓摘要 → main执行一次。

两条都验证旧maintenance记录不被重写，原失败不复活；第三条普通输入不会因为陈旧503再次compact。测试使用两个合成模型身份与实际HTTP编码断言high，而不是自动fallback开关。真实业务工具未执行，原生App、真实checkpoint重启和故障旧会话仍需现场证据；不能把本测试说成已替用户原Bot完成模型切换与恢复。

## 3. 实际加载准备发现的产品缺陷

旧运行profile指向较早native SHA，而当前文件已是固定隔离测试中选择的native版本。按支持的observe/analyze/write流程推进时，writer要求审核新增context切片，却在参数校验中拒绝这些ID；analyzer还复用旧recipe的观察，只列旧切片而漏掉新切片。因此不是简单重启可以解决。

修复 `87463c9`：共享完整envelope切片白名单；analyzer从保留的当前source按实际writer recipe重新计量，不拿历史pin的观察冒充待写配方；精确review集合必须与writer一致。增加实际配方的完整升级、漏项/多项拒绝、旧artifact不变与原始source不变反例。`6fb4b48`修正CLI旧toy测试并更新严格E09 pin，未减少审核要求或放宽未知slice。

现役支持的profile write随后实际通过，仍是offline authoring，signaled=false/inject=false。固定native SHA为 `dfd1d0773c07d66fb90a336b0960bf65a0c61e1305239ad40f81cb3e2b4e33c7`，候选transformed SHA为 `9b79e8663a353f523cda6e29a6361bf1e18b583e616125d86a9c1e62c013f7cc`；不修改/升级官方文件。

v2以fast-forward从6596a15进入ce1c184，再到6fb4b48；没有merge commit或远端push，未部署未合入feature。6fb4b48构建preload SHA为 `1ec09f4451c20dfd1cd783783cc477648250f9db00df0ef1961d865d2ae3db53`，CLI SHA为 `f066163307f45bafc98c03df2a0101ce7d4e782890cad734284895360f83305f`。后续b77ceb0与3ec15c3只改测试/verifier，不声称运行源码已再次变更。

## 4. 实际执行、恢复与并行边界

本执行路径先保全旧固定制品、canonical配置/models、前次迁移manifest/备份、profile与恢复资料。验证旧modeld同root/epoch、实际socket owner、UID/Node及activeSteps=0后，以生产身份检查器发SIGTERM正常停止；没有SIGKILL、删socket、删ledger或Host信号。通过旧CLI停止daemon后，迁移preview得到canApply=true、无冲突/旧writer，并明确保留models原字节及前次retired回执。

**此路径的两次migration apply被工具安全层拦截，未取得apply执行回执。** 因此没有绕过为原始JSON写入，而是先恢复旧daemon、wire7 modeld和相容CLI。恢复的服务新epoch、zero active/pinned、LevelDB可读写，未重放旧请求。此中间回退不能作为最终schema3采用失败或成功的唯一依据。

后续发现同一窗口的并行continuation已经推进迁移、服务和测试对象。该后续写入不是本路径发起，故停止重复的migration/start/stop/Bot发送，用私有交接说明限定唯一现场写入者。只读核对实际canonical schema3、迁移phase=retired、新wire8与相容v2 doctor后，将全局grokbox/gbox入口重新对齐已集成v2；全局配置读取成功。没有把旧备份覆盖并行产生的新配置，也不重复其canary。

截至本报告采样：modeld wire8/expected8、ready=true、activeSteps/pinnedTurns/pendingScopeReleases均0；doctor为custom/next=none。与此同时，runtime status仍报告circuit=open、mutation inhibited，Host协议兼容性为not_observed；对测试对象的context查询显示configured为备用模型/本地128K，但nativeCapability=unavailable、lastMaintenance=null。**配置已保存、进程可达和doctor正常不等于维护root能力或真实旧会话恢复已证明。** 截至该采样的本service epoch accepted=0，不能外推此前所有epoch的调用数。

这些是明确时间的只读观察，而非对并行窗口的最终清理/成功签字。真实canary nonce/STEP/Host/App/持久化结论需由实际现场写入者取得回执后更新LIVE；本报告不替其未知阶段填成功。没有把测试对象分配冒充修改了用户原故障会话。

## 5. 离线复验与被保留的失败

| 入口/阶段 | 实际结果 |
|---|---|
| profile writer/lineage/envelope专项 | 52 pass / 0 fail，316 assertions |
| 修复后的profile CLI与E09旧制品拒绝 | 8 pass / 0 fail，58 assertions |
| 显式当前native只读隔离8个suite | 31 pass / 0 fail，245 assertions；不改native文件/PID |
| 最新context源码组合10文件 | **56 pass / 0 fail，332 assertions**，含503→显式备用模型两条序列 |
| 异步观察修复后storage/背压/模型切换专项 | 17 pass / 0 fail，98 assertions |
| 最后全库 | **2248 pass / 7 explicit skip / 0 fail，18481 assertions，295文件，292.02秒** |

此前全库失败没有删除：先是analyze CLI旧toy fixture与实际recipe不符；后两次分别为背压50ms采样仍接收已排队数据（106→152），以及异步冷却尚未落到soft target时hotTurns=3。代码检查确认coolUnderPressure只唤醒服务owner，不要求当前STEP同步等磁盘I/O；测试原即时target断言不是该合同。

`3ec15c3`仅修正观察边界：背压在1500ms内等待100ms稳定，仍拒绝eager drain并验证读者可继续；冷却在5秒内观察原服务真正收口，保持原<=2目标、零pending release及2048次实际请求断言，不调用强制清理/不增加上限。最后全库再次运行通过，但这不证明不存在所有调度/存储故障。`b77ceb0`保存显式备用模型序列及verifier接线。

## 6. 后续门

真正尚缺的范围是当前native维护capability/原故障长会话下一条新输入、完整native archive/checkpoint的实际重启与App活动/投递、有限取消/unknown场景和独立固定提交review。Provider短请求或普通服务重启不能替代这些门；本地500K→128K自动路径仍由独立离线条件证明，不需要刻意撞真实provider窗口。当前状态及下一现场动作只改LIVE对应行，原报告保留本窗口的范围、失败与未知。

## 7. 继续收口：真实控制通道的提交不确定性

后续普通原故障Bot ownership/context/show只读调用仍被执行工具安全层拦截，未获得新Bot状态或请求回执；没有改走其它发送接口。没有再发真实Provider探针或review以重复消耗额度。现役泛化runtime status读回wire8、ready/accepting、activeSteps=0，counter accepted=0仅限该epoch；stored coordinator仍circuit=open/reason=null，与已加载modeld可达不是同一事实，没有自动清除它或宣称所有控制面都无阻断。

为补上此前仅CLI mock覆盖的手动操作入口，新建 `context-maintenance-control.test.ts`，串联**真实manual facade → Host client → Unix → kernel → Pi衍生算法 → SDK → loopback HTTP**。原生shell与存储外围仍是明确替身，普通输入只断言交还native runner的队列边界，不冒充App或真实主模型交付。

这条新链首先复现：checkpoint实际写入/原生root已替换后，原始保存错误被wire外层分类成 `context_material_invalid`，而手动控制层吞掉所有失败继续调用排队输入，导致它可能读到不确定甚至部分替换的root。仅测试原生owner抛出错误或只看维护ledger的commit_unknown状态，没有覆盖用户入口收到的分类。

修复提交 **`5f2afdb`**：

- 在第一个native root mutator之前记录publicationStarted，append尚未返回的部分写入也不能当未发生；发布后的原始错误/取消跨Host socket边界统一保留commit_unknown，不泄露底层错误正文、不自动回滚或再写。
- checkpoint Promise由原生owner持有；取消清理同时等待summarizer与实际checkpoint，有界未收口为native_cleanup_unknown，不能只等摘要生成便让后续输入进入仍在写入的root。
- 明确不确定的手动维护阻断已排队及后来的普通输入，也阻断更换operationId来重试；当前shell状态返回blocked/nativeBlockReason。原生owner重新加载或独立对账之前不自动解除；状态查询不是恢复动作。未发生写入的summary503/早期取消仍允许下一条新意图进入原生runner。

新增六条manual旅程覆盖成功、summary503、checkpoint-unknown、append部分失败、发布前取消、发布后checkpoint期间取消，全部断言零伪业务STEP、同操作去重、无隐藏主请求、准确queue边界；另有partial native mutation和checkpoint清理等待两条owner反例。错误修复前checkpoint用例为真实红测，未把期望改成接受错误分类。

最终组合：全库 **2256 pass / 7 skip / 0 fail，18667 assertions，296文件，285.64秒**；锁定Bun1.3.14、实际Node20.17 PATH的context-maintenance为 **64 pass / 518 assertions**，另 **11 packed/wire tests / 99 assertions**，typecheck/build/import fence通过；固定native方法隔离 **1 pass / 28 assertions**。Source前后指纹 `015cc93335d445a5ca86cb5b9a33611f8d4107789de1da9abaca785bf4dd8e8e`、690项，均稳定。不同suite重叠，不相加成总数，7个skip仍非通过。

两次重复构建确认preload `77dcf6536d339f46db167c02f823f675410e09b9fe7307cc8af560307fc8815a`，CLI `b3ff781069d1cf1085b4360ea7d7c25cd07e52e7f465f17f0822f3f00b906289`，严格E09 pin相应更新。此新source/preload与§3的实际已加载版本不同，需要在LIVE单列采用/重验，不能用同为wire8忽略代码代际。

一次附带排查错误地用宽文本搜索读取了私有启动环境，工具结果包含敏感环境值；立即停止该读取，后续只采用有限字段查询。未将这些值复制到报告、测试、Git或新模型参数，也未擅自轮换凭据。公开检查只证明仓库未含该内容，不能撤回已产生的工具输出；凭据处置需按用户独立安全决定进行。

