# T54 — 可配置接收 Bot、命名目标与确定性路由

## Status / Goal

**Planned · Spec-only。** 默认一个目标即可工作；允许用户指定任意获授权的官方/custom Bot，进阶按事件处理需求分流。不是自动选择模型或新通知平台。Owning contract：[Spec §6.3](../roadmap/template-ops-automation-spec.md#bot-routing)、[§6.5](../roadmap/template-ops-automation-spec.md#configuration-operations)、[本轮决策](../decisions/2026-09-17-ops-routing-and-authorized-issues.md)。

## Depends-on / Modules

依 T51 配置/CAS 与 T43/T53 的 native identity/Routine port 合同，可用 Fake 并行完成规则；不等 T47 深诊断或 T49 维护。交付给 T45/T46/T55 的 binding/RouteDecision 是同一类型，不留模板专用第二分支。

kernel `internal/ops/routing.ts`、`policy.ts`、`notification.ts`、`ops.ts`；box-runtime `internal/io/ops-policy.node.ts`、既有 ConfigurationWrite；CLI `commands/ops.ts` 与 T53 native adapter。模型目录/分配只读引用，既有 models writer 不迁移。

## Work

实现 targets 偏好与 private bindings map，default 便利 bind 与 targets bind 调同一用例。精确解析 Bot/Routine/scope，展示当前有效模型证据/数据去向并取得同意；不因名称相同替换目标。绑定已有对象不得改其 persona/模型/其它任务；新建用 T53 且独立确认。

实现 ordered-first-match：全局功能/影响门在规则前；有限 when 字段 AND、字段内数组 OR；explicit suppress/default/fallback references，目标 capability 失败就 blocked，不改试下条规则。routing.enabled=false 使用 default，而不是停告警；无命中也使用 default。缺目标/错枚举/重复 ID/循环/过大配置拒绝，显式 shadowed rule 提示。

固定 RouteDecision 的 work/episode/revision/intent/audience、policyRevision/target/binding、模型证据、dataPolicy/reportTarget/预算；升级不原地改旧决策。只读 config effective/routes validate/explain/test 不查上游、不发 HTTP、不写 incident。targets verify 是明确只读 native 操作，真实 POST 保持 T53 invoke 的独立权限。

配置保存一个 ops-policy.json，export 仅逻辑 alias/偏好；import 后未配对 blocked。禁用/移除引用/rebind CAS、旧原型 singular→default 显式迁移、off/预算/overrides 保持。模型变化默认 require-rebind，不能让路由创建第二个 modelId 真相源。

## Executable acceptance

实现时创建并运行：

```bash
bun test packages/runtime-kernel/test/ops-routing.test.ts test/ops-targets-cli.test.ts test/ops-config-cli.test.ts
bun run typecheck
```

前两项由本票创建，配置测试与 T51 共用。Oracle：单 default 同旧轻量用户行为；普通通知→cheap、诊断→analysis、critical-notice 不自动加诊断；关闭规则仍 default；错 target 不静默掉到其它 Bot；custom 绑定不改模型/归属；同 Bot 多 alias 规范化；配置并发/目标禁用/克隆不复活旧绑定；rules test 对网络、数据库写、模型、Host signals 的计数为 0。每段 JSON 示例成为 schema roundtrip fixture；secret/真实身份不进入 portable export。

## Forbidden / Non-goals

不支持任意表达式、泛型 HTTP URL、广播/自动模型排名、按用户名跨账号路由、模板专用 CRUD、Bot 自改 routing/grant。高成本/高严重度不授权维护，路由关闭不影响用户已有 Bot 运行。

## Done evidence / Next

提交规则/配置/source CLI 证据与接口完整性，声明 native 配对未证范围。T55 完成真实通知链里的冻结决策消费/故障边界，T50 再做固定构建的 packed/native lane。不得把纯路由正确称作消息已收到。
