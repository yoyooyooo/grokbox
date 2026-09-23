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

## 固定候选离线结果

候选 `a19cdcd7dffa9f189ed3375dba717299fbd1a59f` 在声明Bun `1.3.14` 下执行原 `release-offline`：14个分片、693项通过，无失败/跳过，所有分片已结算。验证前后源码摘要均为 `e7303e410a3255746ae1d97ad05267e4d7e58a06394eae5fd876e5c4c653c147`。构建来源摘要 `0b4ff4e913726abad980f5bfba8662f1c12e9133eeaf03738253767b09f22628`。这些数字与core/integration存在重叠，不累加为独立总数。

首轮限定独立审查超时124，无最终报告；后续限定复核调用被工具安全检查拦截，未执行。故本测试迁移保持In Review，未合入V2；离线结果不能代签缺失的独立复查、真实原生资格或平台服务。源V2 `078389fc` 的core/integration已另行通过，但其release入口仍含旧测试；不得把本未合入分支的693通过写成V2已通过。


## 修后独立复核与交付范围（2026-09-23）

固定测试候选 `825b5b2e287bdd557ef63930373dbe7c71408079` 获独立源码 Accepted。补齐实际 comparator、native snapshot/readBack 与 enrichment 后，先前将产品意图读回等同于执行归属的意见被明确否定。模型/执行授权仍是独立观察；本次不改变任何生产 writer。

本轮声明 Bun 1.3.14：原 availability 组 128 pass、0 fail/skip，前后源码摘要一致；当前创建六场景与共享产品53项重跑通过。根/Web类型、文档、包边界与发布扫描通过。六份受审代码/测试文件摘要复核一致。限定复核不代签全系统。

完整 release-offline 本轮重跑失败：前四分片通过，endurance 的 execution-lifetime 分片超时（ETIMEDOUT，SIGTERM，settled=true），整组退出1。SSH同期断连不能证明根因。旧a19cdcd7上的14分片693pass仍仅属于其原来源；没有声明新候选全release通过。该整体资格回到AH-122，不能把本票测试迁移的限定交付扩大成J2/LIVE许可。

原审查、当前组回执、失败记录与SHA清单在本工作树 `.scratch/ah171/closeout/`。本票按直接影响范围和独立复核完成单笔回流；没有部署、真实Bot/模型/桌面操作或旧入口恢复。
