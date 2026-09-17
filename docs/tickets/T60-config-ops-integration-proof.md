# T60 — 统一配置集成验证与发布边界

## Status / Goal

**Configuration lane implemented and offline-verified; production cutover/review remain open。** T57–T59 的 schema、writer、迁移、bootstrap 与当前 CLI/领域消费者已接通。该状态只覆盖 AH-99/AH-100 的配置工程，不关闭原生 Routine、多 Bot 路由、诊断、issue 或 Host 自动维护的执行票。

合同归 [配置 Spec](../roadmap/configuration-rebuild-spec.md)，操作入口归 [配置指南](../configuration.md)。实现基于 v2 `f8c82c0`，同分支线性提交，不修改并行 v2 工作区或现役 shim。

## Implementation and actual consumers

client Profiles、daemon/desktop、operator、runtime desired 都通过统一 ConfigChange 保存。模型独立，Host 继续 bounded 读取原 canonical models，provider 字段和既有 TURN 捕获语义保持。

模型公开命令已收口为顶级 models list/check/use/reset/persist-key；use/reset 的 --for 与 --default 明确互斥，后者不能 opt-in 其他 Bot。公共帮助、registry、按需技能和 tarball 文件清单同步。配置 schema 可保存 ops 偏好，尚未实现的 ops 执行命令没有伪造空成功入口。

提交有稳定 operation ID 与读回；desktop 的应用收据绑定真实 PID/start 和本域摘要。配置改动不使无关 target/support/runtime 失效。别名修复保留 detached 编辑器字节，prepared 与 ABA 恢复不重放未知写入。迁移和 bootstrap 中途失败有分步事实，不将跨文件行为说成整体原子。

## Executable acceptance

```bash
bun scripts/verify-runtime-rebuild.mjs config-unification
bun test test/models-command-surface.test.ts test/ownership-model-selection.test.ts
bun test test/packaging.test.ts packages/box-runtime/test/context-continuity-artifact.test.ts
node scripts/check-publication.mjs
```

验收器检查固定 Bun、source digest 前后一致，执行 typecheck/build、真实临时文件/锁/死亡进程、源码 CLI、实际打包 Node、desktop 应用和 import fence。`test/config-domain-invalidation.test.ts` 通过真实 Host selection/runtime readers 检查无关修改不影响模型 bytes/capture。`test/config-packed.test.ts` 包含 bootstrap→set→pending ack、迁移→读取、alias 冲突→显式保全恢复，不只调用内部 reducer。

源码固定后更新 E09 制品指纹；其构建 provenance 包含所有 workspace 源码，任何配置源码变化也会改变 preload 摘要。不得放宽旧制品拒绝测试来追绿，亦不把该摘要当作现役已加载。

## Remaining work and release gates

- 独立代码复审仍待；这是非 live 发布门，不藏入 native 待办。
- 生产配置迁移、source-backed CLI 切换、实际旧 writer 退出和当前消费者恢复，进入 [LIVE-CONFIG-CUTOVER](LIVE-integration-validation.md#live-config-cutover)。平台 Reset/home 别名重建与 credential 存续同条分开取证。
- 远端 config 写 capability 未交付，当前明确拒绝而非写错机器。
- T43–T56 的 native Webhook、真实配对、grant、通知 worker、诊断/维护和 issue 发布仍依各来源票；配置规则不是这些功能的实现证明。

AH-99/AH-100 最终关闭评论应准确列出源码/打包证据和未执行的部署范围，不以此票替其他运维票宣布 Done。当前未安装或迁移生产环境，未发送模型/Webhook/issue 请求。
