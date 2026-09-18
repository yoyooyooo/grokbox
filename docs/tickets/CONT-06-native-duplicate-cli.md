# CONT-06 — 官方式 duplicate CLI

**状态：Box-local手动入口及持久操作链已实现，真实账户/App效果待LIVE；不代表完整clone或自动替身。** 默认只读预检，明确计划/scope/操作ID后确认执行，原生无nonce不自动重试。

合同：[S13公共能力](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-00当前版本资格和CONT-11最小操作合同；可与保护/快照并行，不阻塞CONT-03的独立clone路线。

## 目标与模块

在既有agents命令、registry、Gateway/daemon有限写接口中暴露官方duplicate。CLI位于`commands/agent-duplicate.ts`，正式Gateway适配为`gateway-duplication.ts`，Effect用例为`roots/agent-duplicate.runtime.ts`；复用CONT管理库与安全claim，不使用通用RPC转发。官方复制人设/设置但清会话的语义保留；原Routine定义是否启用、可见性及活动聊天副作用在预检披露。

创建回读actual ownership，不保证新对象是Box，不自动复制自定义模型分配，不迁移关系或删除源。duplicate与clone是两个明确功能，不能把内部history flag改true后冒充clone。Box/Temporal源是否被当前原生路径支持，逐条资格化，未知拒绝而非改源状态。

当前原生duplicate没有公开的创建nonce支持。管理操作ID只负责本地记录，不据此宣称远端幂等；响应丢失保留候选身份/unknown并对账，不盲目再次创建。没有足够关联时停止自动重试，不按名字认定成功。

## 当前实现与验收出口

`agents duplicate`不带执行参数时只读预检；执行要求exact source UUID、plan revision、scope、stable operation UUID和confirm。人设/Routine变化、Gateway换代及原始证据过期拒绝派发。返回窗口不伪称完整盘点；confirm披露Routine保持原配置和活动聊天切换，不提供hidden/prepared或零后续消费保证。新对象使用原生命名，改名是独立update而非隐藏步骤。

CONT私有管理库显式升级到v3：意图与源保护原子登记，未知创建也阻止同源换operation ID重做；实际新ID与成功记录原子持久后再查ownership。读回失败保留创建事实，创建响应丢失保持unknown；GET不迁移。已有current-state CLI也收紧为真正local-only，不先解析Profile覆盖调用上下文。

公开验证入口`node scripts/verify-runtime-rebuild.mjs continuity-duplicate`覆盖生产策略/Effect/真实SQLite/CLI/本地HTTP、并发和独立Node强杀恢复；`GROKBOX_TEST_NATIVE_CONTINUITY=1 node scripts/verify-runtime-rebuild.mjs continuity-duplicate-qualified`执行当前固定原生复制函数及既有身份清理slice。测试依赖现实、计数与复审边界见[固定报告](../reports/2026-09-19-native-agent-duplicate.md)，操作方式唯一归[指南](../maintainers/native-agent-duplicate.md)。

实际原生新对象、Box/Temporal源与目标注册、App选择和复制Routine行为另在[LIVE-NATIVE-DUPLICATE](LIVE-integration-validation.md#live-native-duplicate)登记，测试对象有限且可清理。未取得的独立外部review仍是来源票缺口，不将它伪称现场验证。

## 非目标

不提供会话复制、业务接替、状态注入或永久Box保证；不把隐藏对象当作未执行状态。官方语义无法安全预检时明确提示/拒绝，不静默换成另一种复制。
