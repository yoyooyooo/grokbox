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

显式 `harness=box` 走原生 Local-first：原 `createBackgroundAgent` 先物化普通本地 Bot，原 `ensureServerBacked` 按该准确身份登记；`register-existing-local` / `ensure-server-backed` 保留真实语义，Box 和启动抑制字段经过原客户端编码。管理 adapter 在派发前核对已加载的创建桥，缺失时不调用旧 remote-first。默认/Temporal 创建保持原路径，服务端返回 Temporal 不改标签、不回退模型。

该接缝属于现有 `native-creation` recipe 能力，沿 `runtime profile analyze` / `runtime profile write --capability native-creation`、原 reviewed profile 与采用机制交付。所需 review IDs 由实际同源分析给出，包含本地工厂接线、单次登记和只读回执入口，不复制临时目录或写现役 Host。历史 remote-first 字段切片仍是历史证据，不是当前可运行的 Box 创建实现。

`bot create --preview` 的 `creationSource` 返回实际已加载创建桥的 source/profile/candidate/preload/generation；缺能力时为 null，不推测健康。它参与预览 revision，提交前再次读取；来源变化使旧计划失效，不借旧成功回执授权新代。

新回执的 `result.creation` 分别保留原 operationId、本地 ID、首次 Server 身份响应投影、原登记者绑定、失败阶段及实际桥接的 source/profile/candidate/preload/generation。它不包含凭据或全部原始响应正文；不存在该字段的旧回执仍是缺少这项证据。`readBack` 继续表示本地产品资料匹配；独立 Server/local 归属须读 `bot ownership get`，并核对同一 Server ID。`complete` 只表示管理回执已保存，登记 unknown、mismatch 和未观察读回都不构成 Box 执行资格。

`deferStart=true` 仅用于 Box Bot 创建，表示请求抑制 introduction/kickstart，不是建立输入屏障。未抑制的创建与复制本地启用 Routine 都可能导致后续运行或费用，预览会披露；不能把创建成功推断为零费用或 managed model 已配置。

## 权限、原回执与失败

读取要求 products.read；写入另需 products.write。创建、删除、duplicate 分别要求 products.create/products.delete/products.duplicate；duplicate 还需 routines.write；未抑制的 Bot 创建还需 lifecycle.start。关系查询额外要求 messages.read/routines.read。原回执 GET 另需 operations.read。

同主体管理授权在最终原生传输开始前再次核验；授权等待时间同时计入原生身份材料的新鲜度，最后按墙钟和单调时钟复核，超过既有五秒窗口不派发。预览和原生读取后的失权不能沿旧授权继续写。前后身份采样和本地驱动锁不构成跨 App 原子锁，因此计划明确 atomicCompareAndSet=false，提交必须显式 acceptNonAtomic=true。

管理请求保存在原 CONT 安全库，绑定 installation/principal/scope/request。duplicate 委托原 CONT duplication owner。重复提交读取原回执，不自动重发；未知创建不通过同名、新增名单或更换 UUID 猜测关联。原生响应的目标 ID 在读回/清理之前持久化，源离线也不丢掉它。

Local-first 的当前调用绕过原 registrar 的通用重试包装，只调用一次原传输；既有对象和其他登记仍保持原策略。已物化后登记失败会返回准确本地 ID 和阶段，保留原生资料。丢失管理响应时，`product operation reconcile` 只按原 operationId 查询同一 Host 代的有界回执缓存，再写回原 CONT 行，不调用创建。Host 重启或缓存无记录时继续 unknown；缓存不是持久成功证明，也不是新 nonce 的许可。每代最多保留 64 次创建记录，容量满时拒绝新增，不淘汰未知记录。

未知创建按规范化后的原创建声明防重：忽略 requestId 后的相同声明仍被阻止，独立的不同创建声明不再被同类全局围栏连带阻止。已有对象的未知修改继续按精确 targetId 隔离。不同声明不代表可以把失败操作改名重试；原操作的结果与新对象的用途必须分别保留。

`product operation get` 的 diagnostic 提供失败阶段、原生方法、可用的 HTTP 状态以及私有详情是否已留存；没有记录时为 null。最多 8 KiB 的错误响应文本只存入权限受限的 CONT 安全库，普通管理响应不返回它，也不复制请求凭据或响应头。诊断附在原操作旁，原声明、unknown 状态和结果不被改写；HTTP 错误或无效响应均不自动代表未执行。诊断落盘无法确认时返回 operation_unknown，继续查询原请求，不能重新派发。

