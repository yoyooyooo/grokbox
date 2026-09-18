# 共享存储意图、配置 schema4 与局部 owner 采用 · 2026-09-18

本报告保存 `09e6405` 之后 T51 切片的固定源码与离线证据。实施合同归 [Template Ops Spec §6.2](../roadmap/template-ops-automation-spec.md#configuration)、[T51](../tickets/T51-ops-capability-presets.md) 和 [OBS-04](../tickets/OBS-04-bounded-observation-storage.md)。当前现场状态只归 [LIVE-CONFIG-CUTOVER](../tickets/LIVE-integration-validation.md#live-config-cutover)、[CONSUMERS](../tickets/LIVE-integration-validation.md#live-config-consumers) 与 [STORAGE](../tickets/LIVE-integration-validation.md#live-obs-storage)。

## 实际交付

`config.json` 的源码候选版本为4。新增顶级 `storage`，复用既有 ConfigurationWrite、迁移、备份、别名、版本比较和 consumer 回执程序；不新增配置文件或执行账本。`models.json` 仍为独立version2，Host/modeld协议仍为wire8。

旧 `ops.support` 从正常schema、默认值、可写路径及domain revision中移除。显式2/3迁移才允许按原字段合同读取它，先验证再退役；未知字段或非secret-ref凭据使迁移拒绝，不静默丢弃。其他ops字段、off、目标、费用和数据范围原样保留，不借配置升级产生新的binding、grant或历史告警。迁移preview明确support已停用、无凭据/绑定创建、无模型调用及无GC。

`storage-policy.ts`统一默认目标256MiB、max512MiB、reserve64MiB、明细7日、摘要30日。当前注册monitor/journal/process三类：默认monitor128MiB、两个journal root各128MiB、process32MiB，共416MiB数据分配，另64MiB预留和32MiB未分配。字段只允许现有writer上限内的缩减，明细1–30日、摘要1–365日且明细不长于摘要；段数、段大小、类别和总分配一致校验。没有任意path、原生Memory、执行安全TTL、lease或权限字段。

**分配算术不等于全安装物理接纳预算。** SQLite辅助文件、备份、其他owner及跨进程并发预留尚未全部接齐，`installationBudgetEnforced=false`保持。不能把两个root预算解释成每Bot重新分配512MiB。

storage有独立依赖revision；调整storage不失效当前runtime/model选择或target，调整通知不改变storage。降低保留可能删除证据，提高上限可能占盘，因此set、unset、父替换均需确认。记录到config仍只代表committed，不能由CLI伪造全体owner的applied回执。

## 真正接回的 owner

| 入口 | 采用证据 | 限定范围 |
|---|---|---|
| monitor init / run | canonical配置读取、实际SQLite cap；collector固定启动时storage revision和期限，并在输出中标注monitor作用域 | 不热加载、不签其他owner |
| 显式capture / lease | 当前合法配置才准许新写，capture保存配置中的detail/summary期限 | 不授权读取原生正文、不改变历史revision |
| modeld过程日志 | 获得listener后才捕获process策略，实际writer按其段/总容量运行，ready单列storagePolicyRevision | borrower不获取writer；配置坏时日志降级，不把诊断故障变成服务启动失败 |
| storage status | 独立读monitor/process/journal与storageIntent，不因一源缺失隐藏其他事实 | 请求值、局部回执与实际全安装采用分开；没有全局storage consumer |

普通历史incident查询不依赖当前配置健康，既不重新capture也不续租。`runtime storage status`补齐`profile:false`，不再被旧配置的Profile解析拦住；旧或损坏配置可以继续取证，但新collector/capture不能偷偷按默认策略运行。关闭ops/notifications不移除storage意图或既有显式collector中的必要回收。

journal配置注入、全安装物理预留、持久服务安装、所有owner热加载与统一applied尚未实现。因此 `config set ... --wait-applied`在没有完整采用证据时正确返回pending，而不是启动一个假的consumer。原生Routine/Webhook和默认Bot提醒链并未因配置解析成功而上线。

## 可重复验证

固定Bun1.3.14、现有frozen lock及Node下限。新增组合：

```bash
bun scripts/verify-runtime-rebuild.mjs storage-config
```

完整组合实际运行结果为 **88 pass / 0 fail**：新3文件27项、既有9文件61项，共627断言。类型检查、构建、Host import边界、含未跟踪文件的发布隐私检查均通过。验证前后source摘要一致：`92880bc4b73318f771659814bbf40dbd3fc10a6629d2740df335bd7031cdeb61`（720个source/test/lock文件）。实际preload SHA-256为 `aeb94ed4013b4a36fd206aeffcd2f5981a7a6861f8822be0db52300ea0b4bb44`，拒旧制品pin由真实构建更新并已验证。

全仓按不重叠目录运行：

| 命令 | 实际结果 |
|---|---|
| bun test ./test --reporter=dots | 676 pass / 0 fail；66文件；5404断言 |
| bun test ./packages --reporter=dots | 1668 pass / 15 skip / 0 fail；242文件；16717断言 |

总计 **2344 pass / 15 skip / 0 fail**。跳过的原生资格不算通过。第一次packages全量有10项失败，定位到两个文件里的三处旧schema3正常配置夹具，导致预期执行路径被新版本门提前拒绝；只将这些配置夹具更新为4，不改model_step_terminal/ownership/monitor的独立schema。随后相关35项和全量均复验通过，没有放宽生产准入断言。

新测试的实际范围：

- `ops-notice-storage-config.test.ts`：严格字段/版本/类别与分配、旧support验证后退役、off保持、隔离revision、权限确认、可移植意图及getter不执行。
- `ops-storage-config-migration.test.ts`：真实临时文件与生产migrator，prepared/published中断恢复、模型字节和旧config备份完整、别名/原操作对账、计划冲突、CLI无隐式初始化/GC/授予，以及旧配置下的纯本地storage读取。
- `storage-configuration-owner.test.ts`：真实collector捕获1日明细/3日摘要；已禁通知下本地证据过期回收；当前config损坏后原revision仍可读而新capture拒绝；实际modeld连续12代遵守8KiB日志预算并核对storage revision。

这些均为owned临时文件、数据库、受控source RPC和Node进程，不消费真实业务模型、不更改原生Bot状态。独立review尚无有效回执，作者检查和绿色测试不能替代它。

## 集成与成套切换边界

现役只读取证窗口核对到旧schema3、wire8服务可达且采样当时activeSteps=0；它不是持续idle屏障、Host匹配证明或schema4采用。没有更新现役配置、全局shim、Host/profile/preload或modeld，也没有创建Bot/Routine、发Webhook、提Issue或市场发布。

schema4与运行中的schema3消费者不兼容。集成和采用必须预先固定旧可执行制品、配置/模型备份与精确迁移计划，协调旧writer退出和匹配新CLI/Host/modeld/daemon加载，保留pending/unknown及旧模型原字节。不能因测试通过就只快进一个可能被全局源码shim引用的v2路径，让日常CLI与现役配置先行失配。是否已经集成或采用以Git和唯一LIVE行的实际回执为准，不以本报告自动授予操作。

后续主线：journal策略采用、全安装物理预算和持久维护owner；原生通知资格/配对/投递与OBS-05安全退役按原票继续。storage配置切片不代表这些票已Done。
