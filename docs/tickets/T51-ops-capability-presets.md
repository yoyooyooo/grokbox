# T51 — 默认提醒、存储预算与配置切换

## Status / Goal

**Partial implementation；schema4、显式迁移与monitor/modeld日志策略采用已实现，整安装预留/统一applied及现场切换未完成。** [Spec §6.2/§8](../roadmap/template-ops-automation-spec.md#configuration)。复用T57–T60，不把配置成功当作原生通知已运行。

## Depends-on / Modules

依既有ConfigurationWrite/配置schema与OBS-00字段/OBS-04保留合同，纯schema可并行。kernel `internal/config/schema.ts`、revision、ConfigChange与ops policy；box-runtime原config migrate/store/application；CLI现有config registry。不新建ops-policy文件或第二writer。

## Work

本片基于v2的09e6405分配schema4：新增顶级storage及受限类别policy，未改models v2或wire v8。严格版本拒绝，显式迁移保留client/daemon/desktop/runtime/models原有语义和字节保护；普通reader不容忍未知字段。

ops默认notify、diagnostics=on-request、maintenance=off；默认brief不询问Issue。旧ops.support意图在迁移预览中明确退役/停用，不转成自动诊断/新binding/grant。T52/T56延期，首发不新增发布凭据/认证字段。

storage预算全安装共用，diagnostics目标256MiB/max512MiB/reserve64MiB含在max内，detail7d/summary30d；类别按Spec单一policy。禁止普通config把execution safety变成任意TTL。service必要GC独立于ops/notifications关闭，用户模型任务不受关闭通知取消。

版本化preset→显式叶，保留旧off/成本/数据选择。requested/effective/valueSource/blockedReason与真实服务/绑定/权限分别输出。配对、grant、容量计量/GC游标/租约属于机器状态，不可移植config不携带真实身份/secret。

增加费用/供应商/数据范围/保留预算时显示预览；普通config不授予Host维护/公开权。无关领域revision不失效当前模型选择；通知target修改冻结旧attempt的对账，不重放。

## 当前采用范围与边界

`storage-policy.ts`及严格schema校验总额、reserve、两类已知journal root和monitor/process分配，默认416MiB已分配、64MiB reserve在512MiB内；这不是实际全安装物理预留。各类别只允许在现有writer硬上限内缩小；没有任意路径、safety TTL、pins或授权字段。提高上限需后续owner实现/资格，不能用配置悄悄突破。

ConfigurationWrite对storage修改/unset/父替换统一确认，storage有独立revision；删除旧support revision。迁移2/3严格验证旧support后退役，保留off/目标/预算和模型原字节，preview不暴露凭据引用值，不创建grant/binding/worker，不进行GC。旧文件读取返回migration_required，不双读。

显式monitor init/run、capture/lease消费canonical存储策略，运行collector固定该revision与TTL；modeld获得listener后才捕获process策略并返回其revision，borrower不获取writer。关闭ops/notifications不改变已有本地维护政策。配置坏时只读incident/storage仍可用，写入/新collector拒绝；status提供独立storageIntent而不假称已采用。没有全局热加载、journal配置注入或统一storage consumer receipt，因此wait-applied仍pending。

## Executable acceptance

已新增`packages/runtime-kernel/test/ops-notice-storage-config.test.ts`、`test/ops-storage-config-migration.test.ts`、`packages/box-runtime/test/storage-configuration-owner.test.ts`，回归`packages/runtime-kernel/test/unified-config.test.ts`、`test/config-cli.test.ts`、`test/config-packed.test.ts`。证明旧support退役、off保持、schema拒绝、迁移崩溃恢复、未知字段不丢、预算非法拒绝、ops off仍保留storage intent。

临时真实文件/SQLite/Node服务验证config提交不安装服务、不唤醒Bot、不GC、不改模型、不生成grant；真实collector使用1日明细/3日摘要，modeld连续12代在8KiB测试预算内。实际状态只有全部相关owner读回后才applied。与T54共享目标schema，不复制第二层配置。可重复组合为`bun scripts/verify-runtime-rebuild.mjs storage-config`；固定结果见[本片回执](../reports/2026-09-18-storage-config-v4.md)。

## Forbidden / Exit evidence

不在本轮改生产配置，不将preset当权限角色，不用迁移升级现役服务。提交schema及迁移/consumer证据；现场切换依[LIVE-CONFIG-CUTOVER](LIVE-integration-validation.md#live-config-cutover)，存储实际生效归[LIVE-OBS-STORAGE](LIVE-integration-validation.md#live-obs-storage)，保持历史config2/3回执原范围。
