# T46 — 配对、只提醒入口与独立运维模板

## Status / Goal

**Planned / Spec-only；M3。** [Spec §10](../roadmap/template-ops-automation-spec.md#surface)。提供默认告警只提醒的接收流程，同时保留通用Bot受托后的完整自主操作能力。新增`grokbox-ledger`作为独立可分发模板，不要求用户安装多个Bot。

## Depends-on / Modules

依T43/T45/T51/T53/T54最小目标和OBS-02/03。CLI `template-recipe.ts`、`commands/template.ts`、`commands/ops.ts`、`skills.ts`；实现时新增`skills/grokbox/ops.md`、`scripts/templates/grokbox-ledger.recipe.json`，复用现有stage/publish/import，不在本次文档修改生产recipe。

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
