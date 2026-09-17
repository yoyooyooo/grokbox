# T51 — 默认用户能力、维护者预设与配置治理

## Status / Goal

**Planned · 2026-09-17 Spec-only。** 普通用户获得低成本的最小异常提醒；维护者能单独开启需要的观察/分析，配置不把可见性、成本与执行权限混成一个档位。Owning contract：[Spec §6.1](../roadmap/template-ops-automation-spec.md#capability-tiers)、[§6.2](../roadmap/template-ops-automation-spec.md#configuration)、[补充决策](../decisions/2026-09-17-ops-defaults-support-and-routines.md)。

## Depends-on / Modules

纯规则/配置可与 T43 并行，原生支持作为 effective 的能力输入，不等待 T48/T49。复用 ConfigurationWrite 和 T41，不能在模板里另写一套默认值。

kernel `internal/ops/policy.ts`、`ops.ts`、已有 configuration command；box-runtime `internal/io/ops-policy.node.ts`、`monitor-store.node.ts`；CLI `commands/ops.ts`；T46/T50 消费预设与安装规则，维护手册解释，不复制可执行常量。

## Work

实现 user/maintainer versioned presets 和 leaf overrides；monitor、本地深观察、用户影响提醒、maintainer 通知、auto-diagnose、canary、维护、issue prepare/submit 分开。user 默认不运行深诊断，只对 confirmed user impact 且合法自修不可用/失败产生一次 brief-notice；不能调用模型或先尝试修复来判断这个条件。

正常启用服务的新安装使用 user 基线；仅安装 CLI/GET/import 不启服务/活 Webhook。未配对显示 blocked-unpaired，旧安装 off/预算/覆盖在升级中保留。维护者 preset 不自动开启原生推理、主动探针、维护 grant 或公开 issue；通知对象不因 preset 改为发布者账号。

同一 ops-policy.json 的 preset/presetRevision/overrides、binding 与 grants 用唯一 schema/CAS writer；导出只含可移植偏好。实现 config show/preset/set/apply/export/upgrade 的 preview、expected revision 与读回，preset 切换保留显式 overrides，reset 需确认且不生成 grant。environment/临时 flags 不可越过授权或扩大预算。

effective 与 requested 分开，返回 valueSource/blockedReason；unknown/无 capability/过期 binding/预算/坏配置均不伪装开启或写回 desired。user 自动首醒上限和 critical 配额按 Spec 唯一 policy 实现，抑制有记录；native 不提供 token 硬门时保留 not_proven。用户确认前的准备/提醒逻辑无 GitHub 网络。

## Executable acceptance

本票创建并运行：

```bash
bun test packages/runtime-kernel/test/ops-presets.test.ts test/ops-config-cli.test.ts packages/box-runtime/test/ops-policy-migration.test.ts
bun run typecheck
```

以上新文件目前不存在。覆盖 fresh user、未配对、显式 off、maintainer 不签 grant、preset 保留覆盖/reset、未知字段、并发 CAS、旧 schema/坏文件/备份恢复、secret-free export、旧配置升级不新增收费能力、临时 flags 只能收紧。所有 GET 写入/服务启动为 0。

FakeClock 验证无变化/无用户影响/同周期/拒绝或不回复/预算耗尽均不额外唤醒；普通异常首醒只走 brief path，模型诊断、GitHub 请求、Host mutation 均为 0。控制器/通知读取同一 effective projection，不各自重新猜默认值。

## Forbidden / Non-goals

不创造超级 maintainer 角色，不按用户名/环境检测隐式开 debug，不开启真实服务或真实 token 消费，不把 autoSubmit=true 写入配置，不自动提单/附件，不为配置升级 modeld/依赖。

## Done evidence / Next

交付 preset/schema/迁移和真实 CLI 预览/读回证明；T44–T47 与 T48/T49 分别消费观察、诊断和 grant 门，不能回退成单一 mode。T50 验收默认用户安装，不等全自动维护。
