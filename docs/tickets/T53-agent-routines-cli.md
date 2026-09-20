# T53 — 原生 Routine 管理、持久回执与精确对账

## Status / Goal

**Partial：普通 Routine 的读取、disabled apply/update、enable/disable/delete、历史回执与精确 provision reconcile 已经迁入共享管理 Server、正式 CLI 和真实 Web。原生 LIVE、长期状态回执维护及 CONT 组合仍未收口。** 产品范围以 [Agent-first Spec](../roadmap/agent-first-cli/spec.md) 和 [命令目录](../roadmap/agent-first-cli/command-catalog.md) 为准，不把早期候选 invoke、批量组合或 `agents create/update --routines-from` 自动升级成首版已实现承诺。

原生调度与定义始终是事实来源。本地只拥有受管 key、操作记录及恢复关系；不编辑原生 automation 文件或建立第二 scheduler。通知配对、明确授权、独立可选测试和投递归 [T45](T45-template-webhook-delivery.md) / [T46](T46-template-ops-pairing.md)，通用 Routine 管理不以通知已启用为前置。

## 当前入口与责任

```text
grokbox routine list --bot <bot-ref>
grokbox routine get <routine-ref>
grokbox routine apply --input @file|-
grokbox routine enable <routine-ref> --request-id <uuid> --expect-revision <sha256> --confirm
grokbox routine disable <routine-ref> --request-id <uuid> --expect-revision <sha256> --confirm
grokbox routine delete <routine-ref> --request-id <uuid> --expect-revision <sha256> --confirm
grokbox operation get --domain routine --bot <original-bot-ref> --request-id <original-request-uuid>
grokbox operation reconcile --domain routine --request-id <original-provision-request-uuid> --routine-ref <exact-ref> --expect-revision <current-sha256> --confirm
```

输入和操作定位见 [Routine Skill](../../skills/grokbox/routines.md)。CLI 与 `/notification-setup` 通过共享客户端调用[管理用例](../../packages/server/src/notification-setup.ts)。`routines.read` 和 `routines.write` 独立授权；原生凭据领取由 `notifications.bind` 另管，页面不接受任意 RPC、URL 或凭据正文。

`routineRef` 绑定安装、原生 Bot UUID 和原生 Routine ID。列表只投影有限原生窗口，普通读取没有 prompt/key/endpoint，source failure 不伪装空列表。相同名称不授权修改；窗口中的缺失不证明账号全局删除。

[原生适配](../../packages/box-runtime/src/internal/io/routine-gateway.node.ts)每个用例拥有一个有界、固定代际的交互：先读当前定义，再允许明确方法的单次修改，独立读回。重新读取 discovery 后须仍为同一 generation，不能把已保留的操作发给替换后的 Gateway。沿用配对来源的原 generation 算法；不重定向、不重试、不通过旧 daemon fallback。

旧 `agents routines ...` 和 `ops targets ...` 普通命令已退出。daemon 的 `agentRoutines` / `routineProvision` RPC 和相关 capability 也已退出。尚未迁移的保护/交接程序仍借用其**本地**原生 primitive；不能因此宣称 CONT 已迁移，亦不暴露新的普通管理后门。

## 原数据库中的两类操作

`state/routine-provision/operations.sqlite` 保留原有 provision/binding/tombstone，并在 schema 3 增加有界 `state_operations`。新增 schema 只在明确写入时加表，GET 不升级或创建库；主文件空间约束继续使用原 owner。没有通用 operation 数据库或额外 scheduler。

**Disabled apply/update** 复用 `runRoutineProvision`、`RoutineProvisionLedger` 和 `NativeRoutineProvision`。新建明确 disabled；已有 managed key 只更新本安装保存的精确 ID，expected revision 同时匹配本地 binding 和当前原生定义。先提交 attempting 再发送一次原生请求，事务不跨网络；未知记录按 Bot/key 阻止换 request-id 绕过。普通输出不保存或回显 blueprint prompt。

**Enable/disable/delete** 复用原 `runAgentRoutineCommand` 的前置/读回规则，外层[持久状态操作](../../packages/box-runtime/src/internal/roots/routine-management.runtime.ts)先保留 Bot/原生 ID/action/revision/指纹和 owner。新增目标 guard 与 provision guard 协调；回执记录 observed 或 unknown，原请求重放先读历史，不再向原生发送。COMMIT 回调丢失也保留不确定性，不能因本地尚未标记 committed 而断言没有提交。

新公开操作键绑定安装、主体、领域、原 Bot 和 request UUID；不同主体不能用相同 UUID 读到对方的回执。原生状态变化后的旧成功回执仍是历史事实，不把它改写成当前状态。

## 恢复的证据边界

精确 reconcile 只适用于原 **provision** 操作：用户选择当前返回的 exact disabled definition，核对当前 revision，程序检查保留的定义摘要后更新原本地关联。它不重发 create、不领取 key，也不宣称本次查询证明了历史原生因果。仍活着或无法证明失效的原 attempting owner 不被夺权。

未知 enable/disable/delete 不能仅凭当前 enabled 值相同而判成历史成功，也不能换 ID 重发来补一个“成功”。这类原生对账和恢复能力仍有资格差额。revision preflight / readback **不是 native CAS**；外部并发 writer 不受本地锁约束。delete 只记录 `absent-in-returned-window`，禁用/删除不证明在途运行已取消，enable 允许原生计划未来运行但不主动 invoke。

现有 provision 有安全 tombstone 退役；新增状态回执暂按 256 条有限容量拒绝新动作，尚未声明长期无限使用或完整维护资格。未知 guard 不因 TTL 或诊断 GC 清除；相关容量和撤销需求必须由原 owner 后续收口，不能用丢失历史腾出重复执行机会。

## 已执行验证与剩余资格

[新的 Node 集成](../../test/notification-setup.test.ts)真实执行管理 HTTP、合成 Gateway HTTP、原 SQLite/私有文件和打包 CLI：首次 disabled 创建、managed-key update 保持原生 ID/无关定义、状态读回、丢回复守卫、精确 reconcile、主体隔离、换代前拒绝 dispatch，以及关闭时中止并结算凭据请求。真实浏览器覆盖整段 setup、草稿冲突、未知结果刷新和精确对账；固定源码与最终组合数统一归 [CLI-05](CLI-05-implementation-follow-through.md)。

[旧入口测试](../../test/agent-routines-cli.test.ts)现在验证退役命令/RPC 不调用原生，普通成功旅程已移到管理 Node / 浏览器，而不是恢复旧入口迁就测试。原 [kernel primitive](../../packages/runtime-kernel/test/agent-routines.test.ts)、[provision 崩溃/容量](../../packages/box-runtime/test/routine-provision.test.ts) 和实际 CONT handover 回归继续验证被复用的领域实现。

历史窗口只支持当时 CLI/daemon 实现：[原生管理](../reports/2026-09-18-native-routine-management.md)、[disabled provisioning](../reports/2026-09-18-disabled-routine-provisioning.md)。不得把历史计数或新合成来源通过改写为实际账号资格。实际原生定义/调度/启停、通知到达、外部并发、长期存储和目标宿主安装仍归 [LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines) 及来源票；测试不调用真实模型、采用 Host 或修改现役服务。
