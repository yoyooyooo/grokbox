# Host 更新事件与维护任务联合集成（2026-09-25）

## 结果与固定来源

AH-188 的来源分类/固定证据/原 OBS 事件，与 AH-143 的公共观察配置、有限拒绝重试、维护任务及回执，已在同一源码候选完成组合验证。不是两个分支各自通过后推算整链成功；新增测试实际从公开自有来源变化运行到原 producer、SQLite、自动 Webhook 投递及授权任务认领/结果。

功能验证来源为 `7b1094ba`；随后 `eb32b933` 只将负例 URL 改为保留测试域并移除旧公开报告的一项本机操作标识。最终对齐 v2 `b31e60fd` 后候选为 `566b1d07`；`git diff --exit-code eb32b933 HEAD -- packages apps scripts test package.json bun.lock` 确认生产、测试和工具链字节一致。新基线只追加原现场报告与 LIVE 记录，没有把原现场改写成此次通知验证。后续本报告/Current Home 提交只收口文档，实际线性合入提交以原 AH-188/AH-143 最终回执为准。

原 AH-188 三笔实现与 AH-143 五笔提交均保留行为并线性组合；两处重叠 fixture 同时保留直接测试端口隔离与 packed 子进程的自有公共配置。未部署、不切换现役 Host/modeld/全局入口，不修改真实 Bot/用户配置或重放原 unknown。

## 实际闭合的交叉问题

| 边界 | 发现与修正 | 当前验证 |
| --- | --- | --- |
| 公共观察开关 | Server 正式配置回调取代旧测试注入回调；领域 fixture 和独立 packed 子进程需要分别隔离 | 实际 config enable/disable/坏配置、在途读取取消、执行 disabled 仍观察；原 handover 全部断言/超时保留并通过 |
| 来源事件到维护投递 | 原健康事件的 `host_compatibility` 分类未列入通知合同，实际 ready work 在发送前失败 | 补有限分类与安全摘要；原 producer → OBS → 自动 HTTP → claim/result 实际通过 |
| HTTP 与任务回执 | 接收者可能先认领/报告，HTTP 后结算；不得覆盖先前任务事实 | 保留原解码记录只更新 transport；原两个顺序反例通过，HTTP unknown 与 receiver-credential 回执独立保留 |
| 旧拒绝快照恢复 | 后续尝试 unknown 后恢复旧 rejection，内存防重放虽生效，旧 work 却不断占用队首 | 保留原拒绝前缀，将匹配 work 隔离为 unknown；不伪造丢失 attempt，新工作继续，Client 不展示未知 work 可重试 |
| 附件暂时不可用 | 不变来源的空 evidenceRef 原先不再尝试保存 | 仅重取当前 AFTER，完整不可变窗口匹配后发布新观察；同 episode、旧缺失记录不修改，历史 BEFORE 不由另一份最新磁盘替代 |
| 清理与入库 | 清理错误发生在 journal 提交后、OBS intake 前，可能反复追加未入库记录 | 新写前重放原记录，先 intake 再有限清理；清理失败/不完整 pin 不阻止入库，原 source 不变也能重试清理 |
| 引用查询的长期上限 | 200 条已过期通知历史令 pin 查询永远不完整 | 在 SQL LIMIT 前按有效工作或当前证据租约筛选；有效引用不可读仍禁止删除，过期历史不永久占满保护窗口 |

分类仍只声明实际 recipe 窗口和直接 worker 的覆盖，不证明任意 JavaScript 语义等价或全部依赖。源码事实、运行代、用户影响、接收凭据回执和真实 Bot/App 观察分别表达。

## 最终可执行验证

工具链为声明的 Bun 1.3.14；Node、packed CLI/preload/Rust、临时 SQLite 与本地 HTTP 都实际执行。来源、账号和接收端为公开自有夹具，不是现役 Bot。

组合命令覆盖：

```sh
bun test test/host-source-change.test.ts test/host-source-evolution.test.ts \
  test/host-source-window.test.ts test/host-health-management.test.ts \
  test/host-compilation.test.ts test/host-witness.test.ts \
  test/observation-management.test.ts test/notification-management.test.ts \
  test/handover-management.test.ts test/monitor-service-packed.test.ts \
  packages/box-runtime/test/host-health-source.test.ts \
  packages/box-runtime/test/host-root-provenance.test.ts \
  packages/box-runtime/test/ops-notification-outbox.test.ts \
  packages/box-runtime/test/ops-automatic-notification.test.ts \
  packages/box-runtime/test/notification-restore-fence.test.ts \
  packages/runtime-kernel/test/notification-task.test.ts \
  packages/runtime-kernel/test/ops-observation-policy.test.ts \
  packages/client/test/host-health.test.ts \
  packages/client/test/receiver-contract.test.ts --timeout 220000
```

结果：19 文件、123 个 Bun 外层测试、0 失败、750 断言。内层真实 Node 套件分别为 health 19、compilation 11、witness 26、observation 15、notification 48、handover 20，全部零失败/零跳过；不将包装与内部数量重复相加。

根/Web 类型检查、完整 build、runtime boundaries 通过。负例 URL 修改后重跑 task 合同和原 host-health-shards 共 15 项通过；公开性工作树扫描 1742 blobs、0 findings。该扫描不代表重写/审计了全部 Git 历史。文档收口另经 check:docs 与公开性检查。

失败没有改算成功：保留先前 handover 19/20、公共开关接线错误、真实 producer 投递前失败、旧拒绝快照隔离失败、过期引用查询失败及修正 retry reason 后暴露的特定回执断言；修后沿原场景通过，没有删断言、放大原超时或改变 unknown 的定义。

## 独立复核

外部 Pi / sub2api-codex/gpt-6-astra 以只读、无工具、无私有来源输入分段复核。分类/任务/授权入口获 Accepted；outbox 恢复复核提出旧拒绝前缀队首问题，修后 Accepted；producer/provenance 复核提出附件重试、清理阻断和延期状态问题，修后 Accepted。结论仅覆盖所读关键边界，不代签全仓、外部委托实现或现场；reviewer 没有执行测试。

早期大范围审查超时没有报告，不计通过。后续使用可返回结论的分段复核，未因工具超时取消具体安全问题，也不为此次审查新增治理系统。

## 尚未兑现的产品义务

AH-188 的本阶段实现与组合检查可以按上述范围交付；真实官方更新、运行影响与长期窗口仍在原 LIVE 逐项验收。

AH-143 不能仅因源码合入而整票 Done：未配置维护 Bot 的普通用户默认通知出口，尚无已资格化的实际原生写入/展示链；原 worker 启动前的未发送 backlog/不明 reservation 自动冷启动接续仍未实现。当前保守防重放不能冒充完整待发恢复。已认领任务的原身份续报与未知 HTTP 不重复发送已有隔离证明，但不是前述缺口的替代。

真实 Grok Bot/Routine 的模型、费用、数据授权、回合行为与用户展示，及故障域外实际出口，继续由 AH-143 和既有 LIVE-OPS-RECEIVERS/OBSERVER-LIFETIME/NOTICE-REQUALIFICATION 收口。本次没有为证明这些范围而改动 AH-124 现场。后续 AH-189 可直接消费已集成的任务/证据合同，不能将通知接收等同于 Agent 修复与采用完成。
