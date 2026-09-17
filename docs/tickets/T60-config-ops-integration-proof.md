# T60 — 配置重建与运维/模型命令的整体验收

## Status / Goal

**Planned · 2026-09-17 Spec-only。** AH-99/AH-100 和 T43–T56 共享一套配置底座与对外命令；没有第三 ops 配置、重复 writer 或 schema 漂移。唯一合同：[配置 Spec §8–9](../roadmap/configuration-rebuild-spec.md#modules)。

## Depends-on / Modules

依 T57/T58/T59，消费 T51/T54 等纯业务 schema；缺原生 Webhook/维护资格不阻塞配置底座验收。落点为 CLI registry/commands/skills、runtime configuration readers、ops binding/grant adapters、bootstrap 与现有 verify-runtime-rebuild 的新增 config-unification 组。

## Work

把运维偏好真正接到 config.ops 稀疏覆盖，不创建 ops-policy.json；targets/routing 的 desired 与机器 bindings/grants 分离。同 target 变更只使相关 binding 无效，不因 client.currentProfile/desktop 变动将全安装作废。T56 发布 grant 与 T49 维护授权仍走受信 owner。

公开主线 config / models / ops / profile / agents routines / host；顶级 models 补齐原 runtime models 能力，runtime ops 尚未发布的新入口不再实现。低级 Host profile 诊断路径保留，不为对称而无关改名。整份帮助、registry、模板按需 skills 和 package 内容一致；旧路径若用户使用，给明确改版指引，不运行第二业务实现。

从最新 v2 集成基线验证模型记录与当前 provider 功能（如 chatDialect）保持。Host 仍只读 models 的 bounded canonical snapshot，改配置文件范围不增加 Host 对 ops/SQLite/Effect 的依赖。current TURN pin 保持；新 config 的 runtime desired 读取与模型引用在 action 时交叉检查，不许修改普通设置触发隐式 Host restart。

配置文件、配置 scope、effective/blocked、committed/application、原生 Webhook ready/用户交付层级分别展现。迁移路径和接口状态写入同一维护说明；Docs 的未来目标不能进入已安装 skill 当作当前可用命令。

## Executable acceptance

实现后创建并执行：

```bash
bun test test/config-packed.test.ts test/config-domain-invalidation.test.ts test/skills.test.ts test/profile.test.ts test/operator.test.ts
bun scripts/verify-runtime-rebuild.mjs config-unification
node scripts/check-publication.mjs
```

新测试/verifier 当前不存在。实际 Node packaged CLI 验证 old-tree→preview→migrate→config set→领域命令→consumer apply→重启；不同 root/client/target 不误写。配置与 models 独立提交，privileged state 不可由 root config apply 写入；alias 冲突/新旧 writer/Secret sentinel/导出后再导入/目标重绑/两种 grant/修订失效范围全部覆盖。

模型侧验证当前已资格化 parser/selection/secret path，模型无变化时相关 digest 不变；desktop/currentProfile 改动不能取消已准入 TURN 或新增 provider 请求。Host preload 依赖 fence 与 packed tests 复用，不能因 CLI 统一引入 server SDK/Effect。

T50 后续继续验 native Webhook/报告/维护，不以 config-unification green 关闭所有运维票。完整两票验收结果注明 source/packed/native/Reset 不同范围及工具版本。

## Forbidden / Non-goals

不创建生产 Bot/Routine、不开自动 issue、无 live Host 重启或 Reset。不得把文档/包内别名变更当成业务实现完成；不同时修改并行 v2 工作区或覆写别人 provider 提交。

## Done evidence

提供可执行命令矩阵、所有旧 writer/偏好文件退役证明、文档/Skill/打包一致性与两票逐项验收。满足范围后才向维护者提交 AH-99/AH-100 关闭依据；本轮不自动修改 Linear。
