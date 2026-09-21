# HOST-01 · Host 补丁健康识别与 Rust/Oxc 验证内核

**状态：实施中。** 当前来源的精确配方、四项静态谓词、有限checkpoint ABI、实际编译回执、原引用注册及managed主流lease直接机会已经接入原管理/故障链；完整能力覆盖、实际采用后整条业务与独立告警出口仍未完成。最后更新2026-09-21。

## 目标、已定架构与最终边界

面向重建中的管理Server，准确区分磁盘配方、静态语义、实际加载、原函数引用、真实调用机会、观察链与投递链。不把一次parse、固定fixture或profile保存当成完整健康。

唯一设计指向[健康方案](../roadmap/host-patch-health-proposal.md)和其[协议/包布局](../roadmap/host-patch-health-proposal.md#package-layout)；[跨会话交接](../roadmap/host-patch-health-integration-handoff.md)保留原始整合背景。TS的`applyPatchProfile`仍是唯一变换，Rust/Oxc通过已确认的Node受管stdio/只读FD分析有限快照；Rust不控制Host、不读写业务库、不调用模型。沿原provenance、OBS incident/outbox、共享client/CLI/Web推进，不另建parser回退、profile writer、controller或监控数据库。

**最终新版仅保留现行实现与合同。** 旧入口/双writer/旧格式实时兼容/拒绝型旧executor残骸要在必需行为迁移后退出，不能为了历史测试恢复旧路径。资料、未决外部效果与原操作记录仍须保全，不自动清空或重解释成当前成功；保全不要求实时合同继续接受旧版本。此用户要求也记录在[Agent入口](../../AGENTS.md)。

## 当前实现与资格

| 层 | 已实现范围 | 不能由此推导 |
| --- | --- | --- |
| 当前作者配方 | [单一HOST_RECIPE](../../packages/box-runtime/src/internal/host/source-recipes.ts)，39+3+19片完整有序apply；默认作者、能力升级、envelope及诊断共用 | 自动审核、任意新源码资格、实际采用 |
| Rust静态 | `session.main-binding@2`、`retry.turn-guard@2`、`context.checkpoint-await@2`、`context.lease-finally@1`；实际symbol/有限CFG/原生角色与同步资源helper ABI | 一般跨函数/heap别名、任意动态registry、所有外部异步工作已结束 |
| 跨语言制品 | 原Node→只读FD→正式Rust binary；严格schema/attempt/digest/有界输出与实际child close；lock/toolchain/schema/源码进入build身份 | parse或报告到达等于资源已释放、运行时联网下载资格 |
| 有限原生ABI | [当前唯一元组](../../packages/box-runtime/src/internal/host/native-checkpoint-pair.ts)，原schema/AgentStore/worker事务、完整图、prepare/marker/GC屏障、重启/B2、startup/duplicate/disposal隔离验证 | 主Host整入口、真实账号/Provider/App或完整恢复已经验收 |
| 运行编译 | 原Module._compile正负结果，准确PID/start/UID/exe/argv/root/target；磁盘与加载分代 | 编译成功就是挂接/调用成功；源恢复可以修复旧运行代 |
| 原引用与机会 | 赋值点固定原函数/方法；真实challenge前后核运行代；managed主流入口从原compact registry直接查lease；同代有界累计保留首次missing | 所有consumer都用了hook、没有记录就是bypass、同代后续成功可以抹去已知失败 |
| 管理与监控 | Server Scope采样/分析/入库分离；dirty+hash backstop；原provenance序列/持久OBS/幂等condition/outbox；`system host health`、`/host-health` | 页面关闭停止采集、未知来源自动健康、投递自动授权 |

实时健康只接受host-health-v2和witness v2，持久analysis同时核对现行完整id/revision集合。旧合同或不匹配记录保留原字节但拒绝充当新证据；不会减少必需项或自动迁移成成功。旧Host元组和按SHA挑选历史配方的分支已退出，未知Host不回退。正式非受管Bot的原生passthrough是现行产品行为，不是旧grokbox兼容路径。

## 当前来源与最新证据

本轮原生复验实际发现Host再次从2380…更新为6be750…，先拒绝旧资格，再进行独立源/schema验证和生产hook复验；没有只改pin求绿。最终source/worker/candidate准确摘要、原失败、cache-before-validation测试问题及修复见[单版本收束报告](../reports/2026-09-21-current-host-contract-convergence.md)。该单版本阶段三个验证窗口合计659项/91文件通过。后续控制/网络兼容退出阶段已在新固定源码上复验844项/109文件，见[最新组合](../reports/2026-09-21-network-compatibility-retirement.md)；内部Node/Chrome和Rust计数不重复相加，均不是全仓最终候选签署。

原阶段固定证据保留，避免将历史窗口伪装成当前结果：[首次Rust整合](../reports/2026-09-20-host-health-first-integration.md)、[编译运行代](../reports/2026-09-20-host-compilation-health.md)、[引用见证](../reports/2026-09-20-host-capability-witness.md)、[idle/action-only适配](../reports/2026-09-20-host-idle-layout-adaptation.md)、[原生角色](../reports/2026-09-21-host-native-role-analysis.md)、[前一配对窗口](../reports/2026-09-21-native-checkpoint-pair.md)、[lease/finally](../reports/2026-09-21-host-lease-finally.md)、[运行机会](../reports/2026-09-21-host-lease-opportunities.md)。历史多版本策略由当前单版本要求取代，不改写旧报告事实。

## 后续实施顺序

先在原owner中继续补齐所声明必要能力的语义与变换后行为、更多独立调用机会，以及真实采用后同代证据。`uncoveredSlices`必须真实列明；机会覆盖只到managed主流lease，不能凭函数名或注册表关闭全部能力。场景反例需合法JS且重新固定candidate hash，不得全靠unknown-sha或语法错捕获。

旧controller/inject拒绝型stub及专属测试/spy已经退出，安装preload也不再借用旧副本或回退TypeScript，见[控制入口退出](../reports/2026-09-21-controller-entry-retirement.md)。Tailscale/Serve的显式兼容路径、bootstrap旧writer/选项和JSON/schema占位也已经退出，见[NET-01](NET-01-box-local-network-boundary.md)。接续收束仍未迁移的handover/compact控制及其必要daemon能力。优先当前功能owner和准确依赖，不重做已完成的current-state、通知、材料管理等阶段，不另起平行工程。现行Acorn作者探索与Rust健康验证不是自动互相回退；是否仍需作者能力及其退出随原HCR迁移核实，不能仅删依赖而丢必需行为。

长期观察继续核对容量、源重启/变化、迟到结果、检测器退出和独立投递。当前通知显示local-only；接收Host处于同故障域时，不能为了投递放宽ownership/profile/model门，独立出口与凭据须明确授权。已有合法modeld执行不能被健康服务故障或Server关闭带倒。

最后随CLI-05形成完整候选，完成独立审查、正式安装宿主与生命周期、已授权原生/Provider/App验证。首个纵切或静态+ABI窗口不是完整交付上限。

## 责任与依赖

| Owner | 责任 |
| --- | --- |
| HOST-01 | Rust/Oxc、有限语义规则、当前合同及跨语言/制品一致性 |
| [HCR](README.md#host-capability-recovery)/[HCR-04](HCR-04-capability-profile-upgrade.md)/[CONT-07](CONT-07-current-context-control.md) | profile作者/实际加载/相关原生资格，保留唯一writer |
| [T44](T44-host-ops-continuous-sensing.md) | Server所属安装级producer、加载与检测器健康 |
| [T41](T41-continuous-observation-and-alerting.md)/[OBS-01](OBS-01-incident-intake-and-detection.md)/[OBS-04](OBS-04-bounded-observation-storage.md) | 原库intake、condition、证据、容量、去重与恢复 |
| [T45](T45-template-webhook-delivery.md)/[T55](T55-custom-receiver-delivery.md) | 原投递/接收者资格/同故障域与独立出口 |
| [T40](T40-persistent-release-and-rollback.md)/[T50](T50-template-ops-release-proof.md) | Rust与Node成套发布、正式宿主/退出/重启资格 |
| [CLI-05](CLI-05-implementation-follow-through.md) | W3依赖排序、共享入口、无旧兼容最终交付和W4候选冻结 |

无关纯HTTP/权限/回执/页面与材料迁移可以并行；compact/startup/原生恢复先核对应当前来源，不要求先完成全仓无关checker。采用或真实调用另核目标/授权；自动新profile派生、自动adopt和通用升级平台不是本票默认范围。并行VOICE规划是独立后续，不插队本阶段。

## 验证入口与完成边界

使用声明Bun1.3.14运行`node scripts/verify-host-health.mjs core`和`integration`。显式隔离原生测试使用`GROKBOX_TEST_NATIVE_CONTINUITY=1 GROKBOX_TEST_NATIVE_NODE=<native-node> node scripts/verify-host-health.mjs native-pair`；不再接受旧original/candidate选择器。只读磁盘资格通过`scripts/qualify-host-health.ts`的明确source/worker/binary-directory与candidate-recipe；它不发布profile或执行Host。

公开测试独立于私人源；原生资格只在明确环境读取/隔离执行指定声明和自有worker存储。正常、缺口、合法语义破坏、source/loaded分代、同代原引用被换、首次采样前明细丢失、retain→intake中断、重启不重发、正证据恢复和child结算都须覆盖。现场验收只进入[LIVE](LIVE-integration-validation.md)对应Host/context/monitor/install等场景，不把报告存在写成ready。

关闭本票要求：必需检查无未声明缺口、必要负事件可进原故障出口、原生/静态/运行/投递事实不混、正式制品和消费者一致、Server/分析失败不干扰合法执行，且旧平行实现与实时兼容已退出。当前整体qualified=false，未授权的采用、模型费用或外部通知不随源码完成自动发生。
