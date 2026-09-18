# OBS-00 — 最低证据合同与真实边界覆盖

**Status：Planned / Spec-only；M0。** Contract：[Spec §2–5](../roadmap/template-ops-automation-spec.md#evidence)。这是新证据增量，不重开T41/modeld已完成切片。当前已有流/工具关系、run/tray、context维护回执，不能以字段名存在宣称完整。

## Goal / Dependencies

冻结E01–08逐故障类型的required/optional字段、来源writer、身份关系、缺口原因和可证边界；优先接回已有事实，缺instrumentation才新增。依现有Host/modeld/context contracts；T51消费合同但不成为本票前置。

## Modules / Work

- kernel新增`observation.ts`、`internal/observation/evidence-contract.ts`；复用`stream-diagnostic`、tool identity、ownership、failure-summary，不复制分类体系。
- Host的run/turn/alert/context观测只输出有界安全事实；modeld原outcome writer补capture元组；不引入Effect/SQLite/CLI依赖。
- 建立source→E01–08矩阵：已存在/需接线/缺捕获/原生待资格。每项绑定测试、schema、失效条件；机器可检查required缺口，无完整度百分比。
- 区分occurrence time与capture time、incident-time loaded与query-time current。dispatch/TURN/STEP/native request/parent/aux关系均携带basis，跨代冲突明确拒绝合并。
- 工具回执分开generated/released/native-started/returned/result-accepted/外部业务结果未证；checkpoint按真实owner回执，不能将context成功扩展为全任务完成。
- serializer/安全投影/读者/CLI各层往返保留字段和缺口；未知值不补0，旧事件保持legacy身份来源。

## Executable acceptance

以下为**待新增测试**，实现时运行：

```bash
bun test packages/runtime-kernel/test/observation-evidence-contract.test.ts packages/box-runtime/test/observation-boundary-receipts.test.ts
bun test test/runtime-incident.test.ts test/incident-observability.test.ts packages/box-runtime/test/run-observation.test.ts packages/box-runtime/test/turn-observation.test.ts
bun run typecheck
```

每个E01–08至少一个正常、一个缺字段、一个冲突/丢证据反例；实际writer→journal→projector→reader→CLI证明，不只mock最终JSON。覆盖同名STEP跨epoch、辅助失败但回复已发、前序工具已执行后续失败、checkpoint未知、事后升级不改事故制品、schema升级字段不掉。

原生工具消费/checkpoint/App仅在确有实际证据时标observed；public owned-fixture证明合同，真实Host资格分别进入[LIVE-OBS-EVIDENCE](LIVE-integration-validation.md#live-obs-evidence)。

## Forbidden / Non-goals

不捕获原始正文/参数以换取“完整”，不推测父子关系，不重试任务，不改变源异常/返回值/Promise身份；不造第二Agent loop或执行账本。无原生回执时明确缺口，不允许用测试成功补生产字段。

## Exit evidence

输出逐requirement字段/来源/测试矩阵，source/packed范围、未接线项和原生资格缺口。OBS-01/02/03只消费本合同；新的required字段变化需重验其消费者。
