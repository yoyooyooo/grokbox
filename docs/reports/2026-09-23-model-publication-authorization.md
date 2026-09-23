# 模型最终发布授权：已实现校验与待修停服回归

工作包 AH-165；起点为正式失败反例提交 `3338c78b2fa4eeee43a8b5031d3a8628c66e3f50`。本报告不是完整交付或合入许可。

## 已实现

原 `runModelChange` 将 admission 返回的进程内检查传入原 ModelConfiguration。原模型租约和 models.json 发布程序继续是唯一 writer。检查在登记前执行一次，并经 RuntimeStore 传到原 `publishConfigFile` 的暂存与目标检查之后、最终 link/rename 之前。该回调不来自客户端 JSON，也不序列化到回执。

管理 Server 重新读取当前授权并绑定原主体；原生归属材料保留其观察时间与单调时钟年龄，授权及本地发布等待不能刷新五秒有效窗口。CONT 原模型选择消费者也传递最终检查。模型重置不需要原生归属，但仍需要管理授权。

最终发布检查拒绝时，不替换 canonical models.json，临时文件由原发布程序清理。若原 prepared 回执已经存在，仍保留 unknown，原请求重入只读，不将同内容或失败结果变成再次写入许可。

## 证据

原三例实际 Node HTTP/Effect/临时模型文件测试，基线为一通过、两失败，修改后全部通过。另有五项原程序测试：最终 callback 拒绝保持字节、登记后失权保留原 unknown 且不重放、等待后取消、真实等待超过五秒不更新原生观察、重置的独立授权；全部通过。

根类型与正式构建通过。新工作树在构建前 Web 类型检查失败；正式构建后 Web 类型检查通过。文档检查十六项与 runtime boundaries、公开性检查通过。上述通过不替代以下已出现的行为回归。

## 尚未完成：两条 Server 中断回归

`packages/server/test/server.node.ts` 的两条原断言失败：CLI 中断后立即重启，以及 Server close 等待已登记事务。原合同要求被接受的事务结算并保留 succeeded；当前新 `ownedModelChange` 包装在停服时过早 abort 自己的子 runtime，实际留下 unknown。

不能通过将预期改为 unknown 消除该回归。必须恢复原 Effect 事务的所有权与收尾：登记前可中断；登记后的原本地事务由现有 owner 收束，同时继续执行最终当前授权与原生新鲜度检查。拟议收尾修改调用未执行成功，当前代码仍保留此缺陷。

本次完整 HTTP 发布边界扩展测试的写入调用亦未执行；本报告仅引用已实际落盘的三项 Node 与五项原程序测试，不声称已有那些额外用例。独立审查尚未取得有效结论。

## 保存与边界

本源码组合只能保存为 WIP；不得合入 V2 或标 Done。历史失败、安全测试和 unknown 语义都保留。未改变现役配置、Host/modeld、真实 Bot、Provider 或桌面。原生 ownership 是隔离 fixture；内置 stub 不产生模型费用。所有文件写入测试都使用自有临时目录。

入口：[模型命令](../../packages/runtime-kernel/src/internal/commands/model-management.ts)、[原模型存储](../../packages/box-runtime/src/internal/io/model-management.node.ts)、[最终发布测试](../../packages/box-runtime/test/model-publication-check.test.ts)、[Node 授权反例](../../packages/server/test/model-authorization.node.ts)。
