# T53 — 通用 Agent/Routine CLI 与原生事件唤醒

## Status / Goal

**Partial implementation：现有管理命令与单份disabled apply、持久provision outcome、精确ID reconcile已接通CLI/daemon；批量组合、凭据配对及Webhook invoke/native outcome仍待实现。** [Spec §10.1–10.2](../roadmap/template-ops-automation-spec.md#agent-routines)。统一Routine CRUD/apply/provision，让独立CLI、agents create/update与模板配对复用。Webhook是事件入口，不是周期性LLM轮询。

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

## Disabled provisioning 增量（2026-09-18）

`agents routines apply <agent-id> --from <file> --operation-id <id> --confirm`接收一份严格schema1 blueprint（key/name/prompt/webhook trigger，isEnabled只能缺省或false）。原生请求显式disabled；不建周期、不领取凭据、不调用模型或Webhook。已有managed key只更新本安装保存的精确ID，要求expected revision同时匹配本地binding和当前原生定义；外部变化或对象缺失停止，不创建替代品。

`RoutineProvisionLedger`与`NativeRoutineProvision`两项能力经`runRoutineProvision`程序组合，box-runtime facade与本地/daemon同用。账本位于`state/routine-provision/operations.sqlite`，只复用原便携SQL driver，不依赖monitor初始化/TTL，也不保存prompt。先提交attempting记录再发一次网络请求，SQLite事务不跨网络；未知记录按agent/key挡住新的operation ID。重入相同ID检查fingerprint并返回原历史回执。

`agents routines outcome`只读本域历史；`reconcile --routine-id ... --confirm`只读取精确原生定义并写本地对账，不重发create。仍活着或无法证明失效的attempt owner不可被抢走；硬崩后经真实进程身份核验才能转unknown并对账。读回不是原生CAS、原生nonce或远端全部工作已终结的证明。

本域主文件2MiB、全安装256操作上限；达到上限只阻新provision，不删除未知记录、不影响普通推理。回执安全退役与第一次初始化中断恢复尚无资格；缺失/损坏/被清零的既有账本不重建。`runtime storage status`单列本域，诊断GC不得清理。J1公共接口及CONT本域职责未改变。

## Executable acceptance

已实现`packages/runtime-kernel/test/agent-routines.test.ts`和`test/agent-routines-cli.test.ts`；实际打包Node子进程也在后者内验证，不新增空的packed测试文件。组合`bun scripts/verify-runtime-rebuild.mjs agent-routines`80 pass/0 fail；全仓2405 pass/19 skip/0 fail。证明exact ID、确认/revision、投影、local/daemon共享程序和unknown不重试。固定证据见[回执](../reports/2026-09-18-native-routine-management.md)。

新增`packages/box-runtime/test/routine-provision.test.ts`及既有CLI文件中的local/daemon/packed Node完整旅程，覆盖持久nonce冲突、单次disabled create/update、未知对账、真实SIGKILL、并发、容量、损坏保护及诊断GC隔离。组合入口`bun scripts/verify-runtime-rebuild.mjs routine-provision`，固定结果见[本轮回执](../reports/2026-09-18-disabled-routine-provisioning.md)。

仍待实现multi-entry与agents create/update --routines-from组合的partial阶段、clone endpoint隔离、真实禁用后的后续fire和cleanup_required。`routines outcome`目前只指provision回执，不冒充native run/report结果。

原生E2E单独授权一次性Bot：create disabled→读回→enable→POST→run/报告→update→新POST→disable→清理，两种组合/独立apply入口都测，模型与其他对象不变。source/fake不证明原生实际行为。

## Forbidden / Exit evidence

不建立第二scheduler、不复制活endpoint/secret、不自动启用测试Routine、不因Bot创建成功伪称整链成功。当前现场只归[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)。
