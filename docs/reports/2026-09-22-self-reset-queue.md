# AH-133 self-reset 队列与消费程序验证

- 窗口：2026-09-22，分支 feat/box-runtime-v2
- 目的：为 C1 提供可持久化、可重试、可审计的 self-reset 登记与职责消费边界；不把本地消费器当作原生 Bot self-reset 已接通。

实现固定在 CONT 共享数据库：

- SelfResetRequest 对 operation、agent、scope、source revision/generation、policy revision、材料引用、workflow 引用与有限职责列表做严格结构校验，并以 canonical JSON 计算 request digest。
- enqueueSelfReset 在同一事务验证材料必须是 published 且 revision 精确匹配、workflow digest 精确匹配，再写入 continuity_queued_controls 的 self-reset/queued 行；重复 operation 只接受相同请求并立即返回已有回执。
- claimSelfReset 是唯一消费边界：turn 未结算或 source revision/generation 不匹配时写入 blocked；匹配时先写入 effect_unknown，随后才允许 owner 消费。
- settleSelfReset 要求每个声明职责都有结果；只有全部职责 complete 才能进入 complete，owner 异常落为 unknown 并保留未决材料。
- GC 在 queued、effect_unknown、blocked、unknown 阶段保护 self-reset 顶层和职责内的材料引用；complete 回执可随正常保留策略释放。

验证：

- bun test packages/box-runtime/test/self-reset.test.ts：3 项通过，覆盖登记先返回、重复消费不重放、revision 迟到阻断、owner effect unknown、GC 同事务保护。
- bun run typecheck：通过。
- 现有 workflow/subject retention 回归随后执行；源码未安装或调用官方 Host/native self-reset 接口。

交接边界：

- A3-C 消费 openSelfResetQueue(...).consume(operationId, owner) 所需的 current 与 consume owner 接口；current 必须返回已结算的 source revision/generation。
- B1 继续负责材料 publication/revision；C1 只验证并引用，不复制材料内容。
- A3-C2 仍需把 native safe-point/current-state 接到 owner，并提供现场来源证明；本报告不宣称该原生接通已完成。
