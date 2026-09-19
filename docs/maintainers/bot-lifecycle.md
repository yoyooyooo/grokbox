# Bot 生命周期、保护与交接

本页说明已注册的有限 clone/replace/spawn、lifecycle、protection 和 handover 操作。语义与剩余产品边界归 [连续性合同](../runtime/continuity.md)，当前状态的 capture/initialize/reset/recover 归 [当前状态指南](current-state-control.md)，官方式 duplicate 归 [复制指南](native-agent-duplicate.md)。这些不是同一条复制命令的别名。

命令源码：[registry](../../packages/cli/src/registry.ts)、[生命周期 CLI](../../packages/cli/src/commands/bot-lifecycle.ts)、[持久分阶段程序](../../packages/box-runtime/src/internal/roots/bot-lifecycle.runtime.ts)。固定实现证明见 [生命周期报告](../reports/2026-09-19-continuity-lifecycle-integration.md)；现场结果只在 [LIVE](../tickets/LIVE-integration-validation.md#live-ownership-continuity)。

## 前置条件与影响

只在目标 Box 本机使用，不能通过远端 Profile、SSH 或任意 RPC 绕过本地边界。需要匹配的已加载 Host 能力、安装 scope、原生 worker/profile 和配置；缺失时沿已有能力诊断处理，命令不自动升级 Host。模型必须来自已配置目录并满足原准入，源码已集成不证明当前安装可用。

先明确源对象、材料/Memory 的去向、模型费用、激活/启动及交接发言范围。预览可读取原生能力、源 profile、模型选择及显式指令文件，但不创建目标、初始化 CONT 库、调用模型或发交接消息。确认执行会分阶段持久写入；失败可已经创建目标，不能因为没有最终成功就删除重建。

| 入口 | 真实边界 |
| --- | --- |
| clone | 固定源与材料计划，创建真实新身份并初始化；默认到 ready，不激活、不启动。显式 --activate 释放准备，--start 还请求程序启动 |
| replace | 共用生命周期程序，默认激活并进入 active_with_handover；不等于关系全部迁完，更不等于源已删除。只有 --start 才额外请求程序启动 |
| spawn | 不需要源 ID；初始化受管指令/模型与材料后激活并请求一次程序启动。不是模拟一条用户任务消息，也不是有自动到期删除保证的临时沙箱 |
| lifecycle status / advance | 按原 operation/scope 读取或推进保存的计划；不把 unknown 创建当作可重试的新操作 |

普通创建的 description/--instructions、介绍/kickstart 与 `--system-prompt-file` 的受管初始指令不是同一能力。指令文件要求明确 UTF-8 regular file，最多64KiB；内容不进入普通结果，也不扩大工具/数据/维护权限。maxRunMs 是受限启动预算，不能推导任务已完成、结果已交付或对象会自动清理。

## 预览、执行与原操作续接

先检查安装版本 help。以下是人工选择对象与范围后的步骤，不是一键批量创建脚本：

```bash
grokbox agents clone <source-id> --operation-id <uuid> --name <name>
grokbox agents clone <source-id> --operation-id <uuid> --name <name> --scope-id <scope-from-preview> --expect-plan <plan-from-preview> --confirm
```

两次使用同一 operation ID 和相同参数。预览返回 scopeId、planRevision、将使用的模型、指令摘要及 activate/start；源 profile、模型或指令改变则重新审阅计划，不沿用失效 digest。请求开始持久执行后，原操作不允许改成另一种任务。

replace 的默认激活与关系交接会扩大影响；`--allow-handover-messages` 另外允许明确以用户身份发送群/DM交接说明，不伪造旧 Bot 作者。没有发言许可时对应关系步骤可以 blocked，不暗中换成用户或 Bot 发送。

```bash
grokbox agents spawn --operation-id <uuid> --name <name> --system-prompt-file <file>
grokbox agents lifecycle status --operation-id <uuid> --scope-id <scope-from-preview>
grokbox agents lifecycle advance --operation-id <uuid> --scope-id <scope-from-preview> --expect-plan <plan-from-preview> --confirm
```

spawn 首条仍只是预览；实际执行需与 clone 相同的 scope/plan/confirm，保留原指令和选模参数。status 是本域离线读取，不加载 Bot、不创建库；advance 只消费保存的固定计划。先读每阶段回执、knownTargetId、blocked/reason 和材料缺口。顶层命令返回 JSON 或 ok 不代表 workflow 全部成功。

步骤的 claim、原生效果、结果写回与阶段推进分别记录。创建结果未知时不换 operation ID 再 create，也不根据相同名称猜目标；缺少可证明的原生对账则保持阻断。已经到 ready/active 的原操作重入不能用旧初始材料覆盖目标后续 B1/B2。

## 保护与关系交接

保护意图在 `runtime.continuity`，精确字段用 schema 查询；不另建手写状态文件。默认关闭的功能不能由文档、已有快照或 ops 通知开启来隐式启用。各 Bot 的材料档位、alert/prepare/auto-replace、暂停 Routine、关系权限与费用约束独立。

```bash
grokbox config schema runtime.continuity
grokbox agents protection status --scope-id <scope-id>
grokbox agents protection observe --scope-id <scope-id> --confirm
grokbox agents protection advance --scope-id <scope-id> --confirm
grokbox agents handover status --operation-id <replacement-id> --scope-id <scope-id>
grokbox agents handover advance --operation-id <replacement-id> --scope-id <scope-id> --confirm
grokbox agents handover observe --operation-id <replacement-id> --scope-id <scope-id> --confirm
```

status 只读。observe 虽主要观察原生事实，仍会写本地保护/关系水位，因而需要确认，不应归入纯 GET。advance 可能在已保存权限与配置内创建/推进替身或改变关系，不能把它当作一次健康探针。

当前后台保护随已启动的 daemon 组合，运行时 Scope 管理取消和回调结算；它不证明 Box 自启。当前保护观察/推进和交接循环仍使用固定节奏，`runtime.continuity.intervalMs` 尚未被该 worker 消费；保存它不证明调度已经采用，后续差额归 [CONT-01](../tickets/CONT-01-ownership-loss-notification.md)。通知也仍须通过独立配对、授权、预算和原生投递门。

每个关系保存真实进度：群成员、DM说明、Routine停旧启新、外部依赖、旧入站覆盖不是一个成功布尔值。新 Bot 可用可以与部分关系 blocked 同时成立；活动、失败、unknown 和缺少权限必须保留。监控失败/长断档不计 quiet，近期转录没有附件也不证明目标不依赖源资源。

`handover attest` 需要确切外部依赖 item 与人工已核验 evidence hash；这是有影响的声明，不是程序自行证实。`handover retire` 即使带确认与证据，也必须经过源资源独立性和删除前屏障。当前原生 adapter 没有可靠的条件删除/入站排空能力，因此自动源删除保持阻断；不得伪造 evidence、清空关系账本或绕回普通 delete 把 blocked 改成成功。

## 验收与停止边界

先验证创建/初始化/激活/启动各自对应的 native 回执，再验证实际请求、原生 checkpoint、后续输入、用户交付与清理；程序 startup 的返回不替代完整官方 loop/Provider/App 证明。固定离线样例与原生选定代码资格只证明其命名范围。

全附件/引用资源迁移及源独立性、self-reset安全排队、完整外部任务与逐职责效果约束、多代关系、临时 Bot 结果交付/清理、安全墓碑退役仍需来源票实现或资格；不能统称只差现场测试。不要扩大到未授权业务 Bot，也不为验证本指南触发现役模型、创建对象或删除源。出错先保留原 ID、阶段和未知结果，继续授权内只读检查与精确对账。
