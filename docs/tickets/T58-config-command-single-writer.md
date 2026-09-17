# T58 — config 命令、唯一 writer、作用域与生效回执

## Status / Goal

**Planned · 2026-09-17 Spec-only。** AH-100 不再只包装 desktop JSON；实现统一路径化命令与全入口安全提交。唯一合同：[配置 Spec §5](../roadmap/configuration-rebuild-spec.md#cli)、[§6](../roadmap/configuration-rebuild-spec.md#writer)。

## Depends-on / Modules

依 T57 的 schema/layout/权限与 revision。kernel `internal/commands/config.ts` 和既有 ConfigurationWrite；box-runtime `config-store.node.ts` / `configuration-write.node.ts`；CLI `commands/config.ts` / `registry.ts`，profile/init、desktop、operator 同片收口旧 writer。T59 迁移程序调用本提交层，不再复制。

## Work

实现 get/set/unset/apply/validate/schema/path/export/preset：positional dotted 或 RFC6901，严格 JSON/显式 string/value-file，未知路径/类型/权限拒绝。数组 replace+确认+期望版本，无 append/索引写；父对象替换逐后代检查，不接受 floor/grant/模型字段。无 path get 脱敏，portable export 不含身份/secret/授权。

唯一 ConfigChange：锁内重读、expectedRevision、schema/引用/扩权检查、canonical 同目录 staging/fsync/rename/readback，明确 unknown commit 与 operationId。所有 profile/daemon keep/on-off/runtime desired/ops config 写者用此程序；不要在 daemon 旧内存副本上拼整树回写。不持锁等网络，不自动重试 stale 变更。

client.* 本机；远程 Profile 下 Box 意图不猜目标。local 写须 Box 资格，target 必须显式且有新版 config capability，无 capability 时拒绝、不写本机 home。models 仍 local-only，Generic config 不做 provider 设置后门。

回执分 committed/applied/pending/restart-required。RPC 是 invalidation hint，消费者重读 canonical；set 已保存而 reload 失败如实 pending。--wait-applied 超时保留已提交事实，不回滚或报「什么都没改」。hot reload 下个 tick 用相关 revision；不可热更不得悄悄重启。

## Executable acceptance

创建并执行：

```bash
bun test test/config-cli.test.ts packages/box-runtime/test/config-concurrent-writers.test.ts test/config-scope.test.ts test/config-application-receipt.test.ts
bun run typecheck
```

目标测试覆盖同时 config set、desktop keep、profile use、ops 改预算不丢键；数组替换与 add 可见 conflict；unknown path/类型/parent-object 夹带 floor 或 grant 后原文件字节不变；remote current profile 不写错机器；原生/remote permission 不够零写；GET 零初始化/网络副作用。

测试 rename 后读回失败/进程取消、通知丢失、daemon 未运行、旧内存 refresh、restart-required 和 --wait-applied；commit 已发生不能被变成无副作用失败。必须经真实 CLI 与 Fake capability/临时 FS 验证，不只单测 reducer。

## Forbidden / Non-goals

无通用文件编辑器、跨 models/config 原子事务、长期多 writer 兼容、config set 解锁维护权。不改变 AH-101 闲时下限，不在测试操作真实 daemon/Host，未批准不启动远端配置写入。

## Done evidence

提交同一程序的调用地图、旧 writer 删除/拒绝证明、CLI/并发/取消/生效回执测试。T59 再验真实迁移，T60 再验整个公开命令和下游整合；不把 AH-100 的原子写要求降低为最终 JSON 能 parse。
