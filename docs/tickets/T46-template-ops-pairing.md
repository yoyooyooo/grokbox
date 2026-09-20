# T46 — 配对、只提醒入口与独立运维模板

## 新版配对与可选测试

本票须按 [Agent-first Spec](../roadmap/agent-first-cli/spec.md#管理异常与通知)把接收目标配置、必要权限、启用、可选测试及真实投递分开。配置/授权齐备可启用，不要求 accepted seed 或人工确认已见测试提醒；test 不伪造 incident，verify 不发送。下文旧 activation 实现和回执保持原事实，不作为新版前置。

与 T45/CLI-02/CLI-04 共同验证健康首装、不测试启用、测试失败/unknown、资格变化与撤销；当前结果归 [LIVE](LIVE-integration-validation.md#live-ops-observer-lifetime)。关键配对/授权能力早验证，整合候选集中验，不要求维持施工期连续服务。

## Status / Goal

**Partial：首次目标配置、disabled Routine、私有配对、原生 enable、接收者授权/撤销、独立可选测试已接入管理 Server、CLI 与真实 Web；sender/collector 随管理 Server，真实原生接收、完整宿主安装和独立模板仍未完成，M3未关闭。** [Spec §10](../roadmap/template-ops-automation-spec.md#surface)。提供默认告警只提醒的接收流程，同时保留通用Bot受托后的完整自主操作能力。新增`grokbox-ledger`作为独立可分发模板，不要求用户安装多个Bot。

## Depends-on / Modules

依T43/T45/T51/T53/T54最小目标和OBS-02/03。CLI `template-recipe.ts`、`commands/template.ts`、`commands/ops.ts`、`skills.ts`；实现时新增`skills/grokbox/ops.md`、`scripts/templates/grokbox-ledger.recipe.json`，复用现有stage/publish/import，不在本次文档修改生产recipe。

## 首次配置、Routine 与私有配对

`notification settings get/apply` 经 canonical 配置 writer 只更新选定目标、模式和预算，保留其他目标及系统设置；这不是私有授权。`notification receiver blueprint` 返回固定 disabled reminder 定义，`routine apply` 通过原 provision owner 保留单次原生 dispatch guard。新建/更新保持 disabled；具体输入与命令见 [Routine Skill](../../skills/grokbox/routines.md)。

`notification receiver bind` 先核对配置、原观察数据库身份、受管 key、精确 disabled Webhook/revision 与 Gateway 代际；独立 `notifications.bind` 能力才可请求凭据。确认后在原私有 capsule 原子保留 enrolling 与主体隔离的管理回执，再至多请求一次原生凭据，重核后一起保存 prepared 与成功回执。普通读面没有 endpoint/key/prompt；prepared 不是未来投递许可。原生 Routine enable、receiver verify/enable/test 仍分别显式操作。`ops targets ...` 普通入口与旧 daemon Routine RPC 已退出，不作 fallback。

新增配对管理回执绑定安装、主体和原 request UUID，最多64条，保留在同一 capsule。查询旧成功配对不要求当前仍为同一个绑定，解绑/再绑定后仍保留原历史；相同请求不会再次领 key。unknown 不能换请求绕过，关闭管理服务会取消并等待真实凭据请求/最终本地处理，不能留下晚到写入。独立 schema/配置完成后的首次 setup 页面是 `/notification-setup`，其后进入 `/notifications` 授权或可选测试。

采用单一私有原子capsule而非分离secret与metadata的部分写入：`state/ops-pairing/bindings.json`及固定暂存各64KiB、最多8槽、0600文件。查询不领取原生凭据、不创建owner，诊断GC不删除它。unknown不能用新operation绕过；并发unbind递增revision，使晚到credential不能重新发布。旧slot新绑定要求显式unbound revision，不以清目录恢复操作。

原始准备阶段的历史验证：`ops-target-pairing.test.ts`11项，实际SQLite/provision/config/私有文件、并发与真实子进程SIGKILL；CLI测试覆盖预览、领取、重复操作与打包Node状态/解绑。`ops-pairing`组合106 pass，最新v2组合全仓2568 pass/19 skip/0 fail。准确边界见[固定回执](../reports/2026-09-18-private-target-pairing.md)。这不关闭真实原生HTTP、接收者model/行为/成本、完整备份恢复fence、首次初始化故障恢复、远端key撤销或物理安全擦除资格。

## 授权、可选测试与执行边界

新 `notification receiver enable` 在必要配置、绑定、Routine 和当前模型/所有权资格齐备后记录显式未来授权，**不需要 accepted 测试记录或人工已读声明**；不启用原生 Routine、不领新 key、不发送。独立 `test` 使用测试 work 和原 outbox/预算，不制造 incident，unknown 不阻独立启用。disable/unbind 经同一管理服务保留历史回执并撤销未来资格，旧成功 enable 的重放不复活授权。

管理 Server sender 继续原单次尝试与 unknown 防重放，模型/代际变化保持阻断。设置、私有绑定、原生调度 enable、接收者未来权限、可选测试和实际投递是六类不同事实。旧 [自动通知回执](../reports/2026-09-19-automatic-notification.md)只保留其原 seed/daemon 窗口，不能覆盖新版实际资格。当前真实结果仅归 [LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines) 和 [重新资格旅程](LIVE-integration-validation.md#live-notice-requalification)。

## Work

default或用户指定alias经统一bind核对exact Agent/Routine、scope、数据/模型/费用，secret与binding独立机器状态。普通config/模板import不能建立live endpoint/授权，绑定已有Bot不改其模型/persona/其他Routine。

模板只保留按需加载桩，入口skill分两条：合法自动brief仅展示已固定摘要/ID/可取证命令后结束；用户任务按需加载诊断/models/agents等能力并执行验证，不永久只读。Bot没有Box执行权限时仍可提醒，不能假称命令可在其本机执行。

新ledger模板默认官方模型；用户自建custom接收者经T55资格即可接入。模板不携带真实ID、Memory/transcript、endpoint/secret/grant或旧通知；原生复制安全不明时采用无活任务的bootstrap说明，配对后经T53独立建disabled Routine再明确启用。

README中英文在真实可用版本醒目标默认本地采集、已配对目标提醒、无自动Issue/正文、原生唤醒可能收费、关闭方法和保留期限。本轮只可标规划，不把不可用命令塞进已安装Skill。

## Executable acceptance

当前首次配置到后台未来投递的管理旅程由 [Node setup](../../test/notification-setup.test.ts) 和 [生产浏览器 setup](../../apps/web/test/setup-browser.node.ts)验证，不预置 Routine 或配对。覆盖零测试启用、精确 native ID、丢凭据回执守卫、历史绑定查询、关闭期间取消、权限/CSRF、刷新恢复和窄屏。原生事实与 HTTP 接收端均隔离合成；固定源码及最终计数由 [CLI-05](CLI-05-implementation-follow-through.md)统一记录，不签实际 Bot/用户收到。

仍待模板范围新增`test/ops-template-pairing.test.ts`、`test/ledger-template-contract.test.ts`；回归`test/template.test.ts`、`test/skills.test.ts`和packaging。验证两个导入实例不共享endpoint/secret/identity，解绑只影响本binding，默认不发命令/Issue/诊断；用户明确后同Bot仍可进入正常自主任务。

实际Node包中的主题/命令版本匹配；没有对应能力就unsupported。市场stage/publish和真实Bot安装均需单独授权，不以离线recipe测试声称已发布。

## Forbidden / Non-goals / Exit

不对任意Bot强写persona，不克隆已激活Routine，不在提示词伪造权限沙箱，不默认自改模型，不建立第二套工具链。原生配对与模板隔离只在[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)记当前进度，首次提醒后的取证引用接[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)。
