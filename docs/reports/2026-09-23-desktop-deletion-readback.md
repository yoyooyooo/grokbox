# 删除后桌面清理：停止读回与原座位保护

日期：2026-09-23。工作包：AH-164。固定起点 `ebf8c617769d3245a403da1be5de81f981b514da`。

本报告记录代码和隔离验证，不签实际用户桌面、服务安装或独立审查。原生产品删除回执仍由原产品运行时保存；桌面处理仍复用原 owner，没有新增 daemon、定时器或第二清理 writer。

## 已复现的缺口

直接调用生产 `reapDeletedAgentSeat`，在内存端口控制三个 await 边界：stop 返回时同号显示已重建；helper 返回但显示仍存活；日志清理时 Bot 已改坐另一显示。三种均继续清理、解绑并报告 stopped，原新座位被移除。初始三个保护测试全部失败；没有调用现役 helper、进程或桌面。

扩展至17项相同测试在未修改基线为2通过/15失败，其中包含新增接口要求，不将15条测试等同于15项独立生产缺陷。后续另加实际临时文件、真实 Unix socket 的正常停止和原 assignment writer 完整链路。

## 原 owner 内的修复

删除清理在停止后先核对显示已实际消失、原座位仍唯一属于原 Bot，才进入日志清理；日志清理后再次检查，随后携带 expectedDisplay 进入原解绑 writer。解绑后仍显式观察原显示，不把从 seating 表退出等同于显示停止。辅助程序返回成功不是停止证据。

原 assignment writer 校验精确 Bot/display、共享座位、有限文件与严格 JSON，发布前比较原字节，保留其他 assignment/token 与附加字段；写后若 seat/token 重现，则报告不确定，不像旧程序最多五次重删。故障测试使用自有文件，发布前/后变化由局部测试钩子控制。

原 idle-prune manager 也在停止后、日志清理前核验实际停止及原座位，清理后再次读回；已观察到的新资源不再被上一代请求继续处理。它不调用解绑。

真实 `readDesktopWorld` 将缺少转录视为资料不完整，这对普通状态/idle 判定仍正确；对已经确认删除的那个 Bot，其文件缺失是生命周期事实。现在仅该删除观察允许缺失，且不补造时间戳；其他 Bot、类型错误、读错误仍不完整。删除后的最终读回显式包含原 display，即使它已从 assignments 移除。

## 验证边界与首轮失败

新增 `test/desktop-deletion-race.test.ts`，覆盖换代、仍运行、日志期间重新分配/重建、缺证、启动中、最终解绑失效、不重删、真实源缺口及自有文件/socket 全链路。桌面两文件最终局部窗口46项通过。

第一轮桌面 Node 集成有4项失败：旧共享 fixture 删除 lit 标记后仍保留 socket identity，与真实源的 dark/no-identity 行为冲突。修正 fixture 后桌面23项、产品53项内部 Node 用例均通过；没有通过删除断言或放松停止条件消除失败。原错误日志保留在本工作树私有 scratch，不进入公共仓库。

## 未作的保证

前后观察和发布前字节比较不是跨官方 writer 的原子 CAS。官方操作若在最后观察之后变化，仍不能据此获得全局排他保证。本修复拒绝已观测的变化和缺证，不能代签完整原生资源租约。

原独立源码审查任务截止退出124，无最终报告；本修复的新独立静态审查调用未执行成功。没有 independent-review pass，不将实施会话自检换名。本票在独立复核与串行集成前保留 In Review，完整候选/J2不放行。

源码入口：[清理和解绑](../../packages/box-runtime/src/internal/io/desktop.node.ts)、[原生观察](../../packages/box-runtime/src/internal/io/desktop-source.node.ts)、[反例与真实文件/socket 测试](../../test/desktop-deletion-race.test.ts)。操作语义见[原生产品管理](../maintainers/native-product-management.md)。
