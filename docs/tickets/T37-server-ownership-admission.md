# T37 — Server归属证据与真实 managed 准入

## Status / scope

**Partial · 2026-09-12 工作树已接通真实 kernel/modeld 准入，原生迁移/现场资格仍未关闭。** 已复用ownership读取桥，提取共享纯合同并由模型选择和production STEP程序消费；不再只是CLI预检。最新证据固定在[readiness](../maintainers/t32-live-enable-readiness.md)，未提交/未部署不冒充现役门禁。权威合同：[Spec S0.1.2](../roadmap/box-runtime-impl-spec.md#server-authority-rollout)；本票关闭V20，T24继续拥有模型选择/RouteBinding，T26继续拥有Host流与原生消费者。

用户结果：Server不是box、身份冲突或证据不足时，系统不会因为本地profile写着box就产生新的managed模型/工具/交付副作用；未配置的官方Bot不被无关门禁拖坏。

## 当前原生资格增量（2026-09-13）

当前Host原路径已可读；用其原生执行注册器、resume-ownership服务、applied-migration屏障、scope helper及完整变换后Gateway property，组合实际packed reader完成隔离资格。已覆盖启动identity未结束但migration inactive、executor未绑定、migration运行/释放、recovery撤权和缓存命中仍重读许可。17-slice完整profile唯一命中并通过全bundle语法检查。原件未执行/改写；RPC/auth schema/identity effect是owned依赖，**不是live schema3、whole-loop或跨Server瞬时租约证明**。精确版本/16断言/制品只记[readiness](../maintainers/t32-live-enable-readiness.md)。

当前startup确实调用原生全局identity reconcile；T38的部署影响门因此是实质前置，不只“不要主动调用reconcile”。owner已单独允许满足安全前置后的受控同步窗口，尚未执行。下一步仍是独立审查和受控部署后的真实scoped桥/准入回读，不重做已通过的owned暂停测试。

### Astra发现的原生恢复顺序差额与修复候选

首审指出：当前原生`resumeConfirmedOwnership`先启动pending resume，再等待rearm，最后才开放`isLocalWorkAllowed`。真实`UpgradeRecreateResume`会在被拒绝的恢复结束后清原marker。已用当前原生完整恢复方法与实际packed reader/kernel准入隔离复现：hold未放开时runner=1、准入拒绝=1、marker丢失，不能用先前16断言中的替身resume签此链。

新`ownership-resume-gate`位于原生ownership/gone/temporal检查之后、markPending/inFlight/runner之前。仅在native许可尚未开放且managed（或配置不可确认）时返回原生`skipped`；marker不消费，原生全局hold不提前释放，官方未opt-in分支保持原样。后续由**现有**resume-ownership recovery处理pending，不新增timer/重试/ledger。原oracle修后hold期间runner/provider/clear均0且marker保留；native释放后其原recovery恰好一次准入/runner/清标记。

这只关闭受检版本的启动等待顺序子问题，不证明原生checkpoint事务、服务跨代旧TURN选择恢复、实际pending work或App。完整profile现需18-slice候选（含该guard）；旧17-slice资格不覆盖新字节。精确pin、回归和Astra复看见readiness。普通新TURN/后续STEP的T37门不接受paused，未削弱撤权合同。

## Reuse / module ownership

- 复用`host/ownership-read.ts`、`ownership-slices.ts`及`GatewayClient.getAgentOwnership`的有界原生Server查询，不导出官方凭据、不提供任意RPC转发。
- 将CLI `ownership.ts`中的**可复用判定**收敛到`runtime-kernel`现有contract/commands/ports的适当内部模块；CLI保留输出投影。Host leaf保持Effect/SDK-free，不import CLI。
- 异步查询/刷新生命周期归现有Effect runtime和Host原生能力adapter；不得让同步`createSession/getExecutor/stream`变成Promise接口。须在真实异步准入点接线，不能用同步hook抓到的过期文件替代。
- gate消费落在T24的唯一TURN/STEP程序和T26的Host入口；不新建第二执行ledger、身份数据库、全局租约服务或后台orchestrator。

## Contract

### 身份判定与证据分层

继续输出`confirmed_box / confirmed_temporal / conflict / unconfirmed`，分别保存来源/范围、公开UUID、Server行ID、Server与local声明、读前/读后稳定性、Host/Gateway代、观测完成时间。账号/team/backend范围改变使旧证据失效；缺字段、重复行、无匹配或错误范围不得由名字、时间或default补齐。

归属、账号权限、migration、freshness、App路由、模型资格彼此独立。`viewerIsOwner=null`不是true，也不能仅凭这个缺省断言原生认证无权读取；需要的写/执行权限由原有认证和权限合同证明。`confirmed_box`只解锁归属条件，不设置productionAccepted。

### 真实执行门，而不只是CLI预检

模型首次启用/切换与新managed TURN在接受模型选择前消费合格证据；Host实际入口必须保护App/API/automation等经过Host的请求。CLI预检只用于提前解释失败，不能成为唯一屏障。未opt-in官方路径保持原有行为；显式请求managed而归属不符必须拒绝，不能换官方/temporal执行。

门前允许有界认证读取、诊断和拒绝记录；禁止新增主provider调用、工具执行、有效Memory结果或SendToUser效果。不得承诺Host能拦截绕过它的App→Server请求；此类情况是支持范围/实际App验收缺口。

### 刷新、并发和失效

- 初始化/重新领养、账号与Host代变更、启用/换模、新TURN等边界使用有界新鲜证据；重复查询按同范围合并并限制并发、目标数、总时限。复用现有桥，不逐token/逐工具轮询。
- 已在`contract/ownership.ts`固定：证据最大年龄5秒、Server缓存2秒、读取等待10秒、最多32个目标；没有开放任意扩大安全范围的配置。RPC年龄从请求开始保守计算，慢回复不能在返回时重新获得5秒新鲜度；超龄回复不入缓存，非法当前时钟不能准入。合并并发读取不共享可变local结果，每次仍核对本地/迁移前后值。
- 冷Server读取不能被旧local-only的500ms整个包住。当前modeld复合准入上限为`OWNERSHIP_WAIT_MS + ADMISSION_WAIT_MS = 10.5秒`，不是每次read再续10秒；接下来的流仅使用180秒STEP总期限的剩余时间，partial socket的1秒保持不变。700ms受控冷读正例与超龄FakeClock反例分别验证可推进和拒绝。
- 每条已受理TURN捕获所属范围及证据/模型身份；单纯配置变化不撤销旧TURN。后续STEP检查本地失效/原生屏障，不重新选模型。
- 真正的归属撤销、迁移、Host代变化使旧准入无效。复用原生resume-ownership/turn-execution暂停和迁移屏障；不把List快照伪装成Server租约，不以两次读取声称跨端原子性。
- 对已开始的效果按未发生/已发生/未知记录，取消不能伪造回滚；迟到摘要/工具/消息不能借旧授权进入新root。跨服务重启不复用旧准入或自动重放未知STEP。
- 接点不能证明上述fence时，阻塞受影响的支持范围并记录缺口，不能绕过官方hold或把本地box当永久授权。

## 与T41持续观测的接口

[T41](T41-continuous-observation-and-alerting.md)复用本票事实获取/纯判定，批处理与single-flight应由一个共同能力调度，不因多页面或CLI重复请求成倍读Server。准入与背景poll有独立预算/优先级；取消某个等待者不取消其他仍需的查询。结果带Box/账号范围、source/epoch/完成时间和缺证，不伪造上游revision。

**本票不依赖T41数据库、incident或通知。** SQLite恢复的lastKnown不能恢复准入；本票的有效新鲜内存证据必须满足自身policy与原生屏障。实际撤销先使准入失效，再交T41异步记录/告警；DB锁/满/通知失败不能阻挡fence或触发新模型。单次ownership查询维持已承诺的只读语义，不能为了未来监控在GET里偷偷建库。

## Delivery and order

1. 先给当前纯分类和证据边界补红测，提取共享规则且CLI输出兼容。
2. 接模型配置准入与实际Host新TURN门，证明其它入口不能绕过；桥缺失时明确unconfirmed而非自动部署/读取凭据。
3. 接刷新/失效与现有binding/取消流程，完成source与本次packed行为证明。
4. 交T38进行身份writer退场；随后T24完成独立可逆选模。真实现场正例只用重新确认box的批准对象，test2只作本地拒绝反例。

## Acceptance / executable proof

**已实现**`bun scripts/verify-runtime-rebuild.mjs ownership-admission`：共享scope/freshness、native-reader single-flight、真正Host client→Unix→production root拒绝、恢复attempt1最后fence，以及原CLI/direct/daemon读取反例。source组已过；当前`notProven`仍包括原生迁移屏障、现场scoped读取、完整packed-native准入和生产资格，不能把case存在当整票Done。

| 场景 | 必须证明 / 失败条件 |
|---|---|
| box/box且范围、ID匹配 | gate准入；只证明ownership，不虚报App/生产通过 |
| temporal/box、box/temporal、Server行ID不同 | conflict；主provider/tool/SendToUser新增效果均0 |
| 缺桥、无行、未知字段、重复行、401/403/超时 | unconfirmed/有界拒绝；不repair/reconcile/send或偷回官方 |
| 并发启用/新TURN/批量查询 | 同范围查询有界合并，状态隔离；没有多次provider effect |
| 证据过期、账号切换、Host重建 | 旧证据不能获准；前后读发生变化不签稳定 |
| 初检后、dispatch前发生撤销 | barrier红测，provider次数0，不是靠时间sleep碰运气 |
| 中途模型配置修改 vs 所有权撤销 | 前者旧TURN保留选择；后者失效并诚实结算已有/未知效果 |
| 官方Box/合法Temporal/未选managed | 不被自定义准入门误伤；不会额外调用我们的provider |
| direct / daemon / 原生Host调用 | 同一规则，不因绕过CLI预检逃逸；认证值不入输出/日志 |

独立review聚焦权限边界、TOCTOU、取消、资源和原生协调。现场只读可先复用`agents ownership`；真实负例不向冲突Bot的App发任务来“测试Host阻断”。

## Dependencies / handoff

以已有T24/T25/T26程序、T27证据writer为基线，不等待它们全部历史票形式关闭才开工；修改其接口须同批覆盖caller。T37本身不依赖T38完成，避免环；T38在T37 gate可用后移除错误writer。T39/T40消费本票有效证据。

### 本轮已收的实际差额

production `runStep`在首次准入、dispatch、工具/终态放行和恢复边界消费ownership；绑定保存scope/Server行身份，失效TURN不能在scope恢复后复活。新反例发现恢复的异步`prepare`之后缺少最终检查：原代码能在此时权限/凭据已撤销后仍启动attempt1；现在重新执行同一dispatchFence，原请求一次effect如实保留，第二次为零。工具事件不是工具真实执行，也不据此声称所有原生writer已被完全fence。

四个真实Host/Unix拒绝用例修正了测试等待方式与既有事件枚举：显式等待原Promise并检查实际`model_step_terminal`，而非只让reject matcher提前失败；真实事件是`phase=admission / outcome=error / failureCode=not_admitted`。没有给production writer发明`admit/rejected`字段。

### 当前原生暂停与packed差额（2026-09-12 15:56 UTC）

源码核对发现`resume-ownership.getSettledHostWindow()`只返回migrationBarrier；原生启动/恢复可以令`turn-execution.isLocalWorkAllowed=false`而迁移窗口仍inactive。当前候选的读取桥因此增加`readExecution`，借原生`isLocalWorkAllowed / canExecute`给出前后两次布尔观察；共享合同只接受schema3中两次allowed/bound均true的执行证据，v1/v2仍可诊断归属但不再准入。查询命中Server缓存时仍重读本地执行事实。没有调用原生setter或migration RPC，不把一次读取当永久租约。

前轮`ownership-native-pause.test.ts`的直接执行被拦属历史。后续正常直接调用已取得**9 pass / 0 fail**，再将同一测试加入`ownership-admission`，该入口现为**58 pass / 0 fail**：暂停、执行器未绑定、读取缺失/抛错/畸形、读取中暂停、cache hit重读执行状态、旧schema拒绝均覆盖。该组依赖仍为owned原生事实替身，不自动成为真实Host启动/迁移流程资格，V20仍未关闭。

新`ownership-artifact`入口已实际构建并运行独立Node子进程：加载真正dist/preload.cjs里的production session hook和ownership-read，连接真实Unix与source production modeld/kernel/SDK mock。confirmed box一次真实SDK mock请求；Server temporal和旧schema2都在provider前拒绝，原生替身List计数1、official executor计数0。加上实际preload无旧harness hook检查共4/0。modeld仍由source加载、Server/Host环境是owned替身，**不是完整packed modeld或官方全loop/真实Server资格**。

packed测试已扩到**7 pass / 0 fail**，新增暂停、未绑定和原生状态不可读三种Node子进程拒绝，真实Unix/source modeld路径检查provider与official executor零调用，并检查安全日志；没有重新构建或部署现场Host。原生读取桥仍只在旧live版本上观察到登记，16:10 UTC实查test0/1仍box一致、test2仍冲突，localExecution未观测。

下一动作：固定单一候选，完成当前原生接点独立资格和test2私有可恢复保全/影响确认，再让T38退场候选进入受控live窗口。最新全仓验证中出现modeld lifecycle并行写入，结果和输入指纹须按readiness处理；不把专项绿或移动源码的全仓计数签成V20。
