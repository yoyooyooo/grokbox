# T53 — 通用 Agent/Routine CLI 与原生事件唤醒

## Status / Goal

**Partial implementation：list/show/enable/disable/delete已接通共享程序及CLI/daemon；apply/provision/invoke/outcome仍待实现。** [Spec §10.1–10.2](../roadmap/template-ops-automation-spec.md#agent-routines)。统一Routine CRUD/apply/provision，让独立CLI、agents create/update与模板配对复用。Webhook是事件入口，不是周期性LLM轮询。

## Depends-on / Modules

只依T43原生能力合同，不依赖ops开启、监控SQLite、诊断、Issue或Host维护。kernel `routines.ts`、`internal/commands/agent-routines.ts`和ports；CLI `gateway-automation.ts`、`agent-routines.node.ts`、`commands/routines.ts`、agents/management/registry。

## Work

实现`agents routines list/show/apply/enable/disable/delete/invoke/outcome`与`agents create/update --routines-from`。原生调度是权威，本地只保存scoped provision回执；不编辑原生automation文件/数据库。正文读取单独有界，普通状态不含secret/endpoint。

默认disabled，Webhook不附cron/interval。apply只更新请求managed keys，省略不删除现存任务；删除指定exact ID确认。先验证全部Agent属性/routine文档/能力，创建成功而routine失败保留Agent ID、nonce、阶段partial/unknown，不删掉重建。重复nonce需内容digest一致，按已有回执续做/对账。

原生有CAS/幂等则使用；没有则说明外部并发不受本地锁保护，变化或身份未知停写。update只更请求字段，不改模型/harness/别的routine。endpoint/revision变更使旧binding失效，交配对owner处理。

invoke仅在显式目标/费用/请求预算授权下真实POST原生已核验endpoint；不能任意URL或sendPrompt代替。HTTP接受、run开始、报告、App呈现分开。超时先对账，禁用不等于在途任务已取消。清理只针对本次拥有且父/子任务结束的资源。

## 已实现切片

`kernel/routines.ts`提供有限定义投影和显式命令校验，`AgentRoutines` port与`internal/commands/agent-routines.ts`拥有前置检查、单次变更及读回；box-runtime只装配该程序，CLI/Gateway/daemon复用，不写原生数据库。现有五个命令要求精确Agent UUID，变更还需精确Routine ID、expected revision与确认。不能将本地revision称为原生CAS，也不声称取消在途运行。

新增`routines`按需Skill仅展示已实现命令，不注册未交付的创建或投递接口。其余本票范围仍按下文实施，不能以这份CLI切片关闭原生通知链。

## Executable acceptance

已实现`packages/runtime-kernel/test/agent-routines.test.ts`和`test/agent-routines-cli.test.ts`；实际打包Node子进程也在后者内验证，不新增空的packed测试文件。组合`bun scripts/verify-runtime-rebuild.mjs agent-routines`80 pass/0 fail；全仓2405 pass/19 skip/0 fail。证明exact ID、确认/revision、投影、local/daemon共享程序和unknown不重试。固定证据见[回执](../reports/2026-09-18-native-routine-management.md)。

仍待实现并补测partial create/update、持久provision nonce冲突、clone endpoint隔离、真实禁用后的后续fire和cleanup_required；当前测试不声称覆盖这些场景。

原生E2E单独授权一次性Bot：create disabled→读回→enable→POST→run/报告→update→新POST→disable→清理，两种组合/独立apply入口都测，模型与其他对象不变。source/fake不证明原生实际行为。

## Forbidden / Exit evidence

不建立第二scheduler、不复制活endpoint/secret、不自动启用测试Routine、不因Bot创建成功伪称整链成功。当前现场只归[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)。
