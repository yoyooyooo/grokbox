# T53 — Agent/Routine CLI 管理、组合创建更新与 Webhook E2E

## Status / Goal

**Planned · 2026-09-17 Spec-only。** 当前 CLI 尚无 Routine 写入能力。本票使创建/更新 Agent 可同时维护其 Routine，并可经真实 Webhook HTTP 请求验证原生运行；通用管理、模板配对和测试复用同一程序。Owning contract：[Spec §10.1](../roadmap/template-ops-automation-spec.md#agent-routines)、[§10.2](../roadmap/template-ops-automation-spec.md#routine-e2e)。

## Depends-on / Modules

仅依 T43 的原生 routine/automation/trigger/认证/修订能力合同，不依赖 ops 配对、T41 SQL 或自动维护 grant。现有 Agent create/update/nonce/ownership 的性质保持；不是重写全部 Agent 管理。

kernel `routines.ts`、`internal/commands/agent-routines.ts`、`ports.ts` 的 AgentRoutines；CLI `gateway-automation.ts`、`agent-routines.node.ts` 的 scoped provision 回执、`commands/routines.ts`、`commands/agents.ts`、`commands/management.ts`、`registry.ts`。原生调度状态是唯一事实，box-runtime/kernel 不 import CLI，fixture 不直接编辑生产 automation.json。

## Work

实现通用 `agents routines list/show/apply/enable/disable/delete/invoke/outcome`。Agent/Routine ID-first 精确解析，模糊名字冲突拒绝；apply 只创建/更新声明中的 managed keys，未列任务保留，删除独立确认。Webhook 与 cron/interval 类型不混淆，首期只写已资格化的 webhook trigger；默认 disabled，无 schedule。未知原生 trigger/schema 不强制转成可写 DTO。

`agents create --routines-from` 与 `agents update --routines-from --expect-routines-revision` 复用同一 apply 程序。增加 update 稳定 nonce；仅 Routine 文件也算有效 update。创建前校验整个输入和能力；Agent 已创建后 Routine 失败返回 exact ID、阶段、partial/unknown，不删 Agent、不重新创建。重入同 nonce/digest 只补未完成阶段，不同 digest conflict；不承诺原生多对象原子事务。

原生有 CAS/幂等则使用；没有时明示外部并发未保护，本地锁/前后读不能当跨 App writer 排他。作用域/当前修订/所有权未知拒绝自动写。更新启用中任务必须明确影响确认，核对禁用与未决运行；不自动打断用户任务。Routine 改动/重建导致 endpoint/identity 变化时通知 pairing owner 使旧 binding 失效，不静默沿用旧 URL。

`invoke` 从精确目标的原生只读事实解析固定 endpoint，读取有界合成 payload 文件并**发送真实 HTTP POST**；显式 --confirm 接受这次唤醒/费用。不能回退 sendPrompt、写队列或调用内部处理函数。普通 metadata 输出不带 secret URL/正文；credential 与终端输出隔离。requestId/probeId 贯穿 receipt/run/report，无原生关联时 not_proven，不凭时间邻近匹配。

原生 Agent/Routine 配置不复制到本地 scheduler；本地只留本次 operation、managed key/native ID 与 unknown 恢复所需回执。T46 模板配对用同一 apply/enable，T50 E2E 经实际 CLI 调用。

## 任意接收 Bot 与路由配对补充

[T54](T54-ops-targets-and-routing.md) 与模板配对消费本票唯一 native Routine 程序；本票不要求接收者来自 grokbox 模板/采用官方模型。通用 create/update 不隐式选模，custom Bot 由用户通过既有 models/原生 owner 单独配置，并按当前 Server 准入验证。

T55 的真实 E2E 增加至少两个不同模型目标及可选官方备用：各自 Routine read-back/启用、真实 POST、关联实际运行/捕获模型、更新后第二次 POST、禁用/cleanup。默认官方通用 lane 保持不变，custom lane 另有模型费用/权限资格；不能用 Bot 自报“我是模型 X”作证。绑定多个 alias 不复制同一任务或泄漏 endpoint secret。

仅路由 explain/test 不得调用本票 invoke；真实 probe 是独立显式动作。Routine endpoint/revision 变化必须使关联 target binding 失效并复核，不将旧 URL 继续留给投递器。

## Executable acceptance

创建并执行以下目标文件：

```bash
bun test test/agent-routines.test.ts test/agent-routines-composition.test.ts test/agent-routines-packed.test.ts test/management.test.ts test/template.test.ts
bun run typecheck
```

新文件当前不存在。测试 CRUD/ID ambiguity/未知 trigger/default disabled/无 cron/省略不删除、Routine-only update、同 nonce 重入/异稿冲突、Agent 已创建 Routine 部分失败、外部并发/readback mismatch、错 scope/endpoint rotation、HTTP 超限/重定向拒绝/ACK 丢失、secret sentinel、取消后的未决执行。create/update/apply 都检查真实 port 调用顺序，不分别实现三套测试专用程序。

packed Node + Fake native + 本地真实 HTTP 验证：创建测试 Bot→Routine apply/读回→enable→invoke POST→原生合成 run/probeId/report→更新同一 Routine→第二次 POST 证明新 revision→disable→拒绝新触发→清理本次资源。断言实际收到 HTTP payload，不能只断言内部 handler 返回成功。另测 create --routines-from 的组合路径。

native lane 在独立授权的一次性 Bot 上执行相同 CLI 链，保持官方模型、无 Host 维护、无真实 issue、有限 POST/花费。使用完整链路 correlation；只有 HTTP accepted 或 Bot 创建成功不足以关闭 native 资格。更新被观察到、禁用确实阻止新触发、旧 endpoint 状态均需实际证据。

teardown 只处理本次明确拥有的 Routine/Bot，先禁用并核对本次回合/子任务结束再删除。取消/硬崩/超时留下 scoped receipt 与 cleanup_required，可恢复清理；无全局 kill、无按名字批量删、无未知 outcome 时再创建。测试失败不能以删生产对象来收口。

## Forbidden / Non-goals

不直接写原生 SQLite/automation.json，不把离线 export 当 CRUD，不向 kernel 泄漏 upstream 私有 DTO，不把任意 URL 作为 invoke 参数，不自动启用维护/花费，不复制模板 publisher secret，不新增通用 scheduler 或任意 shell。

## Done evidence / Next

关闭需命令 registry/help/source/packed 测试和同一 apply 程序的证据；native 关联、并发保护能力和清理各自标支持范围。T46 消费该通用入口，T50 签署完整原生用户旅程；源码实现通过不代表生产 Webhook 已启用。
