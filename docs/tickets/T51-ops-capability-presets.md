# T51 — 默认提醒、存储预算与配置切换

## Status / Goal

**Planned；部分统一配置基础已由T57–T60实现，本轮仅Spec。** [Spec §6.2/§8](../roadmap/template-ops-automation-spec.md#configuration)。收口下一版ops/storage合同，不把现有config3旧support字段当新通知实现。

## Depends-on / Modules

依既有ConfigurationWrite/配置schema与OBS-00字段/OBS-04保留合同，纯schema可并行。kernel `internal/config/schema.ts`、revision、ConfigChange与ops policy；box-runtime原config migrate/store/application；CLI现有config registry。不新建ops-policy文件或第二writer。

## Work

目标为下一不兼容schema：新增顶级storage及受限类别policy；当前编号在实施时与最新v2统一分配，不与CONT/其他worktree抢号。严格版本拒绝，显式迁移保留client/daemon/desktop/runtime/models原有语义和字节保护；普通reader不容忍未知字段。

ops默认notify、diagnostics=on-request、maintenance=off；默认brief不询问Issue。旧ops.support意图在迁移预览中明确退役/停用，不转成自动诊断/新binding/grant。T52/T56延期，首发不新增发布凭据/认证字段。

storage预算全安装共用，diagnostics目标256MiB/max512MiB/reserve64MiB含在max内，detail7d/summary30d；类别按Spec单一policy。禁止普通config把execution safety变成任意TTL。service必要GC独立于ops/notifications关闭，用户模型任务不受关闭通知取消。

版本化preset→显式叶，保留旧off/成本/数据选择。requested/effective/valueSource/blockedReason与真实服务/绑定/权限分别输出。配对、grant、容量计量/GC游标/租约属于机器状态，不可移植config不携带真实身份/secret。

增加费用/供应商/数据范围/保留预算时显示预览；普通config不授予Host维护/公开权。无关领域revision不失效当前模型选择；通知target修改冻结旧attempt的对账，不重放。

## Executable acceptance

新增`packages/runtime-kernel/test/ops-notice-storage-config.test.ts`、`test/ops-storage-config-migration.test.ts`，回归`packages/runtime-kernel/test/unified-config.test.ts`、`test/config-cli.test.ts`、`test/config-packed.test.ts`。证明旧support退役、off保持、schema拒绝、迁移崩溃恢复、未知字段不丢、预算非法拒绝、ops off仍保留storage intent。

Fake consumer/临时真实文件验证config提交不安装服务、不唤醒Bot、不GC、不改模型、不生成grant；实际状态只有owner读回后才applied。与T54共享目标schema，不复制第二层配置。

## Forbidden / Exit evidence

不在本轮改生产配置，不将preset当权限角色，不用迁移升级现役服务。提交schema及迁移/consumer证据；现场切换依[LIVE-CONFIG-CUTOVER](LIVE-integration-validation.md#live-config-cutover)，存储实际生效归[LIVE-OBS-STORAGE](LIVE-integration-validation.md#live-obs-storage)，保持历史config2/3回执原范围。
