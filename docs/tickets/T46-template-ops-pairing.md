# T46 — 配对、只提醒入口与独立运维模板

## Status / Goal

**Partial：私有配对/撤销、接收者预检、显式发送、未来提醒授权与daemon sender已集成；真实原生接收、collector持久安装和独立模板仍未完成，M3未关闭。** [Spec §10](../roadmap/template-ops-automation-spec.md#surface)。提供默认告警只提醒的接收流程，同时保留通用Bot受托后的完整自主操作能力。新增`grokbox-ledger`作为独立可分发模板，不要求用户安装多个Bot。

## Depends-on / Modules

依T43/T45/T51/T53/T54最小目标和OBS-02/03。CLI `template-recipe.ts`、`commands/template.ts`、`commands/ops.ts`、`skills.ts`；实现时新增`skills/grokbox/ops.md`、`scripts/templates/grokbox-ledger.recipe.json`，复用现有stage/publish/import，不在本次文档修改生产recipe。

## 已实现的准备阶段

`ops targets list/show/bind/disable/unbind`只运行在Box本地。bind先核对canonical配置、monitor安装scope、T53受管key、精确disabled Webhook定义/revision与Gateway代际；preview不领key。确认后持久记录enrolling，再至多调用一次原生凭据接口，重核后保存prepared。普通状态不返回endpoint/key/prompt；prepared始终不是合格接收者，不自动enable、发POST或改模型。

采用单一私有原子capsule而非分离secret与metadata的部分写入：`state/ops-pairing/bindings.json`及固定暂存各64KiB、最多8槽、0600文件。查询不领取原生凭据、不创建owner，诊断GC不删除它。unknown不能用新operation绕过；并发unbind递增revision，使晚到credential不能重新发布。旧slot新绑定要求显式unbound revision，不以清目录恢复操作。

新`ops-target-pairing.test.ts`11项，实际SQLite/provision/config/私有文件、并发与真实子进程SIGKILL；CLI测试覆盖预览、领取、重复操作与打包Node状态/解绑。`ops-pairing`组合106 pass，最新v2组合全仓2568 pass/19 skip/0 fail。准确边界见[固定回执](../reports/2026-09-18-private-target-pairing.md)。这不关闭真实原生HTTP、接收者model/行为/成本、完整备份恢复fence、首次初始化故障恢复、远端key撤销或物理安全擦除资格。

## 激活与执行边界

`ops targets activate`在原outbox的accepted测试记录、当前绑定/模型/所有权和操作人明确已见提醒的声明齐备后，持久授予未来work权限；不启用Routine、不领新key、不启动collector、不补旧积压。sender复用T45单attempt程序，模型/代际变化停发，disable/unbind撤销尚未发送的资格。人工声明与程序观察分开，HTTP200不是用户已读。实现证据见[自动通知回执](../reports/2026-09-19-automatic-notification.md)，当前真实结果仅看[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)和[重新资格旅程](LIVE-integration-validation.md#live-notice-requalification)。

## Work

default或用户指定alias经统一bind核对exact Agent/Routine、scope、数据/模型/费用，secret与binding独立机器状态。普通config/模板import不能建立live endpoint/授权，绑定已有Bot不改其模型/persona/其他Routine。

模板只保留按需加载桩，入口skill分两条：合法自动brief仅展示已固定摘要/ID/可取证命令后结束；用户任务按需加载诊断/models/agents等能力并执行验证，不永久只读。Bot没有Box执行权限时仍可提醒，不能假称命令可在其本机执行。

新ledger模板默认官方模型；用户自建custom接收者经T55资格即可接入。模板不携带真实ID、Memory/transcript、endpoint/secret/grant或旧通知；原生复制安全不明时采用无活任务的bootstrap说明，配对后经T53独立建disabled Routine再明确启用。

README中英文在真实可用版本醒目标默认本地采集、已配对目标提醒、无自动Issue/正文、原生唤醒可能收费、关闭方法和保留期限。本轮只可标规划，不把不可用命令塞进已安装Skill。

## Executable acceptance

待新增`test/ops-template-pairing.test.ts`、`test/ledger-template-contract.test.ts`；回归`test/template.test.ts`、`test/skills.test.ts`和packaging。验证两个导入实例不共享endpoint/secret/identity，解绑只影响本binding，默认不发命令/Issue/诊断；用户明确后同Bot仍可进入正常自主任务。

实际Node包中的主题/命令版本匹配；没有对应能力就unsupported。市场stage/publish和真实Bot安装均需单独授权，不以离线recipe测试声称已发布。

## Forbidden / Non-goals / Exit

不对任意Bot强写persona，不克隆已激活Routine，不在提示词伪造权限沙箱，不默认自改模型，不建立第二套工具链。原生配对与模板隔离只在[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)记当前进度，首次提醒后的取证引用接[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)。
