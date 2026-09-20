# T50 — 持久服务、默认提醒与分层发布验收

## Status / Goal

**当前前置实现已提供；环境/独立审查/原生发布资格仍Open。** 管理 Server 已接管 sender/collector，modeld 保留诊断和执行owner维护；已提供精确服务注册/状态/退场命令、共同诊断容量接纳、执行/context/provision安全收缩，以及真实Node重启接续和拒重入反例。服务安装只对已可用且启用linger的systemd用户管理器生效，目标Box缺少该前提时保持ENV阻断；不声明OS全盘quota、任意整机回滚识别或已经真实送达。 [Spec §11](../roadmap/template-ops-automation-spec.md#tickets)。首发验收用户不保持CLI/网页/Bot回合也能持续观测、保存有界现场并收到已配置目标提醒；不包含自动Issue或自动维护。OBS-06拥有证据/存储成套测试，本票拥有服务安装和真实用户旅程。

## Depends-on / Modules

本次验收范围按 [重建 Spec](../roadmap/agent-first-cli/spec.md)重定，不把旧单条提醒/旧 v2 成套采用作为开工前置。施工期间无需持续可用；新版集中验收必须覆盖常驻管理服务、独立 modeld、Web/CLI 退出后持续工作，以及明确启用后的自主投递。视觉与功能分开，用户验收后才日常吃狗粮。下文既有实现和回执仅是可复用来源。

复用T40服务注册和原有生命周期。source/drain由collector拥有，sender与collector的进程寿命由管理 Server拥有，诊断/执行维护由modeld子Scope调用原owner且不随通知关闭；共享既有SQLite/outbox与文件owner，不新建scheduler。操作系统管理器及原生Host生命周期是目标环境资格，不用模拟manager证明已开机采用。首发依OBS-00–06、T43–46/T51/T53/T54最小路径；不依T47–49/T52/T55高级/T56。

## HOST-01 的新增成套出口（2026-09-20）

新版候选必须包括Rust/Oxc分析制品、生成wire合同与同版本Node适配，不能仅交付Server/Web而遗漏binary。当前 `test/packaging.test.ts` 已在tarball安装后检查并实际运行binary/FD分析，`test/host-health-management.test.ts` 和两个verifier Node组合覆盖子进程退出/取消、父进程死亡与原provenance→OBS接续。`/host-health` 和 `system host health` 只读取该Server持有的观察，不为页面新建watcher。

当前发布边界仍为candidate静态检查、运行证据未观测和local-only投递coverage；不得把三个规则通过或管理API可读签为实际Host已恢复、渠道已送达或Box自启。完整HOST-01识别与实际加载义务在候选冻结前完成，独立审查和现场采用仍保留。

## Work

施工顺序再分两个出口，避免集成依赖成环：T50-install先提供受管服务/临时安装fixture，与OBS-04/05并行，不等待OBS-06；OBS-06消费已存在的fixture完成组合证明；T50-release最后消费OBS-06回执完成发布门。两个出口仍归本票，不新建第二部署账本。

通过受支持的现有服务owner安装、启动、停止、重建和读取运行清单；不假设systemd、不改官方supervisor、不让Bot临时nohup一个loop。runRoot/durableRoot/scope可追溯，退出调用shell/原生Bot后仍有collector。读取和配置保存不安装服务。

编排source/本地drain/notification/GC有界子Scope，单实例与取消/崩溃/重启恢复可证，慢上游源不拖本地检测。诊断背压不能变执行业务错误；storage off/notice off语义按T51，不误关必要回收。

修复现有process.log长期fd写入路径时消费OBS-04受管有界sink；暂存/归档/DB全计量。长时实际文件平台期、源丢失gap、预算保留与rollover后可取证是首发门。

README/运维手册/Skill/包内registry必须与真实可用命令同版本，默认只提醒、无自动Issue、数据与成本告知清晰。市场发布是独立操作，不因本票实现而自动执行。

## Executable acceptance

集中真实 E2E 按 [LIVE E0–E6](LIVE-integration-validation.md#window-order)与[执行手册](../maintainers/live-end-to-end.md)执行；开发期局部探针不要求完整产品或全部模型矩阵。通知测试独立可选，配置/授权齐备即可启用；产品启用不能继续要求人工已见测试提醒。集中验收仍须证明实际投递、无人值守和容量，不得改成手动 collector 求通过。源码部分已有`ops-automatic-notification.test.ts`、`ops-automatic-cli.test.ts`及`storage-maintenance-lifetime.test.ts`，固定证据见[自动通知回执](../reports/2026-09-19-automatic-notification.md)，不代替安装资格。

当前实际用例包括`runtime-services-installation.test.ts`、`test/runtime-services-packed.test.ts`、`modeld-persistent-restart.test.ts`、`execution-retirement.test.ts`、`monitor-service-lifetime.test.ts`、`test/monitor-service-packed.test.ts`、`daemon-socket-recovery.test.ts`和`test/incident-evidence-integration.test.ts`；通过`pre-e2e-observation`组合复验，不创建同义空测试。实际进程层覆盖Linux持有fd的服务门、准确socket owner和强杀后的游标恢复；缺失/损坏证据库不由重放安装自动重建。实际发布Node CLI、临时真实进程/DB/HTTP验证安装幂等、调用者退出、独立重启、断网/撤销/GC期间读取、unknown恢复和单实例；不得以detach/父PID或HTTP200代替完整生命周期。

原生最小旅程：单目标配对→真实异常→固定revision→Webhook→Bot只提醒→用户随后取证；不自动执行命令/模型诊断/Issue询问。取消/禁用/原生任务清理需exact本次对象和终结证据。真实请求/费用/重启另获批准。

## E2E前服务切片

`runtime monitor install`预览不写，确认后先初始化/迁移观测库，再通过原配置CAS保存`daemon.observation.runRoot/agentIds`。复用原operation回执；相同操作重入先核对指纹，不重新初始化丢失数据库。命令不启动服务；新架构由已运行的管理 Server 在本地配置轮询后采用，旧 daemon collector 接线已退出。`system service get server` 查询当前管理进程和 worker，不补启动；旧 `runtime monitor service` 不保留兼容入口。原本票固定回执只支持其旧 daemon 窗口，当前 Scope 迁移及离线验证见 [CLI-05](CLI-05-implementation-follow-through.md)。

旧 daemon 窗口的监听器同路径服务所有权：Linux使用已有advisory fd gate，只有已登记的准确socket inode、确证已死的进程身份和拒绝连接同时成立时，才删除遗留socket重新bind；未知/损坏/旧无标记socket保留阻断。该旧窗口退出按当时的子资源顺序释放门；当前 collector/sender 已迁出，不得从旧证据推定新管理服务的安装资格。其他平台仍靠独占bind，不宣称同等强杀恢复。

采集器已覆盖Host/control两个来源、配置变更/停用后的顺序退出、原生run health与进度、通知off下继续采集。source failure→固定revision→受管sender→loopback HTTP的组合及旧源事件晚到不补发已有证明；这些旧组合不单独证明操作系统安装；新增注册命令与其环境要求另见[服务注册](../maintainers/runtime-service-registration.md)。生产Provider/App与完整现场证据仍需LIVE。[固定回执](../reports/2026-09-19-pre-e2e-observation.md)。

当前管理 Scope 对通知 sender 的获得、关闭、竞争 outbox 与 unknown 重启保留已有[Node HTTP/SQLite 验证](../../test/notification-management.test.ts)；旧 daemon 的 sender 状态 RPC 和 `ops notifications worker` 已退出，新 `notification status` 共用管理权限/客户端，Web 状态读取不投递。这里只关闭宿主接线的源码差额，不代替启用合同、独立测试、投递对账或生产 OS 服务验收。

## LIVE routes / 分lane

- 首发N：ROUTINES、RECEIVERS最小范围、OBSERVER-LIFETIME、OBS-EVIDENCE、OBS-STORAGE、OBS-SAFE-RETIREMENT。
- 后续A：T47受托自主与T55高级接收者，独立AUTONOMY条目；不改首醒默认。
- 新版保护：默认保全与证据支持的 CONT 恢复/交接已进入核心目标，独立 OWNERSHIP-CONTINUITY 验收，不沿用旧整类延期。T48/T49 通用自动维护仍属独立范围。
- 用户支持U：T52/T56 Deferred，不占首发关闭条件。

全部当前现场状态只在[LIVE唯一索引](LIVE-integration-validation.md)，各来源票只写实现/离线/review。不因一次restart通过关闭整表。

## Forbidden / Exit evidence

不切未合入feature到live、不自动提Issue、不借安装权限作模型花费/Host维护，不用清历史制造容量稳态。关闭需固定候选、安装/卸载/恢复回执、独立review、已验范围与剩余原生缺口；功能存在不能等于本安装已开启。
