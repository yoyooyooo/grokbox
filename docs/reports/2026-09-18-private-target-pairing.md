# 私有目标配对准备与撤销 · 2026-09-18

本片从 `f6d86a0` 延续通知主线，并在实施后 rebase 到 v2 `3b769fa`，保留新合入的HCR能力/恢复代码。实现提交为 `bdf6638`（后续文档和固定制品收口另见Git）。合同归[Spec §6.3](../roadmap/template-ops-automation-spec.md#bot-routing)，来源[T46](../tickets/T46-template-ops-pairing.md)/[T54](../tickets/T54-ops-targets-and-routing.md)，现场唯一归[LIVE-OPS-ROUTINES](../tickets/LIVE-integration-validation.md#live-ops-routines)。

## 实际交付

新增 `ops targets list/show/bind/disable/unbind` 和按需routines Skill说明。只有显式Box-local准备流程可以调用原生凭据接口：普通读取不建库、不读原生key、不启用Routine，不发送Webhook或模型请求。没有向daemon/remote暴露配对能力，也没有用通用URL参数建立接收者。

bind要求canonical目标偏好、本安装monitor数据库scope、T53管理的key/精确ID以及disabled Webhook定义。preview只读，confirmed bind先在本地持久占位，再至多一次领取原生凭据；请求后重核原生代际、定义、配置、scope及受管绑定。配置锁只保护本地占位/最终发布，网络不在锁内。不同operation不能绕过同槽未结enrollment，进程强杀或丢回执后保持unknown。

本片只到 **prepared**：credential已私有保存也始终返回 `deliveryAuthorized=false`、`qualification=not_verified`。仍缺实际接收者模型/行为/数据去向/成本资格、endpoint origin与HTTP合同、激活/driver和自动通知宿主。它不能被当作现役告警订阅成功，更不自动enable原生Routine。当前原生源码指纹已经不同于旧T43资格基线；本片的静态接口核对没有升级整个Host资格，也未运行真实HTTP配对。

## 私有状态与保留边界

机器凭据不进入config、模板、incident/outbox或普通日志。本片采用一个原子私有capsule：`state/ops-pairing/bindings.json`内部同时保存credential与对应元数据，以免多文件半发布造成旧key/新ID错配。公开runtime/CLI只提供白名单metadata投影，不导出secret读取方法。文件0600、owner目录0700、最多8槽；主文件和固定暂存各64KiB。超限拒绝，不删未知项腾空间。

不完整、损坏、丢失或符号链接指向的既有owner不自动初始化。存储status单独计量该秘密owner，不把其字节混入已宣称受控的诊断池；诊断GC没有删除权。首次目录初始化中断的自动恢复、完整目录/备份恢复fence和槽位安全退役仍未完成，不可清目录规避未知记录。

disable/unbind只修改本地slot，单调revision阻止晚到凭据复活。unbind清除当前capsule的本地credential引用；它不是原生key撤销、原生Routine删除、在途取消或介质安全擦除。重新准备同槽需显式使用当前unbound revision和新operation，不因旧记录年龄而开放重试。

## 测试与组合基线

使用固定Bun1.3.14、原依赖与Node基线。可重复组合：

```bash
bun scripts/verify-runtime-rebuild.mjs ops-pairing
```

最新v2组合实际 **106 pass / 0 fail**，7文件、934断言；类型、构建、导入边界与含未跟踪文件的隐私检查通过。运行前后源码摘要一致：`0aac0e02365b86dc890cb37c02b935a8335331d8e3e6b9adc05ef47e48f608fa`。实际preload为 `c890b3063aff8c28a7ba25ff3e86e87c9783b86120b4da60980b93ae1adf1a49`，重建后固定pin并验证，不沿用冲突前任何分支的制品摘要。

额外HCR组合 **52 pass / 0 fail**、293断言，覆盖能力、诊断、操作恢复/生命周期、profile升级与CLI。全仓不重叠目录：

| 命令 | 实际结果 |
|---|---|
| bun test ./test --reporter=dots | 729 pass / 0 fail；68文件、5919断言 |
| bun test ./packages --reporter=dots | 1839 pass / 19 skip / 0 fail；258文件、17694断言 |

合计 **2568 pass / 19 skip / 0 fail**。原生资格跳过不计通过。新11项owner测试覆盖真实配置/provision/SQLite/私有文件、查询零native请求、未知重入、并发预留、领取期间配置变化、解绑竞态、八槽限制、符号链接/缺失保护，以及真实子进程在reserve后SIGKILL。CLI真实HTTP fixture验证预览/领取/重复operation，打包Node验证状态与解绑；这些不是当前原生产品的HTTP资格。

首轮新测试有一项错误分类顺序不一致（busy与revision冲突）；调整为优先说明未结槽，保留阻止重复请求的断言。编译也捕获并修复route.target可空分支。rebase仅冲突于preload pin和diagnostics的两个说明段；保留HCR与通知说明后重建并完整复验。J1接口四个核心文件与rebase前相同，14项合同回归保持通过，没有实现替身/职责迁移或Bot删除。

## 发布与现场限制

独立Astra代码复核请求实际返回503，无审核结论。没有改现役config/Host/modeld/shim、领取真实Bot凭据、发送原生Webhook、创建Issue或发布模板。schema4保持成套迁移与原制品/配置退路要求；不能以prepared配对、静态API核对、合成HTTP或Git提交代替接收者资格和真实通知验收。

后续主线是接收者与当前原生HTTP资格、可信激活/credential driver、真实投递/报告/unknown对账和自动运行宿主。它们没有被本片的准备命令提前标Done。
