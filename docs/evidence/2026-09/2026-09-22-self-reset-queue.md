# AH-133 self-reset 队列与消费程序验证

窗口：2026-09-22。C1 基础实现已进入 v2；加固分支 `feat/ah-133-self-reset-hardening` 从 `05b73314` 开始，对齐 `14c59706` 后代码提交为 `6d3e8acd`（原 `e2a674a7`）。本报告记录本地持久队列与消费合同；原生接通属于 AH-139/AH-140。

## 原 owner 与公开边界

`runtime-kernel/continuity` 导出 version 1 的 SelfResetRequest、SelfResetExecution、SelfResetReceipt 及严格解析器。`box-runtime/runtime` 导出 `openSelfResetQueue` 和 SelfResetOwner。数据仍在 CONT schema 4 的 `continuity_queued_controls`，不创建第二个操作数据库。

- `admit(request)` 只登记并立即返回。operation/agent/scope、source revision/generation、policy revision、材料/workflow/职责和时间组成不可变原请求；同 operation 只接受相同 canonical JSON。
- 顶层和职责材料合计最多 64 个，workflow 最多 32 个，职责最多 64 个；重复职责、重复 workflow、冲突材料 revision 和控制字符被拒绝。材料必须是已发布的 recovery 引用，revision/digest 精确匹配；检查、容量计量和入队在同一事务。
- `consume(operationId, owner)` 调用 `owner.withSource(request, work)`。owner 必须把源观察和整个 awaited work 放在同一个原生屏障作用域中，绑定 agent/scope/policy，按 revision/generation 隔离迟到工具、checkpoint 和 Memory writer。当前回合未结算时立即返回 queued，不能等待发起该请求的回合。
- 源 revision/generation 已变化则持久 blocked，且不调用 owner.consume；源匹配时先持久 claim 为 effect_unknown，成功取得本地派发标志后才消费。并发、重开和丢失 claim 回执均不再次派发。
- 已声明职责必须各有一个结果；只有全部职责 complete 才能整体 complete。owner 抛错或非法结果保留 unknown。派发后的调用方取消不丢弃已完成结果；结算 COMMIT 不明向调用方报告，不覆盖已有成功。
- `request(operationId)` 恢复原请求。`reconcile(operationId, requestDigest, result)` 仅接收原请求的显式观察，不调用原生 owner；已完成职责不能被修改或抹去。effect_unknown/unknown 不能通过普通 consume 重放。
- 通用 queued-control reserve/transition 不能绕过 self-reset 校验。读取同时检查原请求与数据库中的 agent/scope/operation 归属。

GC 与原队列共用真实 SQLite 事务。queued、effect_unknown、blocked、unknown 保护原请求、职责和结果中的 recovery 材料，也保护被引用 workflow 的材料，即使该 workflow 已退役。complete 释放本操作的额外引用，正常保留策略继续生效；安全记录不按诊断 TTL 清除。

## 验证与边界

在独立 worktree 执行：

- self-reset 与既有 workflow retention：15 项通过、73 个断言。覆盖登记先返回、源 revision/generation 变化、未结算回合、作用域、并发/取消、重开、claim 回执丢失、显式对账、材料和 workflow GC。
- CONT store/current-state：45 项通过、211 个断言，包含真实事务保护、预算、旧材料保留、未知提交和 B2 不回退。
- `bun run typecheck`、`bun run build`、`bun run check:docs` 通过；文档 gate 为 16 项、1679 个断言。集成后结果另以 Linear 的固定 SHA 回执为准。

上述存储使用真实 CONT SQLite/文件；SelfResetOwner、原生源状态及材料载荷使用 owned fixture。没有安装原生安全点，没有启动真实 Bot/Provider，没有给 self-reset 添加已可用的 CLI 宣称；也未取得独立外部审查或现场全链证据。

## 给直接消费者的合同

AH-139/AH-140 需要提供 `withSource` 的真实原子作用域、非等待的 turnSettled 观察，以及按原请求消费、持久效果身份与逐职责读回。不能用两次 current 读取或 quiet 推断替代屏障。对账输入仍由原生读取方证明；本地 digest 绑定不证明外部结果真实。

B1/B3 继续拥有材料 publication、内容摘要、附件/fileRef 闭包和源依赖读回。C1 只消费精确引用，不复制另一份材料 writer。完整资源独立性、原生下一输入/重启、多代职责接手和退役分别留在原 C2/C3 与材料/原生票，不由本队列测试代签。
