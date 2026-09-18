# CONT-06 — 官方式 duplicate CLI

**状态：planned；原生duplicate边界已有CONT-00探针，CLI尚未实现。**

合同：[S13公共能力](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-00当前版本资格和CONT-11最小操作合同；可与保护/快照并行，不阻塞CONT-03的独立clone路线。

## 目标与模块

在既有agents命令、registry、Gateway/daemon有限写接口中暴露官方duplicate。CLI业务仍在`commands/continuity.ts`共用管理收据，不使用通用RPC转发。官方复制人设/设置但清会话的语义保留；原Routine定义是否启用、可见性及活动聊天副作用在预检披露。

创建回读actual ownership，不保证新对象是Box，不自动复制自定义模型分配，不迁移关系或删除源。duplicate与clone是两个明确功能，不能把内部history flag改true后冒充clone。Box/Temporal源是否被当前原生路径支持，逐条资格化，未知拒绝而非改源状态。

当前原生duplicate没有公开的创建nonce支持。管理操作ID只负责本地记录，不据此宣称远端幂等；响应丢失保留候选身份/unknown并对账，不盲目再次创建。没有足够关联时停止自动重试，不按名字认定成功。

## 验收出口

实现时新增CLI/transport/operation测试：正确原生方法和有限DTO、原Routine风险披露、源不变、归属已确认/不匹配/未知、响应丢失、并发请求和设置后续失败；同operation重入不能再次发起未知创建。复用CONT-00的原生函数探针，但不能以它代替真实命令/身份读回。

实际原生新对象及App选择变化另在[现场唯一索引](LIVE-integration-validation.md#live-continuity-primitives)登记，测试对象有限且可清理。

## 非目标

不提供会话复制、业务接替、状态注入或永久Box保证；不把隐藏对象当作未执行状态。官方语义无法安全预检时明确提示/拒绝，不静默换成另一种复制。
