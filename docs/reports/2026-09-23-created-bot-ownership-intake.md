# 创建后归属验证迁移到正式管理入口

工作包 AH-171；起点 `078389fc7456131ec004021c9e28e421bc9d18d6`。原 release-offline 的 availability 分组在五项旧 `agents create --name` 测试失败；该通用 writer 已退出，不应恢复旧语法来保持测试绿色。

## 迁移而非删除语义

原 `test/ownership-model-selection.test.ts` 仍是正式验收入口，改为构建当前打包 CLI，并启动实际 Node HTTP、原管理 Server、原 CONT SQLite 回执与测试自有原生 HTTP fixture。只运行创建/归属这一个子范围，不导入全部产品验收。

box、server/local temporal冲突、旧响应、读失败、错误ID五种场景都保留，另加confirmed-temporal对照。先在正常scope下预览/创建，原生接口返回目标后才改变归属观察，确保真正验证创建后的边界，而不是在创建前拒绝请求。

每例检查原生create只有一次、clientNonce绑定原operationId、原生返回目标ID被保留、intro/kickstart抑制请求以及模型配置未变。独立归属查询区分confirmed_box/conflict/confirmed_temporal/unconfirmed或不可用，并始终不声明executionQualified。普通profile读回matched不能替代归属证据。

未知/不一致归属不会触发删除、迁移、提示发送、更新或再次创建。源离线、重复提交和Server重启后仍读取同一原回执；旧agents create继续拒绝。该测试不把deferStart当作原生输入屏障或零费用承诺。

## 依赖与边界

只新增测试 fixture 的可选归属响应变体，默认路径不变；没有生产源码或writer变更。旧Bun进程内模拟改为原仓库同类的有限Node/打包CLI测试进程，检查退出、无跳过、无超时和实际六个场景。实际原生Host、用户Bot、Provider与平台服务均未操作。

入口：[正式包装器](../../test/ownership-model-selection.test.ts)、[当前链路用例](../../packages/server/test/created-bot-ownership.node.ts)。完整release验收结果由Q按固定候选另行记录，不能仅凭这六项通过签发布。
