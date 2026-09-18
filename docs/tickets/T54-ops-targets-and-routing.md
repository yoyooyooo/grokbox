# T54 — 单目标配对与后续有限路由

## Status / Goal

**Planned / Spec-only；首发只要求最小单目标。** [Spec §6.3](../roadmap/template-ops-automation-spec.md#bot-routing)。复用ops.targets/defaultTarget，任意用户有权使用的原生Bot可作为接收者，不限模板。

## Depends-on / Modules

依T51配置和T43/T53原生port合同；实际bind经T53能力接线。kernel `internal/ops/routing.ts`和policy，box-runtime `ops-bindings.node.ts`、原outbox frozen decision，CLI `commands/ops.ts`。不建router.db或模型目录。

## Minimum Work / 首发出口

一个default或指定alias、routing.enabled=false仍投向default。缺/禁用/未配对返回blocked，不猜名字/最近Bot、不广播/自动新建。bind核对installation/scope/exact Agent/Routine/revision、secretRef、数据/模型/工具与成本指纹，预览后写受保护机器状态；普通config只写偏好。

command/ID仅向相应已绑定目标披露，默认safe bot-notice。目标无Box执行权限仍能提醒，标注box-local限制。模型分配仍归models/native，不在ops指定provider/key/modelId。改模型/供应商/数据范围要求重绑；禁用阻止新投递，原在途unknown保留对账。

## Later routing scope

有序首匹配、枚举AND/数组OR，未命中default；最多8目标/32规则/每规则2显式备用，未知字段/重复ID/不存在引用/循环拒绝。每阶段只一个primary，首命中无权限不试后续规则。T55接高级fallback/交接，本票不以高级全部完成阻塞最小模式。

## Executable acceptance

待新增`packages/runtime-kernel/test/ops-routing.test.ts`、`test/ops-targets-cli.test.ts`。最小组验证单目标完整旅程、无配对blocked、同真实Bot多alias共享额度、变binding旧attempt不重发、配置不创建Bot/Routine/模型副作用。高级组另验首匹配/遮蔽/循环/未命中/fallback拒绝，不能将其跳过算已支持。

所有目标状态列requested/effective/blockedReason，route explain纯读取不发HTTP/模型。packed CLI与原生绑定分证，实际接收能力见[LIVE-OPS-RECEIVERS](LIVE-integration-validation.md#live-ops-receivers)。

## Forbidden / Exit evidence

不建立新配置根，不用Bot/Payload控制target/severity来选贵模型，不复制grant，不让路由扩大数据/执行权限。关闭最小部分时明确剩余高级范围；T50只消费首发已证部分。
