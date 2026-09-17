# T47 — Bot 有界排障、解释与维护候选

## Status / Goal

**Planned · Spec-only。** 用户明确要求或独立开启自动诊断后，合法唤醒可找第一处错误事实，运行有限只读诊断，向用户说明或提交不可变维护候选；user 默认首醒只简短提醒，不进入此流程。Owning contract：[Spec §3–4](../roadmap/template-ops-automation-spec.md#authority)、[§6](../roadmap/template-ops-automation-spec.md#policy)。

## Depends-on / Modules

依 T44 的同源事实、T45 claim/报告、T46 工具权限/安装绑定和 T51 的独立诊断开关/预算。可用 Fake 原生 run 测试，真实推理/用户交付资格另列。

`packages/box-runtime/src/internal/ops/automation/diagnose.ts`、kernel `internal/commands/ops.ts`、`internal/ops/policy.ts`；CLI `commands/ops.ts` 和已注册 `skills/grokbox/ops.md`。不在 modeld 或 Host hook 加 Agent runner。

## Work

冻结 allowlist：读 doctor/status/current policy、精确 incident/STEP、HSO retain/replay 安全结果与 current loaded tuple；离线分析可写受保护派生证据但不改 source/profile/config。工具参数用已存在 ID，不接受任意 shell、文件路径、URL 或未经校验的 next 命令。

每个 delivery 使用有租期 claim；默认一活动诊断、两轮、每轮八个操作、总 120s，执行器每次检查 scope、lease 与预算。模型在原生 Bot 内运行，grokbox 不新建第二 provider/tool loop；原生不支持硬 token 限额时明示未知成本上界。

区分 provider 故障、模型分配无效、source/profile mismatch、helper/protocol 漂移、observer gap、历史 circuit 与真正执行契约失败。LLM 可提出分类和 plan，不可决定资格或发布 profile。对提示注入、危险建议、缺证据的 next 只解释不执行。

报告输出「发现/证据与缺口/实际动作/用户影响/下一步」，使用真实交付回执。维护候选只调用 plan/submit；先持久交接再结束回合，不等自己的 Host 重启。纯诊断没有后台无限监听或自动发下一轮消息。

## 2026-09-17 补充：诊断不是默认 issue 流程前置

user 的 brief-notice 只能读取已有安全摘要和报告，不能为了给用户提 issue 先运行本票。maintainer preset 也不默认授权模型诊断；只有 diagnostics.mode/用户当前明确请求与实际工具边界同时满足才进入。先有严重影响告警，不因排障超时吞掉必要提醒。

[T52](T52-consented-support-issues.md) 可在本票未启用时，用确定性模板准备已有事实；用户要求进一步诊断时再调用本票，并将成本/现场采集范围明确告知。诊断结果是草稿候选，不是用户同意公开，也不能隐式附上原始日志/对话。

追加 oracle：default user/maintainer 首醒的本票工具调用均为 0；on-request 的有限诊断仍可完整运行；输出中「已获用户同意」或 payload approval 不使 IssuePublisher 可调用；诊断失败保留 partial/既有提醒，不重复唤醒。

## Executable acceptance

创建并执行：

```bash
bun test packages/box-runtime/test/ops-diagnosis.test.ts packages/runtime-kernel/test/ops-plan-admission.test.ts test/ops-diagnosis-cli.test.ts
bun run typecheck
```

FakeBot/FakeClock/真实受限工具入口覆盖：Payload 中的 shell/URL/假批准、日志中的越权指令、错误高 confidence、错误归因、源在诊断中换代、超预算/取消、Bot 崩溃后复领、重复结果、父回合与子任务未结束。对所有恶意与越权候选断言 ControlResources/source/profile/config 写入次数为 0；诊断超时保留 partial，不输出已修复。

输入与输出 secret sentinel 零泄漏；真实可达的工具能力与文案约束分别测试。测试不能只 stub Bot 的「已安全执行」文本；需检查调用记录与后置事实。至少一个案例证明无需用户干预就能完成 read-only diagnosis→report，另一个证明低风险候选可交接但尚未执行。

## Forbidden / Non-goals

不调用 `upgrade --yes` 或拼装 shell，不让 Agent 修改自己的 grant，不自动重启 modeld/切 provider，不擅自 compact、重放工具或恢复业务任务。没有通用自动代码修复或第二 Agent 平台。

## Done evidence / Next

给出边界与预算回归、实际 CLI 路由、native 工具限制的证据或降级状态。T48 负责机器资格，T49 才有执行；本票的诊断成功不等于维护成功。
