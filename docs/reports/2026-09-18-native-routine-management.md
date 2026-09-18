# 原生 Routine 管理首个切片 · 2026-09-18

本片基于`fba6150`，推进T43/T53而非继续扩展存储底座。产品合同归[Template Ops §10.1](../roadmap/template-ops-automation-spec.md#agent-routines)，来源票为[T43](../tickets/T43-native-webhook-contract.md)/[T53](../tickets/T53-agent-routines-cli.md)。唯一现场状态仍归[LIVE-OPS-ROUTINES](../tickets/LIVE-integration-validation.md#live-ops-routines)，本报告只保存固定源码与离线证明。

## 已交付的实际入口

已注册`agents routines list/show/enable/disable/delete`及`grokbox skills get grokbox --topic routines`。使用精确Agent UUID与原生Routine ID；变更需`--expect-revision`和`--confirm`，可附`--operation-id`作关联，不把它当原生幂等键。没有新增创建、apply、凭据获取、invoke/outcome或自动通知入口。

kernel的纯`routines.ts`只承载输入/输出和投影；`AgentRoutines` port与既有commands承载一次前置读取、明确变更及结果核对。box-runtime facade装配执行，CLI本地Gateway与daemon复用同一程序；没有原生文件/数据库写入，没有另一个scheduler或Agent loop。新增kernel显式subpath与架构边界fixture同步，Host仍不导入Effect/CLI。

普通结果保留定义摘要、时间与revision，不输出prompt、原生路径、run正文或专用凭据字段。原生响应在JSON解码前限制512KiB；嵌套未知字段不会因经过daemon就绕过投影。相同定义的运行时间变化不制造配置revision冲突，实际定义/开关变化则会。未知trigger或非支持session绑定仅可读。

变更前确认精确revision，已经处于目标开关状态时不写。实际写入只有一次；丢回执、Gateway换代、后置读取失败或定义并发变化均为unknown，不重试。期望开关被读回只表示requested_state_observed，不是原生CAS或排他锁。删除仅报告absent_in_returned_window，不宣称全局删除事务或取消在途工作。

这五个原语可用于用户明确委托的Bot运维，也为CONT的Routine控制提供共用边界；收到普通告警本身不触发启停/删除。默认Bot仍只提醒并结束，自动Issue没有恢复。

## 可执行证明

固定Bun1.3.14、原frozen lock与Node基线；未新增依赖、未改变models或wire版本。

```bash
bun scripts/verify-runtime-rebuild.mjs agent-routines
```

最终完整组合：**80 pass / 0 fail**，6文件、657断言；类型、构建、运行时边界和隐私检查通过。验证前后source摘要相同：`e67f56f13f056437b60eeae526962dffe28f40e70de3d0da688b649dd2bc3f24`。真实preload SHA-256：`aaf3a4a109abb38ff69d296c54c2d4879855d15e171ec590e33a326792dd336e`；pin由实际构建更新并通过拒旧制品测试。

不重叠全仓目录实际结果：

| 范围 | 结果 |
|---|---|
| CLI/test | 686 pass / 0 fail，67文件，5539断言 |
| packages | 1719 pass / 19 skip / 0 fail，248文件，17024断言 |

合计**2405 pass / 19 skip / 0 fail**。19项是默认跳过的原生资格，不能计为通过。此次另以显式环境开关运行`native-routine-qualification.test.ts`，**4 pass / 0 fail / 29断言**：仅在既有固定源SHA上动态选取函数，与受控归一化/存储/网络边界组合，不启动完整Host、不读真实Bot内容、不把私有源码复制进仓库。函数隔离不是实际HTTP管理、Webhook认证或用户收到通知的证明。

核心14项测试验证定义/回执投影、准确身份、确认与revision前置、unsupported只读、一次变更、四类unknown与无重放。CLI9项使用合成HTTP边界和真实Unix daemon，另执行实际打包Node CLI完成查询/启用/读回，并验证超大及非UTF-8正文被限制、直调daemon不能绕过参数边界、全程没有额外创建/调用动作。Skill清单/链接/选择性加载与安装包白名单同步验证。

首次CLI全量失败是新Skill文件未写进发布白名单；只增加该已登记文件并重跑全量，不放宽任意打包内容。首次原生探针的数字常量提取器未接受科学计数形式，改用AST数字literal类型后4项全过，不更改上游解析逻辑。

## 未闭合与下一段

T43真实HTTP资格、T53有持久回执的disabled provisioning/apply、目标配对、invoke/outcome、T45可靠投递、Bot模型与实际提醒仍未完成。普通管理回执不能成为未来自动创建的幂等凭据。后续先补这些主链，不用更多无关离线磨光代替实际通知出口。

本轮指定Astra只读复核请求返回503，未取得独立审核结论。`docs/upstream-integration.md`的事实同步写入被工具拦截且未落盘，不换文件复制被拒的更新；该同步仍在T43标为待办。其余实现/测试范围和本报告不替代该Current Home。

没有操作真实Routine、创建Bot、领取或公开凭据、发Webhook/业务模型请求、更新市场模板或Issue。现役schema3与候选schema4仍需要固定旧制品/配置退路后协调采用；本轮不切换未合入的Host/modeld或全局shim。当前集成与现场状态仅按Git及LIVE索引更新。
