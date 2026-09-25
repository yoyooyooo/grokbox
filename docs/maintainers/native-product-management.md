# 原生 Bot / Group 管理

正式管理入口复用原生 writer，CLI 与共享 client 使用同一 Server。当前命令由 [registry](../../packages/cli/src/management-registry.ts) 生成；合同见 [product contract](../../packages/client/src/product-contract.ts)。原生 duplicate 与完整 clone 不同，另见 [duplicate 指南](native-agent-duplicate.md)。

## 读取与一次写入

`bot profile get`、`bot ownership get`、`bot relations get`、`group list/get` 提供有界原生对象、实际归属、群成员与可见关系。读回的归属不是模型执行资格；关系中的原生 transcript/Routine 窗口也不是全部外部任务的穷尽清单。账号或原生代际在读取窗口中变化会拒绝混合结果。

`bot create/update/delete/duplicate`、`group create/update/delete`、`group members set` 和 Bot/Group 的 `hidden set`、`notify set` 每次仅执行一个原生产品调用。创建后的设置、改名与成员编辑是另一次明确计划，不在第一次创建后暗中补写。

CLI 使用严格 JSON 输入，命令负责 kind/action/targetId，文件中不要重复声明这些字段。每次意图先持久保留一个 requestId。示例 `create.json`：

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "profile": { "name": "Example Bot", "description": "Explicit instructions" },
  "harness": "box",
  "deferStart": true
}
```

实际操作需要使用该次独立生成的 UUID，不重复使用示例。先预览，再明确接受同一计划：

```bash
grokbox bot create --input @create.json --preview
grokbox bot create --input @create.json --scope-id "$SCOPE" --expect-revision "$REVISION" --accept-non-atomic --confirm
grokbox product operation get "$REQUEST_ID" --scope-id "$SCOPE"
```

profile 接受 name/description/title/avatarShape/avatarColor。Group 创建只接受 name/description 与 1–6 个不同的 Bot UUID；不接受嵌套群。成员更改使用完整 memberIds 集合，必须先读取并审阅，不能从旧集合盲覆盖新配置。现有对象 update 不接受 harness 迁移。

`deferStart=true` 仅用于 Box Bot 创建，表示请求抑制 introduction/kickstart，不是建立输入屏障。未抑制的创建与复制本地启用 Routine 都可能导致后续运行或费用，预览会披露；不能把创建成功推断为零费用或 managed model 已配置。

## 权限、原回执与失败

读取要求 products.read；写入另需 products.write。创建、删除、duplicate 分别要求 products.create/products.delete/products.duplicate；duplicate 还需 routines.write；未抑制的 Bot 创建还需 lifecycle.start。关系查询额外要求 messages.read/routines.read。原回执 GET 另需 operations.read。

同主体管理授权在最终原生传输开始前再次核验；授权等待时间同时计入原生身份材料的新鲜度，最后按墙钟和单调时钟复核，超过既有五秒窗口不派发。预览和原生读取后的失权不能沿旧授权继续写。前后身份采样和本地驱动锁不构成跨 App 原子锁，因此计划明确 atomicCompareAndSet=false，提交必须显式 acceptNonAtomic=true。

管理请求保存在原 CONT 安全库，绑定 installation/principal/scope/request。duplicate 委托原 CONT duplication owner。重复提交读取原回执，不自动重发；未知创建不通过同名、新增名单或更换 UUID 猜测关联。原生响应的目标 ID 在读回/清理之前持久化，源离线也不丢掉它。

未知创建按规范化后的原创建声明防重：忽略 requestId 后的相同声明仍被阻止，独立的不同创建声明不再被同类全局围栏连带阻止。已有对象的未知修改继续按精确 targetId 隔离。不同声明不代表可以把失败操作改名重试；原操作的结果与新对象的用途必须分别保留。

`product operation get` 的 diagnostic 提供失败阶段、原生方法、可用的 HTTP 状态以及私有详情是否已留存；没有记录时为 null。最多 8 KiB 的错误响应文本只存入权限受限的 CONT 安全库，普通管理响应不返回它，也不复制请求凭据或响应头。诊断附在原操作旁，原声明、unknown 状态和结果不被改写；HTTP 错误或无效响应均不自动代表未执行。诊断落盘无法确认时返回 operation_unknown，继续查询原请求，不能重新派发。

complete 表示这条回执已经结算，不表示所有产品效果匹配。分别检查 nativeReceipt、readBack 和 cleanup。not-dispatched 不能同时声明 matched、目标新身份或已清理；其他回执也验证 action/target/读回的一致性。delete 的原生回执、独立清理和原生读回分别记录，重复提交不再次清理。完整退役仍属于 CONT 条件删除合同，不能用普通 delete 代替其屏障。

Bot 删除后的桌面清理必须分别观察原显示停止、原座位未变、解绑完成；helper 退出成功不是停止证据。发现显示重建、座位重分配或读回缺证时保留不确定结果，不继续清理新资源。原 assignment writer 使用精确 expectedDisplay，发布后重现的 seat/token 不自动重删；已确认删除 Bot 的转录缺失只在本次删除观察中允许，不改变普通 idle/status 的保守判定。上述观察仍不是原生原子租约，详见[删除清理验证](../reports/2026-09-23-desktop-deletion-readback.md)。

用户 title 更新只替换用户段、保留现有元数据，不附带一次模型标签刷新。显式 title sync 的模型元数据语义保留在原标题入口；剩余 title/template/导出退出归后续产品收口，不复活旧通用产品写入口。

## 下游消费与证据上限

C 消费 NativeProductAccess 的只读关系/独立读回，不另建 handover；Routine 定义继续复用原 Routine 程序。独立职责、完整入站与条件删除资格仍分别由 CONT/A3 完成。本包的隔离 Node HTTP、CONT SQLite、打包 CLI 和选定原生声明测试不代替真实账号/App/桌面验收。
