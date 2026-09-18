# 官方式 Bot duplicate

此入口提供原生复制，不是当前上下文恢复或完整clone。产品边界见[S13](../roadmap/box-runtime-impl-spec.md#continuity-primitives)，实现与资格见[CONT-06](../tickets/CONT-06-native-duplicate-cli.md)，真实账户/App验收只在[LIVE-NATIVE-DUPLICATE](../tickets/LIVE-integration-validation.md#live-native-duplicate)。

## 使用

在本盒匹配当前源码的CLI中，先做只读预检；目标必须为精确Bot UUID，不接受群或同名推测。

```bash
grokbox agents duplicate "$SOURCE_ID" --json
```

预检显示复制语义、当前源归属、返回的Routine窗口及启用数量、scope和plan revision，不建立CONT数据库。返回窗口不是全部本地/Temporal任务已穷尽的证明；读不到必要来源或所有权时拒绝预检，不猜零。

明确接受原生副作用后，使用预检中的revision和scope、固定的一次操作UUID：

```bash
grokbox agents duplicate "$SOURCE_ID" \
  --expect-plan "$PLAN_REVISION" --scope-id "$SCOPE_ID" \
  --operation-id "$OPERATION_ID" --confirm --json

grokbox agents operations show "$OPERATION_ID" --scope-id "$SCOPE_ID" --json
```

第二个命令纯本地读取，Host或源Bot不可用时仍可查看已保存记录；不会迁移数据库或重新发起复制。该operations入口也可显示既有当前状态初始化的安全记录，但不推断其现场状态。复制采用原生命名，改名使用独立的正常`agents update`，不在复制后暗中执行设置变更。

这些命令明确Box-local，不接受选定Profile、远程Gateway/daemon或SSH回退。现役CLI仍可能固定在旧配置兼容分支，代码合入不等于当前全局命令已采用；沿既有CONFIG-CUTOVER成套使用匹配的CLI与运行配置，不为此自动升级Host。

## 官方行为及边界

原生duplicate创建新ID、复制选定人设/设置/头像和本地Routine定义，清会话状态，不完整复制独立模型blob库或文件Memory。新对象通常取消隐藏并成为活动聊天，复制的Routine定义没有被本命令自动停用；因此它不是一个安静、prepared的替身。开启的Routine可能导致后续运行，confirm同时确认这一风险。

不会主动修改源归属、迁移关系、删除源或给新Bot配置grokbox模型。新ID由原生响应取得，不保证其所有权是Box；响应持久记录后再独立读取实际归属。目标尚未注册、查询失败或Gateway换代时，创建事实保留，当前ownership标不确定，不再创建一个试试。

预检revision绑定可观察profile/Routine和Gateway代际，但原生接口没有源状态CAS或快照冻结，不能承诺复制时所有字段与预检逐字相同。当前原生接缝只在明确版本下资格化；接口形状改变须重新核查，不能靠旧测试永久背书。

## 中断与恢复

复用CONT私有安全库。显式写入将旧v1/v2管理库迁移到v3，保留原始操作、加入有界native identity receipt；这不是canonical config版本迁移。GET不迁移。源Bot若已有prepared/effect_unknown的duplicate，另起operation ID也不能绕过该保护。

先原子保存意图，再领取唯一派发标志；实际POST前复核原始证据年龄和Gateway代际。原生API只收源ID、没有nonce，故此命令不做自动HTTP/auth重试。写入超时、HTTP失败或不合法响应均不能视为未执行。只有本地确认尚未发送的拒绝可以结算not_executed。

原生已返回的新ID先和成功记录一起落盘，再做可选ownership readback。本地保存失败时，错误尽量保留已知ID，但持久操作仍按unknown处理。相同操作重入先查原记录：已成功返回原ID，unknown不重新派发；源后来消失不使它重新创建。名称相似、前后列表新增项或短时没消息，都不是确定创建关联。

本地账本并不使上游API获得幂等性，也不能约束其他直接调用官方接口的客户端。若原生响应完全丢失且没有可靠关联，本版本保留unknown并要求处理，不提供猜测后解除保护的捷径。未领取的计划变化可明确结束为not_executed，再按新预检重新操作；未知安全记录不按普通日志TTL删除。容量不足拒绝新操作，不静默删旧记录。

## 证明范围

公开用例运行生产policy/Effect协调器/CONT SQLite/CLI及本地HTTP；独立Node进程验证创建后或结果提交后被杀、重开与并发唯一派发。另以固定原生源码的选定函数隔离验证实际复制语义，包含已存在current-state补丁清理源准备标记的行为；没有真实账户复制或模型消费。

稳定入口为`node scripts/verify-runtime-rebuild.mjs continuity-duplicate`；原生资格另需显式`GROKBOX_TEST_NATIVE_CONTINUITY=1`与`continuity-duplicate-qualified`。只有对应LIVE窗口能证明实际新对象、App选择和复制Routine的运行行为。完整状态clone、自动替身/交接仍按CONT主线实现，不能用duplicate成功代替。
