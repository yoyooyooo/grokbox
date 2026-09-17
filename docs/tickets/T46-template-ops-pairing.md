# T46 — 模板 Webhook 蓝图、配对与按需 Skill

## Status / Goal

**Planned · Spec-only。** 导入 grokbox template bot 后，用户能显式配对本安装的监测出口，并得到独立、可撤销的原生 Webhook 任务；模板不复制密钥或授权。Owning contract：[Spec §3](../roadmap/template-ops-automation-spec.md#authority)、[§10](../roadmap/template-ops-automation-spec.md#surface)。

## Depends-on / Modules

依 T43 原生 routine/clone 能力、T45 delivery/claim、T51 默认配置和 T53 通用 Agent/Routine apply 合同；Fake 接线可提前，不依赖 T47/T49 自动诊断/维护完成。

`packages/cli/src/template-recipe.ts`、`gateway-automation.ts`、`commands/template.ts`、`commands/ops.ts`、`skills.ts`；`scripts/templates/grokbox.recipe.json`、`skills/grokbox/SKILL.md` 与实现时新增的 `skills/grokbox/ops.md`。配置通过 `ops-policy.node.ts` 接回 ConfigurationWrite，不能直接改 JSON/产品 SQLite。

## Work

先实现 user 默认偏好的 `unpaired → paired-brief-notice` 显式绑定，核对安装、账号/team/backend scope、精确 Bot ID、routine revision 与本地 secret ref；诊断与维护另启。配对时告知首次提醒可能有原生推理费用，无回应不持续唤醒。status 分开 requested/effective/blockedReason，不输出秘密 URL；bind/rebind/unbind/rotate 都有 expected revision、读回与 unknown 恢复，不自动领用名字相同的 Bot。

优先以原生支持的禁用 routine 蓝图分发，导入后生成新 endpoint/secret 再激活；若 T43 证明原生 recipe 无法安全禁用/隔离，则使用模板自带 bootstrap 在配对后创建任务，不能伪造 routines 字段已经完成。所有写入复用 T53 唯一 Routine apply/enable/disable 程序走已资格化原生接口，不另造模板专用 CRUD。

新模板、复制、重装、恢复备份不得继承旧 installId/endpoint/grant/投递记录；轮换后旧 bindingRevision 拒绝执行，卸载只删/禁用本安装创建且身份匹配的任务。原生动作结果未知时保留 pending，不重复创建无限任务。

内置模板 Bot 继续默认官方模型；用户另外指定的接收 Bot 可以是 custom，不因本票模板默认而拒绝。只在合法 ops wakeup 加载已安装版本 `--topic ops`；入口保持现有小预算，旧版 CLI 明确 unsupported，不把整份 Spec 塞进 prompt。证明 native tools allowlist/执行身份边界；无法限制自动唤醒的任意 shell 时禁用智能维护入口，只允许固定只读报告。

## 2026-09-17 补充：默认提示与通用 CLI

新增 [T51](T51-ops-capability-presets.md) 的 user/maintainer 配置入口指引和 [T52](T52-consented-support-issues.md) 的 issue 问询分支：默认通知只简述异常、询问是否准备脱敏稿后结束。用户答应准备不等于提交；实际提交须 exact 预览与受信确认。模板 skill 不能把「维护者模式」解释为自动提单/诊断/维护。

T53 create/update --routines-from 与模板配对必须共用声明 schema/managed key/disabled 默认，Webhook 不附带周期 schedule。升级/克隆不带旧 token/绑定/授权/issue consent；用户先前 off 和显式覆盖保持。默认小提示不依赖运行整份运维 Spec，也不自动探索源码/消耗模型排障。

追加测试：正常配对后 user 默认 brief 生效、未配对 blocked、普通 source 更新不唤醒、maintainer preset 不扩大 grant、用户拒绝/不回复不重复提醒、模板与直接 CLI 的 Routine read-back 一致。

## 可配置接收者补充

配对改为 [T54](T54-ops-targets-and-routing.md) 的命名 bindings；template import 只提供 default 的便利蓝图，不占有所有通知。`targets bind` 可使用任意当前获授权的现有 Agent/Routine，先核对模型/数据/工具能力；不得重写用户 Bot persona、其它 Routine、模型或身份。默认 API/配置与高级多目标共用一个原生程序。

generic ops topic 可由模板和自建接收 Bot 的原生 Routine 按需加载；模板「不自行切换自己的模型」约束保留，不禁止用户显式创建已配好 custom model 的接收者。clone/export 只带别名/偏好，重绑模型变更与备用数据同意见 T54/T55。

追加测试：非模板 custom Bot 可配对、官方模板默认不变、便宜/分析两个目标独立 endpoint、同 Bot 多 alias 不能扩大预算、model/data change 未重新确认时新自动投递受阻、绑定不修改现有用户配置。

## Executable acceptance

实现时新增 `test/template-ops-pairing.test.ts` 与 `test/ops-policy-cli.test.ts`，并运行：

```bash
bun test test/template-ops-pairing.test.ts test/ops-policy-cli.test.ts test/template.test.ts test/skills.test.ts
bun run typecheck
```

测试验证两个 import 得到不同 binding/secret、无 credential 出现在 recipe/package/output、repeat bind 幂等、错用户/改名不误绑定、clone/restore 强制复核、rotate/revoke 后旧 payload 不再准入、部分创建/ACK 丢失对账、失联卸载不误删别人的 routine。模拟旧 CLI/缺主题必须有明确 gap；技能新主题只在真实命令到位后注册。

原生验证另需一次性官方 Bot，导入→配对→合成事件→Bot 解释→禁用；确认它不改变自己模型，不因模板 import 自动安装 collector 或授权维护。未验证原生工具权限时记录 automation mode 的降级，不以 prompt 文字代替硬门。

## Forbidden / Non-goals

不发布现役模板、不创建生产 Bot/routine、不继承发布者 ID/secret、不给模板通用 shell 控制权、不将安全审批埋在 gettingStarted 或 `--yes` 默认值中。无 Host/source 变更。

## Done evidence / Next

保留 template/schema/skill/packaging 的一致性证明与配对恢复状态；T47 从有限能力启动诊断，T49 的 grant 由用户另开，配对本身不授权 Host 切换。