complete 表示这条回执已经结算，不表示所有产品效果匹配。分别检查 nativeReceipt、readBack 和 cleanup。not-dispatched 不能同时声明 matched、目标新身份或已清理；其他回执也验证 action/target/读回的一致性。delete 的原生回执、独立清理和原生读回分别记录，重复提交不再次清理。完整退役仍属于 CONT 条件删除合同，不能用普通 delete 代替其屏障。

Bot 删除后的桌面清理必须分别观察原显示停止、原座位未变、解绑完成；helper 退出成功不是停止证据。发现显示重建、座位重分配或读回缺证时保留不确定结果，不继续清理新资源。原 assignment writer 使用精确 expectedDisplay，发布后重现的 seat/token 不自动重删；已确认删除 Bot 的转录缺失只在本次删除观察中允许，不改变普通 idle/status 的保守判定。上述观察仍不是原生原子租约，详见[删除清理验证](../evidence/2026-09/2026-09-23-desktop-deletion-readback.md)。

用户 title 更新只替换用户段、保留现有元数据，不附带一次模型标签刷新。显式 title sync 的模型元数据语义保留在原标题入口；剩余 title/template/导出退出归后续产品收口，不复活旧通用产品写入口。

## 静默创建哨兵

现有验证入口支持 `node scripts/live-validation.mjs creation-canary --plan <private-plan.json> --out <private-directory> --cli <fixed-dist/index.js> --json`。缺少 `--confirm` 或计划中的 authorizationRef 时返回 not-run，不调用账号。明确获准的候选窗口才加 `--confirm`；先于 DM/compact/模型矩阵运行。该入口不安装、不采用、不重启 Host，不启用模型、群或 Routine，也不改变现有通知/定时平台。

计划为严格 JSON，字段来自当次正式创建预览和固定制品，不能抄历史 POC：

| 字段 | 来源 |
| --- | --- |
| version | `1` |
| requestId / cleanupRequestId | 预先持久保存的两个不同 UUID；原创建输入固定 harness=box、deferStart=true |
| installationId / scopeId | 正式预览的安装 envelope / 账号作用域 |
| expectedNativeGeneration / expectedSource | 预览的 sourceGeneration / creationSource，后者包含 source、candidate、profile、preload 摘要及加载 generationId；null 不能签健康 |
| artifactSha256 | `--cli` 指向的固定 CLI JS 制品 SHA-256；使用安装制品，不依赖兄弟 worktree |
| profile | 仅 name、description，静默专用普通 Bot 的声明 |
| authorizationRef | 当前窗口授权的 `private:...` 引用；没有授权时为 null |
| maxAgeMs | 声明的新鲜度上限，1 分钟至 24 小时 |

哨兵先核对安装、账号、原生代和已加载桥，再提交一次创建。准确返回的本地 ID、首次 Server ID、独立 `bot ownership get` 与 `bot profile get` 必须一致；清理仅消费同一原生 ID 与独立确认的自有 Server 身份。删除之后分别确认原删除回执、本地不存在、Server 未返回登记以及桌面清理结果。所有账号调用都走正式 CLI/shared API/管理 Server；没有按名字删除或模型启动步骤。

私有输出目录保留不可覆盖的原计划、发送尝试、原回执和独立读回。重跑同目录只按原 request 查 get/reconcile，不再提交创建或删除。创建结论与清理结论分列；首次创建成功时间不会被清理失败改写，过期或来源变化显示 stale。登记 unknown 保留本地身份与原请求；无法确认归属时不清理。公开测试只用隔离端口，不提供真实 Server、实际加载或 App/DM/compact 资格。

本入口是有界的一次哨兵。维护者授权的低频调度、HOST-01/OBS 事件入库和通知消费者仍需沿各自现有 owner 接通；没有自动创建新 Bot 的周期任务。真实候选尚未运行时，隔离结果不能作为当前账号健康。

## 下游消费与证据上限

C 消费 NativeProductAccess 的只读关系/独立读回，不另建 handover；Routine 定义继续复用原 Routine 程序。独立职责、完整入站与条件删除资格仍分别由 CONT/A3 完成。本包的隔离 Node HTTP、CONT SQLite、打包 CLI 和选定原生声明测试不代替真实账号/App/桌面验收。
