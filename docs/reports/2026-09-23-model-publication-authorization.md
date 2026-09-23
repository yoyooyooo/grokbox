# 模型配置最终授权与事务收尾

工作包 AH-165。原失败反例为 `3338c78b`；首次实现保存在 `be025a82`，包含两条停服回归。当前修正保持原 writer 与原安全回执，不创建第二运行时或兼容入口。

## 最终发布边界

`runModelChange` 将 admission 返回的进程内检查传入原 ModelConfiguration。登记前先检查；原 RuntimeStore 在持有原模型写租约、完成临时文件暂存和目标检查后，将同一检查传入 `publishConfigFile`，在 canonical link/rename 前重新验证同主体、有效凭据及 models.write。回调不来自客户端 JSON，也不序列化到回执。

原生归属保留观察时间和单调时钟年龄；目录探测、授权和本地发布等待不能刷新五秒证据窗口。模型重置不需要原生归属，但仍需管理授权。CONT 原模型选择消费者传递同一最终检查，不新增 writer。

登记前取消可终止尚未开始的操作。登记后，prepared 记录、canonical 发布、读回和回执结算处于原 ModelConfiguration 的 uninterruptible 事务中；Server Scope 等待该事务，而不是关闭另一个子运行时。检查接收当前 Effect 事务的 signal：停服不自行撤销仍合法的提交，但当前权限撤销仍阻止发布。CLI 断开不变成重发许可。

最终检查拒绝不会替换 models.json，临时文件按原程序清理。prepared 已存在时保留 unknown；HTTP 返回拒绝或原操作的 409，重复请求只读原回执，不将同内容或未知结果变成再次写入许可。这里没有跨所有本地或官方 writer 的原子锁承诺。

## 已复现回归与修复

基线实际 Node HTTP/Effect/临时文件测试为1通过、2失败：等待中撤销 models.write 或改绑 principal 仍发布。最终授权校验使两例转绿。

首次实现新增 ownedModelChange 子运行时，导致原 Server 的 CLI 中断后立即重启、close 等待已登记事务两例从 succeeded 变成 unknown。现在移除这个包装，直接运行于原 Server-owned fiber；两条原断言未修改，Server 36项已全部恢复通过。

扩展测试最初使用未规范化模型定义和不合法别名，且等待未到达的测试边界导致超时；已用生产解析器规范化测试输入，并将等待与请求完成作竞争。记录的是夹具修正，没有放松生产检查或测试不变量。

## 最终工程证据

同一代码组合11文件：73个外层测试通过、0失败。内部Node分别为授权19、管理Server36、产品53、消息34，均0失败/跳过，内外不重复累计。根/Web类型、完整构建、runtime boundaries、docs16项、diff检查通过；8个本轮变更源码/测试文件在窗口前后摘要相同。删除旧包装并暂存其删除后，publication包含全部新文件1657 blobs、0 findings；先前扫描器因追踪列表仍含已删除文件而退出2，未将该次失败计为通过。

19项HTTP授权用例覆盖原生归属等待、writer入口、实际暂存文件、撤权/主体改绑/令牌移除、原unknown不重放、停服等待结算及停服中撤权、登记前取消、reset/default/model-put/patch/delete和目录探测等待。另有5项原程序测试覆盖最终拒绝、unknown保全、取消和真实五秒过期。仅自有临时文件、Unix/HTTP能力及合成ownership/catalog；没有现役配置、真实Bot/Provider业务、Host/modeld或桌面操作。

## 独立源码复核与范围

使用未参与实现的隔离Pi reviewer，对固定SHA-256源码包作只读复核。首轮因未见HTTP 409映射和实际事务/关闭证据，提出unknown、两次授权、证据年龄和取消疑问并给blocked。补充实际writer、HTTP授权/错误映射、未修改的关闭测试及扩展测试后，复核明确撤回这些阻塞意见，给出本变更限定范围accepted，未识别新的可执行阻塞缺陷。

该复核没有执行测试，也未审完整锁实现、所有Server关闭实现或全产品候选，不代签AH-162整候选独立审查、J2或LIVE。模型写租约与共享关闭行为的实际交叉回归由上述工程窗口证明。源码包摘要和原始两轮报告留在本工作树私有scratch，不发布账号材料。

入口：[模型命令](../../packages/runtime-kernel/src/internal/commands/model-management.ts)、[原模型存储](../../packages/box-runtime/src/internal/io/model-management.node.ts)、[最终发布测试](../../packages/box-runtime/test/model-publication-check.test.ts)、[HTTP授权边界](../../packages/server/test/model-publication-boundaries.node.ts)。
