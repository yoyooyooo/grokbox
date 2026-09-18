# CONT 真实恢复材料与操作安全记录首个实现切片 · 2026-09-18

本片基于已固定OBS→CONT J1，推进CONT-02/11的真实存储消费者，不把公共合同fixture包装成生产实现。完整主线仍归[Spec S13](../roadmap/box-runtime-impl-spec.md#ownership-continuity)，动态现场只在[LIVE-CONTINUITY-MATERIAL](../tickets/LIVE-integration-validation.md#live-continuity-material)及关联索引。本片未集成live、未完成原生Bot状态捕获/导入或任何自动替换。

## 已实现的实际入口与存储位置

`@grokbox/box-runtime/runtime`新增`openContinuityRecoveryStore({durableRoot,scopeId,policy?})`，构造不做IO。`initialize`显式建立私有存储；`publish/publication/readSnapshot/reconcilePublication`管理恢复材料；`prepareEffect/claimEffect/operation/settleEffect`管理独立操作记录；`owners.recovery/safety`直接实现J1的计量、引用变更和维护接口。不新建CLI命令、定时器或生产owner自动注入。

纯材料合同在`runtime-kernel/src/internal/continuity/material.ts`，通过新的`./continuity`子路径发布；Effect操作在`box-runtime/src/internal/io/continuity-store.node.ts`与`roots/continuity.runtime.ts`，底层文件/DB接点分开。现有Node SQLite driver复用，但**CONT recovery/safety共用自己的`<durableRoot>/continuity/state.sqlite`，不进入OBS的诊断数据库或诊断TTL/cap**。这是业务管理与备份，不是第二个原生在线root writer或配置文件。

内容存入私有`continuity/objects/<hash>.blob`，暂存对象在`continuity/staging/`。manifest保存来源scope/Agent、原生schema声明、context revision、转录水位、质量和有界依赖图；相同root槽位ID的不同字节得到不同恢复revision。JSON字段严格检查，不评估getter/枚举coercion，不接受任意正文或路径放进manifest。内容本身是明确传入的私有字节，不从原生Bot目录隐式采集。

## 发布、引用与回收

发布先冻结输入字节，校验声明依赖图/字节摘要，再将内容绑定的request ID、manifest与最坏瞬时逻辑空间预留提交到DB。随后写私有文件、fsync、校验并发布metadata。只有published可读取为恢复包；reserved/abandoned/retired都不伪称可用。跨文件和DB不宣称单事务：中断后明确verify或abandon，原request不会重新读取源并静默发布另一份内容。

protect/release、发布与GC共享同一个实际SQLite写边界。claim ID及其revision不能被另一项release解除；已release的claim保留最小墓碑，重复旧protect不会假报仍受保护。同一请求不同内容冲突。普通incident明细过期、journal轮转及通知策略不改变这些引用。

默认保留每个Bot最近两份完整发布以及最后原生质量点，活跃引用和prepared/effect_unknown操作保护相应材料。回收旧点前重新读回将保留的材料；若最新内容坏了，不因此删除旧的可读恢复点。**先持久退役manifest/链接，再在独立阶段删除无引用的catalogued对象**，避免unlink后事务回滚重新露出一份缺文件的有效快照。回收中断可由后续有限维护继续，不扫描或删除未知文件。

逻辑内容额度、单包/单part/依赖数量、metadata页数都有上限；内容去重，staging预留按保守瞬时数量计。物理全安装配额、未知同UID写入、任意断电与旧备份回滚不在该承诺内。GET不初始化、修复、解除引用或GC；目录/文件权限、no-follow、inode/链接及内容摘要通过检查。此防护不是对同UID恶意进程的沙箱。

## 新副作用之前的安全记录

操作绑定Agent、kind、输入摘要、policy revision和可选源snapshot。prepared只能登记意图；claim在返回首个`dispatch=true`之前先将effect ID和`effect_unknown`持久化。同内容同effect只有一次本地claim返回可派发标志，重复/重启返回false；changed input/policy或另一个effect ID不能绕过旧unknown。

**这个标志不是执行授权。** 状态始终附`executionAuthorized=false`，真实controller必须另行检查当前权限、归属、配置与实际效果。存储不调用Gateway/模型。丢claim回执时，即使实际上尚未发出外部调用，也不猜未执行；显式证据可结算为succeeded/not_executed，但不会自动再给相同操作一次派发机会。

最低安全记录写不下时拒绝新意图/claim，不删旧unknown腾空间。当前未实现安全墓碑的语义退役和长期无界请求处理；`safetyRetirement=not_qualified`及owner blocked结果保留，不能把“容量有限并安全拒绝”说成无限期日用已完成。已有接纳操作的外部结算/任务级幂等仍需CONT-04消费者实现。

## 与J1实际接线

本片不是重写OBS接口：真实owner传给`measureContinuityStorage`、`runContinuityReferenceChange`与`maintainObservationStorage`，源operation先存在，再使用原bridge/incident/outbox。测试真实过期diagnostic明细后，CONT材料和effect_unknown仍在；统计与诊断占用不重复合并，缺owner继续unmeasured。没有默认生产注入，现役maintenance不因代码存在自动维护真实恢复材料。

当前只验证**声明依赖图和实际字节hash**，并明确`nativeImportProven=false`。原生字段/隐藏引用、跨Memory作用域、实际工具/历史窗口、是否具备可安全接续的职责必须由后续qualified capture/importer核验。quality声明不等于原生导入证书；存在完整文件不等于新Bot已经有了这些记忆。

## 实际验证

使用仓库声明Bun 1.3.14和frozen lock（106项安装检查无变化）；独立产品进程选择Node 20.17.0。可重复入口：

```bash
node scripts/verify-runtime-rebuild.mjs continuity-store
```

PATH需选择声明的Bun和支持的Node；`GROKBOX_TEST_NODE`可指定Node最低版本。最终组合 **114 pass / 0 fail / 640 assertions，11文件**：

| 范围 | 结果 |
|---|---|
| 新材料纯规则、真实store、独立进程及既有J1合同 | 46 pass，251 assertions；其中32项新增、14项J1回归 |
| monitor/事务边界、维护lifetime、context边界/控制与制品 | 43 pass，364 assertions |
| 架构正反例 | 25 pass，25 assertions |

类型检查、完整构建、Node依赖边界、含未跟踪文件的986文件隐私扫描通过。验证前后757个source/test/lock文件摘要一致：`9d48ba6a919a70dd82cb7f2067455d68c4fe05b2737837c9791a20dbf817b8b8`。构建preload为`c2736bb024db70ef52942e22753f7f78f64abff3825a18eeced559ef8028d0f2`；该变化包含全项目source provenance，新模块未进入Host依赖闭包，pin由实际构建更新并通过拒旧制品验证。

进程用例使用真实临时SQLite和内容文件，测试子进程仅终止自己。覆盖reservation提交后、内容写完后、SQLite提交前、claim提交后及模拟外部效果发生后的SIGKILL；新Node进程读回/核对，不重复append效果。四个独立Node争领同一操作，恰一条派发记录。并发保护/GC、两阶段回收崩溃、容量不足、symlink/坏hash、调用者变更输入、取消等待真实当前写步骤等另有source用例。

早期容量测试的预算夹具没有实际触顶，修正具体预算后通过，未放宽生产门。早期开发工具子进程/架构夹具出现超时；独立进程证明收敛到产品Node，架构checker改为有限同步Node子进程，测试编译器限制worker数及寿命，无删减断言/重试成功伪装。固定Node20的最终完整组合全部通过；不额外声称Bun子进程加载行为或任意共享机器负载已获稳定性保证。

## 剩余工作与交付边界

CONT-02尚缺原生无修复capture、配置化四档与自动安全点触发、完整Memory/附件来源映射；CONT-11尚缺完整授权/逐职责状态机、策略消费、继任generation和安全退役协议。下一公共内核是CONT-07的原生hold/initialize/commit/reopen，再由CONT-03完成新Box状态塑造。未注册并宣称clone、reset、spawn已可用。

未跑本轮全仓全部测试，未获得独立review、真实Host/Server/App/Provider验收。没有切全局shim、现役配置、Host或modeld，没有创建/唤醒/迁移/删除任何真实Bot或Routine。代码留在功能worktree；schema4依赖仍需固定成套集成与live采用，Git commit不构成现场权限。本报告不维护第二份动态live表。
