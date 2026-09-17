# T57 — 统一配置 schema、物理根与领域边界

## Status / Goal

**Planned · 2026-09-17 Spec-only。** AH-99 的配置底座：两份日常文档，统一 client/daemon/desktop/runtime/ops 意图，models 独立且保留最新 v2 字段。唯一合同：[配置 Spec §3–4](../roadmap/configuration-rebuild-spec.md#layout)。本票不做生产迁移。

## Depends-on / Modules

先冻结最新 v2 集成基线，核对相对运维分支的模型字段（包含 chatDialect）；与 T51/T54 的纯策略合同协作，不等 Webhook/诊断上线。

kernel `config.ts`、`internal/config/schema.ts`、`path.ts`、`revision.ts`；box-runtime `internal/io/config-layout.node.ts`；现有 profile/daemon validators 提炼为同源片段，模型 parser 保持领域 owner。不得让 kernel import CLI。

## Work

定义 config v2 顶层与 camelCase 映射、嵌入 Profiles、desktop idleReclaim、runtime.desiredMode、无 overrides 包装的 ops；统一字段类型/默认来源/可写性/脱敏/是否需重启 metadata。全文件未知字段和重复 JSON key 拒绝；models 不经 config 路径读写，不改现有模型选择语义。

Box canonical 为 durableRoot/config.json + 原 models.json，home 受管别名；client-only 保持本地普通 config，不假设 workspace 或建立模型副本。锁定 installation role/root descriptor、绝对显式 override 校验、no-follow canonical 读条件，禁止向别名 rename 或从 Payload/cwd 推断根。

明确机器状态：installation/floor/pin/verifier、ops bindings、maintenance/issue grants；普通 config 仅有偏好/desired target。全文件 CAS revision 与 runtime/ops/target/model 的依赖摘要分开；配置无关变化不能全部失效。

## Executable acceptance

本票创建下列目标后执行（目前不存在）：

```bash
bun test packages/runtime-kernel/test/config-schema-v2.test.ts packages/runtime-kernel/test/config-path.test.ts packages/box-runtime/test/config-layout.test.ts
bun run typecheck
```

覆盖 v2 全形状、各旧字段显式映射、点号 map key/JSON Pointer、危险原型 key/重复 key、数组与对象规则、schema readOnly/secret metadata；Box/client/remote root 不能混同；别名缺失/被普通文件顶掉/指向异根拒绝；Host canonical models 的 no-follow 读路径不变。

模型 fixture 必须覆盖最新 v2 chatDialect、credential refs、externalCatalog、contextWindow/alias/assignment 的无损保存；parser 不认识字段不能直接抹掉。桌面和 client 改动保持模型 selectionRevision 与无关 target policy digest。

## Forbidden / Non-goals

不搬 host-bundles/secrets/CLI 安装树，不引入第三偏好文件，不写真实 home、不改 floor/minIdle 业务规则，不重构 provider 家族或默升 Effect/Bun。不用 schemaVersion 字段自称迁移已完成。

## Done evidence

提交 schema/字段与路径矩阵、纯/临时 FS 测试与最新基线说明；T58 消费同一 schema，T59 才执行迁移。AH-99 不能仅凭本票 Done 即关闭。
