# T50 — 持久服务、默认提醒与分层发布验收

## Status / Goal

**Partial / M2–M4。** daemon已持有通知sender及经明确配置的collector，modeld已持有必要存储维护；canonical安装意图、调用者退出、同路径Node重启与游标接续已有实现和离线证明。Box开机注册/自启、全安装容量与真实原生端到端交付仍未完成，不把本票写为Spec-only或全Done。 [Spec §11](../roadmap/template-ops-automation-spec.md#tickets)。首发验收用户不保持CLI/网页/Bot回合也能持续观测、保存有界现场并收到已配置目标提醒；不包含自动Issue或自动维护。OBS-06拥有证据/存储成套测试，本票拥有服务安装和真实用户旅程。

## Depends-on / Modules

复用T40服务/持久安装。当前source/drain由collector拥有，sender由现有daemon拥有，必要storage-maintenance由modeld的子Scope拥有且不随通知关闭；共享既有SQLite/outbox与文件owner，不新建scheduler。collector服务内装配已通过本轮实现，开机/平台生命周期仍为本票/T40前置。首发依OBS-00–06、T43–46/T51/T53/T54最小路径；不依T47–49/T52/T55高级/T56。

## Work

施工顺序再分两个出口，避免集成依赖成环：T50-install先提供受管服务/临时安装fixture，与OBS-04/05并行，不等待OBS-06；OBS-06消费已存在的fixture完成组合证明；T50-release最后消费OBS-06回执完成发布门。两个出口仍归本票，不新建第二部署账本。

通过受支持的现有服务owner安装、启动、停止、重建和读取运行清单；不假设systemd、不改官方supervisor、不让Bot临时nohup一个loop。runRoot/durableRoot/scope可追溯，退出调用shell/原生Bot后仍有collector。读取和配置保存不安装服务。

编排source/本地drain/notification/GC有界子Scope，单实例与取消/崩溃/重启恢复可证，慢上游源不拖本地检测。诊断背压不能变执行业务错误；storage off/notice off语义按T51，不误关必要回收。

修复现有process.log长期fd写入路径时消费OBS-04受管有界sink；暂存/归档/DB全计量。长时实际文件平台期、源丢失gap、预算保留与rollover后可取证是首发门。

README/运维手册/Skill/包内registry必须与真实可用命令同版本，默认只提醒、无自动Issue、数据与成本告知清晰。市场发布是独立操作，不因本票实现而自动执行。

## Executable acceptance

阶段性真实E2E统一按[LIVE的W0–W7](LIVE-integration-validation.md#window-order)与[执行手册](../maintainers/live-end-to-end.md)执行。先签已实现的单条/自动新告警链，再签无人值守安装和长期容量；后者若未完成，不得将默认自动提醒的发布承诺静默降为手动collector。源码部分已有`ops-automatic-notification.test.ts`、`ops-automatic-cli.test.ts`及`storage-maintenance-lifetime.test.ts`，固定证据见[自动通知回执](../reports/2026-09-19-automatic-notification.md)，不代替安装资格。

当前实际用例为`monitor-service-lifetime.test.ts`、`test/monitor-service-packed.test.ts`、`daemon-socket-recovery.test.ts`和`test/incident-evidence-integration.test.ts`；通过`pre-e2e-observation`组合复验，不创建同义空测试。实际进程层覆盖Linux持有fd的服务门、准确socket owner和强杀后的游标恢复；缺失/损坏证据库不由重放安装自动重建。实际发布Node CLI、临时真实进程/DB/HTTP验证安装幂等、调用者退出、独立重启、断网/撤销/GC期间读取、unknown恢复和单实例；不得以detach/父PID或HTTP200代替完整生命周期。

原生最小旅程：单目标配对→真实异常→固定revision→Webhook→Bot只提醒→用户随后取证；不自动执行命令/模型诊断/Issue询问。取消/禁用/原生任务清理需exact本次对象和终结证据。真实请求/费用/重启另获批准。

## E2E前服务切片

`runtime monitor install`预览不写，确认后先初始化/迁移观测库，再通过原配置CAS保存`daemon.observation.runRoot/agentIds`。复用原operation回执；相同操作重入先核对指纹，不重新初始化丢失数据库。命令不启动daemon，但已运行的daemon会在轮询后采用配置。`runtime monitor service`只查询既有服务，不补启动。

原daemon监听器增加同路径服务所有权：Linux使用已有advisory fd gate，只有已登记的准确socket inode、确证已死的进程身份和拒绝连接同时成立时，才删除遗留socket重新bind；未知/损坏/旧无标记socket保留阻断。服务退出先结算collector、sender和其余资源再释放门，不遗留争抢失败产生的后台管理器。其他平台仍靠独占bind，不宣称同等强杀恢复。

采集器已覆盖Host/control两个来源、配置变更/停用后的顺序退出、原生run health与进度、通知off下继续采集。source failure→固定revision→受管sender→loopback HTTP的组合及旧源事件晚到不补发已有证明；当前不是操作系统自启安装器、生产Provider/App或完整物理配额证明。[固定回执](../reports/2026-09-19-pre-e2e-observation.md)。

## LIVE routes / 分lane

- 首发N：ROUTINES、RECEIVERS最小范围、OBSERVER-LIFETIME、OBS-EVIDENCE、OBS-STORAGE、OBS-SAFE-RETIREMENT。
- 后续A：T47受托自主与T55高级接收者，独立AUTONOMY条目；不改首醒默认。
- 后续M：T48/T49自动维护与CONT恢复各自合同，独立MAINTENANCE/OWNERSHIP-CONTINUITY。
- 用户支持U：T52/T56 Deferred，不占首发关闭条件。

全部当前现场状态只在[LIVE唯一索引](LIVE-integration-validation.md)，各来源票只写实现/离线/review。不因一次restart通过关闭整表。

## Forbidden / Exit evidence

不切未合入feature到live、不自动提Issue、不借安装权限作模型花费/Host维护，不用清历史制造容量稳态。关闭需固定候选、安装/卸载/恢复回执、独立review、已验范围与剩余原生缺口；功能存在不能等于本安装已开启。
