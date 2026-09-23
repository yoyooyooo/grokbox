# D · 原生产品入口、消息/运行关联与旧转发退出

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-native-product`，从当前v2切出。优先交D1，不以完整命令目录阻塞核心验收。

## 目标与阅读入口

运行核心能用正式入口绑定真实Bot、发送一次输入、查询原请求及实际执行/交付，并在原版App核对；其后把剩余Bot/Group/模板等原生产品能力收进统一管理Server。先读[CLI-01](../../../tickets/CLI-01-discovery-and-targeting.md)、[CLI-02](../../../tickets/CLI-02-operation-contract.md)、[CLI-03](../../../tickets/CLI-03-observation-and-wait.md)、[CLI-04](../../../tickets/CLI-04-command-cutover.md)、[迁移映射](../migration-map.md)及[T39原版App旅程](../../../tickets/T39-native-model-roundtrip.md)。

## 掌管模块

原CLI的Gateway/roster、send/history/outcome、agents/groups/title/template/export及相应daemon转发；新的Server领域、共享客户端和本域CLI消费者。核心已有Bot查询、模型修改、Routine、Compact、handover不重建。原生产品事实仍归官方owner；管理操作安全记录归相应现行领域，不另建通用操作数据库。

A提供当前原生接口资格，R拥有TURN/STEP执行，E消费已核验的事件/关联，不让三条路线各建一份run/transcript事实。B拥有Memory/Project/fileRef来源，D的export/template复用合格材料接口；C消费关系/入站原语，不由D另实现handover。Bot删除后的seat cleanup与F协作迁入唯一原生生命周期，先保留原责任，不能在两个入口各调用一次。

## 出口

| 出口 | 依赖 | 必须交付 |
| --- | --- | --- |
| **D1 核心产品通路** | J0即可整理真实命令/输入/回执；实际原生接入消费A1 | 当前安装/账号/Bot身份、单次输入及原请求查询、nonce/submission/run/STEP/terminal/投递与原版App的准确关联。必要CLI/API统一到现行owner，缺关联明确，不把“最后一条回复”当run完成。给R/E/Q可执行验收入口；不等所有模板/群功能 |
| **D2 其余产品能力** | D1先回流；A/B提供相关原生能力 | Bot CRUD/ownership/原生duplicate/presentation/export、Group/membership、剩余message/run/模板操作，按真实能力逐项补齐；无精确run取消能力不虚构实现。同步已知调用方、脚本/Skill/测试并退出原daemon RPC/事件转发和旧writer；交F3/J5 |

D2按对象/关系、消息/历史、导出/模板几个完整工作包回流，不等整个路线结束。候选命令目录不是自动应实现所有名称；必需意图要有当前实际用例，已接受能力不足回来源票，不随意删除目标。

## D1 当前入口实现

共享 client 暴露单次 send、原请求、bounded transcript/thread/search 与 delivery get/wait；Server 复用原 continuity/native owner，无第二 daemon writer。完整当前合同以 [CLI-03 消息关联](../../../tickets/CLI-03-observation-and-wait.md#消息关联与对账2026-09-23) 为准：原请求保留 installation/principal/Bot、nonce、Gateway generation、账号 scope/Server id/harness，换源或不确定不补投。当前文本交付是原生持久 send-message/type=text，保留缺失的 isStreaming；`persisted-text` 与 acceptance/queued/TURN/run/STEP/terminal 分层，绝不以普通 assistant 或位置猜测。

原生 source-qualified 测试与自有 Node/SQLite 可以交付接口资格，原版 App 的取证入口、未观察字段与后续窗口见 [T39 D1 交接](../../../tickets/T39-native-model-roundtrip.md#d1-当前标识与原版-app-取证交接)。本包不签真实 App 成功，也不把后续现场成功反向设为本包接口实现的开工前置。

## 验证

按修改运行现有`test/ownership.test.ts`、`test/outcome.test.ts`、`test/operator.test.ts`、`test/export.test.ts`、`test/daemon.test.ts`与本域新Server/client测试。用实际HTTP/Node/持久记录验证严格输入、目标隔离、旧nonce不重放、丢回复、换代/权限/错误和公共输出脱敏。源端缺方法不使用旧RPC mock维持假绿。

真实App至少一段输入由未修改客户端产生，其实际关联标识与Box/Server读回一致；不注入/重签App或清缓存制造通过，不用自有Web代签。实际测试对象创建/输入/清理仅在Q的授权窗口，旧报告/test0等名称不是许可。

## 交付限制

D1未完的真实关联/输入缺口阻核心相应旅程；D2的模板、完整群管理等不阻J4。每次回流同时给真实能力表、旧入口去向和相关LIVE映射；F删除最后daemon之前必须拿到D的全部剩余依赖处置，不先删必要原生适配。

## D2-A 当前管理入口

Bot/Group 单次原生写入、预览/原回执、权限和关系读面见 [原生产品管理指南](../../../maintainers/native-product-management.md)。对应 CLI 通用写命令与 daemon 产品 RPC 已迁移；标题同步、模板和导出不冒充已全部退出。
